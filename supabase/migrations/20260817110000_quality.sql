-- Kram Phase 6 — quality.
--
-- Deck slide 17 asks for a quality real-time status screen; slide 6 puts
-- "Rejections" among the MD's nine KPIs with a 2% target.
--
-- ---------------------------------------------------------------------------
-- What already exists, and the one thing missing.
--
-- Since Phase 3 every production declaration has carried `qty_good` and
-- `qty_rejected` as two counts somebody can stand behind, and `measured_yield`
-- puts the counted figure beside the one typed on Masters. So the *quantity* of
-- the problem has been recorded for weeks.
--
-- What the ledger cannot say is **why**. Four rejected at stitching is a
-- number; four rejected because the fabric ran short of pattern is a purchase
-- conversation, and four rejected because a needle was blunt is a maintenance
-- one. Without the reason, every quality figure in the system is a stick to
-- beat a department with rather than something anybody can act on.
--
-- So this phase adds exactly one thing — the reason — and then reports on it.
-- No quantity is re-counted anywhere: every view here reads the declarations
-- that already exist.
-- ---------------------------------------------------------------------------

create table public.defect_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,

  -- Who can actually fix it. The point of grouping defects at all is that
  -- workmanship goes to the department, material goes to purchase, and design
  -- goes to whoever drew it — three different conversations.
  category text not null default 'workmanship'
    check (category in ('workmanship', 'material', 'machine', 'design', 'handling')),

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.defect_types');

-- Attribution, deliberately partial.
--
-- A supervisor entering the day's output should not be blocked from recording
-- four rejects because they can only account for three. The unattributed
-- balance is carried and reported as its own line — the same choice as the
-- handover shortfall in Phase 3, and for the same reason: the gap is the
-- interesting part, and a system that refuses to hold it gets a made-up reason
-- typed in to make the form submit.
create table public.production_defects (
  id uuid primary key default gen_random_uuid(),
  declaration_id uuid not null
    references public.production_declarations (id) on delete cascade,
  defect_type_id uuid not null references public.defect_types (id),

  qty numeric(14, 3) not null check (qty > 0),
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (declaration_id, defect_type_id)
);
select public.attach_audit('public.production_defects');

create index production_defects_declaration_idx
  on public.production_defects (declaration_id);

comment on table public.production_defects is
  'Why the rejected pieces were rejected. Attribution may be partial — the unaccounted balance is reported rather than refused.';

alter table public.defect_types enable row level security;
alter table public.production_defects enable row level security;

create policy defect_types_select_with_a_role on public.defect_types
  for select to authenticated using (public.auth_has_a_role());
create policy defect_types_write_with_a_role on public.defect_types
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy production_defects_select_with_a_role on public.production_defects
  for select to authenticated using (public.auth_has_a_role());
create policy production_defects_write_with_a_role on public.production_defects
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

-- ---------------------------------------------------------------------------
-- Writing.
-- ---------------------------------------------------------------------------
create or replace function public.set_defect_type(
  p_code text,
  p_name text,
  p_category text default 'workmanship'
)
returns void
language sql
as $$
  insert into public.defect_types (code, name, category)
  values (p_code, p_name, coalesce(p_category, 'workmanship'))
  on conflict (code) do update
    set name = excluded.name,
        category = excluded.category,
        is_active = true;
$$;

revoke execute on function public.set_defect_type(text, text, text) from public, anon;
grant execute on function public.set_defect_type(text, text, text) to authenticated;

/**
 * Attributes part of a day's rejections to a cause.
 *
 * Keyed the way the production screen already knows the job — line, department,
 * component, date, shift — rather than by a declaration id the client never
 * sees. Null quantity removes the attribution.
 */
create or replace function public.attribute_defect(
  p_shipment_line_id uuid,
  p_department_code text,
  p_component_code text,
  p_date date,
  p_shift_code text,
  p_defect_code text,
  p_qty numeric default null,
  p_note text default null
)
returns void
language plpgsql
as $$
declare
  v_declaration uuid;
  v_defect uuid;
  v_rejected numeric;
  v_other numeric;
