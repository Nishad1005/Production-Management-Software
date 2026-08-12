-- Kram Phase 3 — the WIP ledger.
--
-- Replaces the daily production Google Sheet the deck asks about ("Production:
-- Daily production update on google sheet"). Until now every number in Kram is
-- something a person asserted: a rate, a yield, a D-minus. This is the first
-- table that records what actually happened, which is what makes the difference
-- between a plan and a plan anyone should believe.
--
-- Two decisions shape it, both taken deliberately with U&M.
--
--   **Entries land on the scheduled job**, not on a department's daily total. A
--   declaration carries its shipment line, so actual-versus-plan is a direct
--   comparison and "where is order SO-1234" is answerable. A department total
--   would be faster to enter and could never answer it — and OTIF, delayed
--   orders and WIP by order are five of the deck's nine dashboard KPIs.
--
--   **Handovers are two-sided.** The producing department declares what it made;
--   the department it feeds records what it received. The count between two
--   departments is exactly the thing people disagree about on a factory floor,
--   and a ledger that cannot hold the disagreement is not a ledger.
--
-- What is deliberately *not* here: WIP value in rupees. It needs a component
-- cost master, which does not exist yet — costing-sheet.xlsx is in docs/source/
-- and has never been loaded. Quantities are real; money would be invented.

-- ---------------------------------------------------------------------------
-- Who hands to whom.
--
-- Not derivable from components. The capacity sheet writes one stage component
-- per article per department (`AARA-LC::STITCH`), so no component is ever
-- worked by two departments and there is no component-level handover to find.
-- What is handed over is the batch, and who receives it comes from the route
-- graph — restricted to the departments *that article* passes through, then
-- reduced to the nearest ones.
--
-- The reduction matters. Without it, Ply Cutting would hand over to every
-- department downstream of it, and a supervisor would be asked to accept work
-- from six departments that never touched their bench.
-- ---------------------------------------------------------------------------
create view public.article_handover
with (security_invoker = true) as
  with recursive down (root, node) as (
    select d.id, d.id from public.departments d where d.is_active
    union
    select r.root, dd.department_id
      from down r
      join public.department_dependencies dd
        on dd.depends_on_department_id = r.node
  ),
  article_dept as (
    select distinct b.article_id, cr.department_id
      from public.article_bom b
      join public.component_rates cr on cr.component_id = b.component_id
      join public.departments d on d.id = cr.department_id and d.is_active
  ),
  pairs as (
    select f.article_id, f.department_id as from_id, t.department_id as to_id
      from article_dept f
      join down on down.root = f.department_id
      join article_dept t
        on t.article_id = f.article_id
       and t.department_id = down.node
     where t.department_id <> f.department_id
  )
  select p.article_id,
         p.from_id as from_department_id,
         p.to_id   as to_department_id
    from pairs p
   -- Transitive reduction: drop the pair if the same article reaches `to` from
   -- `from` by way of some other department it also passes through.
   where not exists (
     select 1
       from pairs a
       join pairs b
         on b.article_id = a.article_id
        and b.from_id = a.to_id
      where a.article_id = p.article_id
        and a.from_id = p.from_id
        and b.to_id = p.to_id
   );

comment on view public.article_handover is
  'For each article, which department hands work to which — the route graph restricted to the departments that article passes through, reduced to nearest neighbours.';

-- ---------------------------------------------------------------------------
-- What a department made.
-- ---------------------------------------------------------------------------
create table public.production_declarations (
  id uuid primary key default gen_random_uuid(),

  -- The scheduled job. Component as well as department: a department can be
  -- making several things for one shipment line on the same day, and they are
  -- separate jobs with separate rates.
  shipment_line_id uuid not null
    references public.shipment_lines (id) on delete cascade,
  department_id uuid not null references public.departments (id),
  component_id uuid not null references public.components (id),

  production_date date not null,
  shift_id uuid not null references public.shifts (id),

  -- Good and rejected are entered separately rather than as a total and a
  -- percentage. A percentage is a derived opinion; these are two counts someone
  -- can stand behind, and measured yield falls out of them.
  qty_good numeric(14, 3) not null default 0 check (qty_good >= 0),
  qty_rejected numeric(14, 3) not null default 0 check (qty_rejected >= 0),

  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  -- One declaration per job per shift per day. A correction updates it rather
  -- than adding a second row, so the day's total is never double-counted by
  -- someone entering it twice.
  unique (shipment_line_id, department_id, component_id, production_date, shift_id)
);

create index on public.production_declarations (department_id, production_date);
create index on public.production_declarations (shipment_line_id);

select public.attach_audit('public.production_declarations');

comment on table public.production_declarations is
  'What a department actually produced against a scheduled job, per shift per day. Good and rejected counted separately.';

-- ---------------------------------------------------------------------------
-- What the next department says it received.
-- ---------------------------------------------------------------------------
create table public.production_acceptances (
  id uuid primary key default gen_random_uuid(),

  declaration_id uuid not null
    references public.production_declarations (id) on delete cascade,

  -- Which department is accepting. Recorded rather than derived: a department
  -- can feed more than one, and the row has to say which of them counted this.
  department_id uuid not null references public.departments (id),

  qty_accepted numeric(14, 3) not null check (qty_accepted >= 0),
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (declaration_id, department_id)
);

create index on public.production_acceptances (department_id);

select public.attach_audit('public.production_acceptances');

comment on table public.production_acceptances is
  'What the receiving department counted. A shortfall against the declaration is kept, not reconciled away — the disagreement is the point.';

-- ---------------------------------------------------------------------------
-- Access.
--
-- Declaring is departmental work: a HOD declares for their own department and
-- nobody else's, which is what auth_department_id() was added for. Planners and
-- admins can enter anywhere, because someone has to be able to fix a Sunday
-- entry made by a supervisor who has since gone home.
-- ---------------------------------------------------------------------------
alter table public.production_declarations enable row level security;
alter table public.production_acceptances enable row level security;

create policy production_declarations_select_with_a_role
  on public.production_declarations
  for select to authenticated
  using (public.auth_has_a_role());

create policy production_declarations_write_own_department
  on public.production_declarations
  for all to authenticated
  using (
    public.auth_can_plan()
    or (public.auth_has_role('hod') and department_id = public.auth_department_id())
  )
  with check (
    public.auth_can_plan()
    or (public.auth_has_role('hod') and department_id = public.auth_department_id())
  );

create policy production_acceptances_select_with_a_role
  on public.production_acceptances
  for select to authenticated
  using (public.auth_has_a_role());

create policy production_acceptances_write_own_department
  on public.production_acceptances
  for all to authenticated
  using (
    public.auth_can_plan()
    or (public.auth_has_role('hod') and department_id = public.auth_department_id())
  )
  with check (
    public.auth_can_plan()
    or (public.auth_has_role('hod') and department_id = public.auth_department_id())
  );