begin
  select decl.id, decl.qty_rejected into v_declaration, v_rejected
    from public.production_declarations decl
    join public.departments d on d.id = decl.department_id
    join public.components c on c.id = decl.component_id
    join public.shifts s on s.id = decl.shift_id
   where decl.shipment_line_id = p_shipment_line_id
     and d.code = p_department_code
     and c.code = p_component_code
     and decl.production_date = p_date
     and s.code = p_shift_code;

  if v_declaration is null then
    raise exception 'nothing was declared for % on % at %',
      p_component_code, p_date, p_department_code;
  end if;

  select id into v_defect from public.defect_types where code = p_defect_code;
  if v_defect is null then
    raise exception 'unknown defect type %', p_defect_code;
  end if;

  if p_qty is null then
    delete from public.production_defects
     where declaration_id = v_declaration and defect_type_id = v_defect;
    return;
  end if;

  -- More reasons than rejects is not a judgement call, it is arithmetic that
  -- cannot be true. Refused with both figures named, because "constraint
  -- violated" tells a supervisor nothing.
  select coalesce(sum(qty), 0) into v_other
    from public.production_defects
   where declaration_id = v_declaration and defect_type_id <> v_defect;

  if v_other + p_qty > v_rejected then
    -- trim_scale so the message reads as a person would say it: numeric(14,3)
    -- renders as "12.000 of only 10.000", which is accurate and reads like a
    -- machine complaining.
    raise exception 'that would account for % of only % rejected',
      trim_scale(v_other + p_qty), trim_scale(v_rejected);
  end if;

  insert into public.production_defects (declaration_id, defect_type_id, qty, note)
  values (v_declaration, v_defect, p_qty, p_note)
  on conflict (declaration_id, defect_type_id)
  do update set qty = excluded.qty, note = excluded.note;
end;
$$;

revoke execute on function public.attribute_defect(
  uuid, text, text, date, text, text, numeric, text) from public, anon;
grant execute on function public.attribute_defect(
  uuid, text, text, date, text, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Output 1 — the Pareto. Which causes account for most of the loss.
--
-- Ranked by quantity with a running share, because the useful question is never
-- "what defects do we have" but "which two would fix half of it".
-- ---------------------------------------------------------------------------
create view public.defect_pareto
with (security_invoker = true) as
  with attributed as (
    select dt.code, dt.name, dt.category, sum(pd.qty) as qty
      from public.production_defects pd
      join public.defect_types dt on dt.id = pd.defect_type_id
     group by dt.code, dt.name, dt.category
  ),
  -- The balance nobody has explained, carried as a line of its own rather than
  -- quietly left out of the denominator.
  unexplained as (
    select 'UNATTRIBUTED' as code,
           'Not attributed to a cause' as name,
           'workmanship' as category,
           greatest(
             (select coalesce(sum(qty_rejected), 0) from public.production_declarations)
             - (select coalesce(sum(qty), 0) from public.production_defects),
             0
           ) as qty
  ),
  everything as (
    select * from attributed
     union all
    select * from unexplained where qty > 0
  )
  select e.code,
         e.name,
         e.category,
         e.qty::float8,
         round(100.0 * e.qty / nullif(sum(e.qty) over (), 0), 1)::float8 as share_pct,
         round(
           100.0 * sum(e.qty) over (order by e.qty desc, e.code
                                    rows between unbounded preceding and current row)
           / nullif(sum(e.qty) over (), 0), 1
         )::float8 as running_pct
    from everything e;

comment on view public.defect_pareto is
  'Causes ranked by quantity with a running share. The unattributed balance is a line, not an omission.';

grant select on public.defect_pareto to authenticated;

-- ---------------------------------------------------------------------------
-- Output 2 — quality per department, against what the master claims.
--
-- measured_yield already puts counted yield beside planned. This adds the
-- rejection rate, the attribution coverage, and the biggest single cause — the
-- three things that decide whether a department's number is a problem or a
-- reporting gap.
-- ---------------------------------------------------------------------------
create view public.quality_by_department
with (security_invoker = true) as
  with counted as (
    select decl.department_id,
           sum(decl.qty_good) as qty_good,
           sum(decl.qty_rejected) as qty_rejected,
           count(*) as declarations
      from public.production_declarations decl
     group by decl.department_id
  ),
  attributed as (
    select decl.department_id, sum(pd.qty) as qty
      from public.production_defects pd
      join public.production_declarations decl on decl.id = pd.declaration_id
     group by decl.department_id
  ),
  worst as (
    select distinct on (decl.department_id)
           decl.department_id, dt.name, sum(pd.qty) as qty
      from public.production_defects pd
      join public.production_declarations decl on decl.id = pd.declaration_id
      join public.defect_types dt on dt.id = pd.defect_type_id
     group by decl.department_id, dt.name
     order by decl.department_id, sum(pd.qty) desc, dt.name
  )
  select d.code                as department_code,
         d.name                as department_name,
         d.route_position,
         d.yield_pct::float8   as planned_yield_pct,
         c.qty_good::float8,
         c.qty_rejected::float8,
         case when c.qty_good + c.qty_rejected > 0
              then round(100.0 * c.qty_rejected / (c.qty_good + c.qty_rejected), 2)::float8
         end as rejection_pct,
         case when c.qty_good + c.qty_rejected > 0
              then round(100.0 * c.qty_good / (c.qty_good + c.qty_rejected), 2)::float8
         end as measured_yield_pct,
         -- Positive means the department is doing better than the master says.
         case when c.qty_good + c.qty_rejected > 0
              then round(
                100.0 * c.qty_good / (c.qty_good + c.qty_rejected) - d.yield_pct, 2
              )::float8
         end as against_plan_pct,
         coalesce(a.qty, 0)::float8 as qty_attributed,
         case when c.qty_rejected > 0
              then round(100.0 * coalesce(a.qty, 0) / c.qty_rejected, 0)::float8
         end as attributed_pct,
         w.name as biggest_cause,
         c.declarations::integer
    from counted c
    join public.departments d on d.id = c.department_id
    left join attributed a on a.department_id = c.department_id
    left join worst w on w.department_id = c.department_id;

comment on view public.quality_by_department is
  'Rejection rate and measured yield per department, beside the yield its master claims, with how much of it anybody has explained.';

grant select on public.quality_by_department to authenticated;

-- ---------------------------------------------------------------------------
-- Output 3 — what went wrong on which article.
--
-- A department with a bad month and one article with a bad design are the same
-- number seen from two sides, and only one of them is fixed by talking to the
-- department.
-- ---------------------------------------------------------------------------
create view public.quality_by_article
with (security_invoker = true) as
  select a.code               as article_code,
         a.name               as article_name,
         sum(decl.qty_good)::float8     as qty_good,
         sum(decl.qty_rejected)::float8 as qty_rejected,
         case when sum(decl.qty_good + decl.qty_rejected) > 0
              then round(100.0 * sum(decl.qty_rejected)
                   / sum(decl.qty_good + decl.qty_rejected), 2)::float8
         end as rejection_pct,
         count(distinct decl.department_id)::integer as departments
    from public.production_declarations decl
    join public.shipment_lines sl on sl.id = decl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
   group by a.code, a.name;

grant select on public.quality_by_article to authenticated;

-- The defect list, and every attribution as rows — the latter for the same
-- reason the ledger got one: it is typed by a person and cannot be recomputed.
create view public.defect_type_list
with (security_invoker = true) as
  select code, name, category, is_active from public.defect_types;

grant select on public.defect_type_list to authenticated;

create view public.defect_list
with (security_invoker = true) as
  select o.erp_order_no,
         sl.line_no,
         d.code                     as department_code,
         c.code                     as component_code,
         decl.production_date::text as production_date,
         dt.code                    as defect_code,
         dt.name                    as defect_name,
         dt.category,
         pd.qty::float8,
         pd.note,
         pd.created_at::text        as created_at
    from public.production_defects pd
    join public.defect_types dt on dt.id = pd.defect_type_id
    join public.production_declarations decl on decl.id = pd.declaration_id
    join public.shipment_lines sl on sl.id = decl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.departments d on d.id = decl.department_id
    join public.components c on c.id = decl.component_id;

grant select on public.defect_list to authenticated;
