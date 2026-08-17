-- Kram Phase 5 — material.
--
-- Second row of the client's own scope of work, after order execution and
-- before manpower: "MATERIAL PLANNING · PPC/PURCHASE · MRP · BOM · SALES ORDER
-- AND SP · SUPPLIER". Slide 15 asks for a material real-time status screen and
-- slide 6 puts "Material Shortages" among the MD's nine KPIs. Slide 18, the
-- client's own follow-up list, asks PPC for "Material ordering date to the
-- supplier" and "D minus Articlewise (Raw material, Fabric and Metal)".
--
-- ---------------------------------------------------------------------------
-- The one idea this phase rests on.
--
-- A material requirement is not a new calculation. The engine already works out
-- what each department must make on each day, yield-inflated so the shipped
-- quantity survives every loss downstream — `schedule_tasks.qty_required`.
-- Material rides on that number:
--
--     required = qty_required × qty_per_unit
--
-- which means the compounding comes free and correct. If assembly must make 104
-- chairs for 100 to ship, it needs the wood for 104, and nobody has to remember
-- why. Recomputing it here would be a second implementation of the one piece of
-- arithmetic this project has been most careful about.
--
-- The second idea: **material is consumed by a department, not by an article.**
-- Fabric is needed when cutting starts, ply when ply cutting starts, foam when
-- foam pasting starts. So the bill of materials carries a department, and the
-- date a material is needed is that department's own start date — not the
-- order's, and not the container's.
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  lead_time_days integer not null default 0 check (lead_time_days >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.suppliers');

comment on column public.suppliers.lead_time_days is
  'Calendar days from placing an order to material arriving. Calendar, not working: a supplier does not observe our factory holidays.';

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,

  -- U&M's own costing sheet groups material this way: wood, plywood, metal,
  -- spring, foam, fabric, leather, packing. Text rather than an enum because
  -- the list is theirs and will grow, and a new category should not need a
  -- migration.
  category text,

  uom text not null default 'NOS',

  supplier_id uuid references public.suppliers (id) on delete set null,

  -- Overrides the supplier's figure where one material is slower than the rest
  -- of what that supplier sends.
  lead_time_days integer check (lead_time_days >= 0),

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.materials');

create table public.article_materials (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  material_id uuid not null references public.materials (id) on delete cascade,

  -- Where it is consumed, which is what decides when it is needed.
  department_id uuid not null references public.departments (id) on delete cascade,

  qty_per_unit numeric(14, 4) not null check (qty_per_unit > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (article_id, material_id, department_id)
);
select public.attach_audit('public.article_materials');

comment on table public.article_materials is
  'The bill of materials, per article per material per consuming department. The department is what turns a quantity into a date.';

-- Stock as a stated figure rather than a ledger.
--
-- A receipts-and-issues ledger is the right long-term answer and the wrong
-- thing to build first: it needs every issue to the floor recorded, which is a
-- process U&M do not have yet. This is what the store can actually tell us —
-- what is on hand, as of when — and it is deliberately a fact somebody states
-- rather than a number the software infers.
create table public.material_stock (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null unique references public.materials (id) on delete cascade,

  qty_on_hand numeric(14, 3) not null check (qty_on_hand >= 0),
  counted_on date not null default current_date,
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.material_stock');

comment on table public.material_stock is
  'What the store says is on hand, and when they said it. No row means nobody has said — which is not the same as zero, and the views keep them apart.';

-- ---------------------------------------------------------------------------
-- Row-level security, same door as everything else.
-- ---------------------------------------------------------------------------
alter table public.suppliers enable row level security;
alter table public.materials enable row level security;
alter table public.article_materials enable row level security;
alter table public.material_stock enable row level security;

create policy suppliers_select_with_a_role on public.suppliers
  for select to authenticated using (public.auth_has_a_role());
create policy suppliers_write_with_a_role on public.suppliers
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy materials_select_with_a_role on public.materials
  for select to authenticated using (public.auth_has_a_role());
create policy materials_write_with_a_role on public.materials
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy article_materials_select_with_a_role on public.article_materials
  for select to authenticated using (public.auth_has_a_role());
create policy article_materials_write_with_a_role on public.article_materials
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy material_stock_select_with_a_role on public.material_stock
  for select to authenticated using (public.auth_has_a_role());
create policy material_stock_write_with_a_role on public.material_stock
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

-- ---------------------------------------------------------------------------
-- Writing the masters.
-- ---------------------------------------------------------------------------
create or replace function public.set_supplier(
  p_code text,
  p_name text,
  p_lead_time_days integer default 0
)
returns void
language sql
as $$
  insert into public.suppliers (code, name, lead_time_days)
  values (p_code, p_name, coalesce(p_lead_time_days, 0))
  on conflict (code) do update
    set name = excluded.name,
        lead_time_days = excluded.lead_time_days,
        is_active = true;
$$;

revoke execute on function public.set_supplier(text, text, integer) from public, anon;
grant execute on function public.set_supplier(text, text, integer) to authenticated;

create or replace function public.set_material(
  p_code text,
  p_name text,
  p_category text default null,
  p_uom text default 'NOS',
  p_supplier_code text default null,
  p_lead_time_days integer default null
)
returns void
language plpgsql
as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_name text := nullif(btrim(p_name), '');
begin
  if v_code is null then raise exception 'a material needs a code'; end if;
  if v_name is null then raise exception 'a material needs a name'; end if;

  insert into public.materials
    (code, name, category, uom, supplier_id, lead_time_days)
  values (
    v_code, v_name,
    nullif(btrim(p_category), ''),
    coalesce(nullif(btrim(p_uom), ''), 'NOS'),
    (select id from public.suppliers where code = p_supplier_code),
    p_lead_time_days
  )
  on conflict (code) do update
    set name = excluded.name,
        category = coalesce(excluded.category, public.materials.category),
        uom = excluded.uom,
        supplier_id = coalesce(excluded.supplier_id, public.materials.supplier_id),
        lead_time_days = coalesce(excluded.lead_time_days, public.materials.lead_time_days),
        is_active = true;
end;
$$;

revoke execute on function public.set_material(text, text, text, text, text, integer)
  from public, anon;
grant execute on function public.set_material(text, text, text, text, text, integer)
  to authenticated;

/**
 * One line of a bill of materials. Null quantity removes the line — the same
 * convention as clearing a capacity cell.
 */
create or replace function public.set_article_material(
  p_article_code text,
  p_material_code text,
  p_department_code text,
  p_qty_per_unit numeric default null
)
returns void
language plpgsql
as $$
declare
  v_article uuid;
  v_material uuid;
  v_department uuid;
begin
  select id into v_article from public.articles where code = p_article_code;
  select id into v_material from public.materials where code = p_material_code;
  select id into v_department from public.departments where code = p_department_code;

  if v_article is null then raise exception 'unknown article %', p_article_code; end if;
  if v_material is null then raise exception 'unknown material %', p_material_code; end if;
  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;

  if p_qty_per_unit is null then
    delete from public.article_materials
     where article_id = v_article
       and material_id = v_material
       and department_id = v_department;
    return;
  end if;

  insert into public.article_materials
    (article_id, material_id, department_id, qty_per_unit)
  values (v_article, v_material, v_department, p_qty_per_unit)
  on conflict (article_id, material_id, department_id)
  do update set qty_per_unit = excluded.qty_per_unit;
end;
$$;

revoke execute on function public.set_article_material(text, text, text, numeric)
  from public, anon;
grant execute on function public.set_article_material(text, text, text, numeric)
  to authenticated;

create or replace function public.set_material_stock(
  p_material_code text,
  p_qty_on_hand numeric,
  p_counted_on date default null,
  p_note text default null
)
returns void
language plpgsql
as $$
declare
  v_material uuid;
begin
  select id into v_material from public.materials where code = p_material_code;
  if v_material is null then
    raise exception 'unknown material %', p_material_code;
  end if;

  -- Null clears the figure back to nobody-has-said, which is a different state
  -- from zero and has to remain reachable.
  if p_qty_on_hand is null then
    delete from public.material_stock where material_id = v_material;
    return;
  end if;

  insert into public.material_stock (material_id, qty_on_hand, counted_on, note)
  values (v_material, p_qty_on_hand, coalesce(p_counted_on, current_date), p_note)
  on conflict (material_id) do update
    set qty_on_hand = excluded.qty_on_hand,
        counted_on = excluded.counted_on,
        note = excluded.note;
end;
$$;

revoke execute on function public.set_material_stock(text, numeric, date, text)
  from public, anon;
grant execute on function public.set_material_stock(text, numeric, date, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Output 1 — what is needed, when, and when it must be ordered.
--
-- One row per material per scheduled job. The date a material is needed is the
-- consuming department's start date; the date it must be *ordered* is that
-- minus the lead time, in calendar days — a supplier does not observe our
-- factory holidays.
-- ---------------------------------------------------------------------------
create view public.material_requirements
with (security_invoker = true) as
  -- One row per department per shipment line, not per component task.
  --
  -- A department can be making several components of the same chair — the
  -- parity fixture has wood cutting three — and each is its own scheduled task.
  -- Joining material straight to tasks multiplied every requirement by the
  -- number of components, which is how you order three times the oak you need.
  --
  -- Dividing a task's yield-inflated quantity by its bill-of-materials figure
  -- recovers *how many chairs' worth* that department is making. Where two
  -- components in one department disagree — possible, because they can take
  -- different routes downstream and so inflate differently — the larger is
  -- taken. Buying enough is recoverable; being short is not.
  with dept_qty as (
    select t.run_id,
           t.shipment_line_id,
           t.department_id,
           min(t.start_date) as start_date,
           max(t.qty_required / nullif(b.qty_per_unit, 0)) as article_qty
      from public.schedule_tasks t
      join public.schedule_runs r on r.id = t.run_id and r.is_current
      join public.shipment_lines sl on sl.id = t.shipment_line_id
      join public.orders o on o.id = sl.order_id
      join public.article_bom b
        on b.article_id = o.article_id and b.component_id = t.component_id
     where t.start_date is not null
     group by t.run_id, t.shipment_line_id, t.department_id
  )
  select dq.run_id,
         m.code                    as material_code,
         m.name                    as material_name,
         m.category,
         m.uom,
         sup.code                  as supplier_code,
         sup.name                  as supplier_name,
         a.code                    as article_code,
         o.erp_order_no,
         sl.line_no,
         d.code                    as department_code,
         d.name                    as department_name,
         dq.start_date::text       as needed_on,
         coalesce(m.lead_time_days, sup.lead_time_days, 0) as lead_time_days,
         (dq.start_date - coalesce(m.lead_time_days, sup.lead_time_days, 0))::text
                                   as order_by,
         (dq.article_qty * am.qty_per_unit)::float8 as qty_required,
         am.qty_per_unit::float8   as qty_per_unit,
         -- Ordering today already too late is the finding, not the date.
         (dq.start_date - coalesce(m.lead_time_days, sup.lead_time_days, 0)
            < current_date) as order_now
    from dept_qty dq
    join public.shipment_lines sl on sl.id = dq.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
    join public.departments d on d.id = dq.department_id
    join public.article_materials am
      on am.article_id = a.id and am.department_id = dq.department_id
    join public.materials m on m.id = am.material_id and m.is_active
    left join public.suppliers sup on sup.id = m.supplier_id;

comment on view public.material_requirements is
  'What each scheduled job consumes, when it is needed, and the last day it can be ordered. Quantities ride on the engine''s yield-inflated figure rather than recomputing it.';

grant select on public.material_requirements to authenticated;

-- ---------------------------------------------------------------------------
-- Output 2 — where there is not enough.
--
-- Deliberately three states, not two. Short, covered, and **nobody has said** —
-- because a material whose stock has never been counted is not a material with
-- none, and reporting it as a shortage would bury the real ones under a list of
-- things nobody has got round to counting.
-- ---------------------------------------------------------------------------
create view public.material_shortage
with (security_invoker = true) as
  with needed as (
    select material_code,
           sum(qty_required) as qty_required,
           min(needed_on) as first_needed_on,
           min(order_by) as first_order_by,
           count(*) as jobs
      from public.material_requirements
     group by material_code
  )
  select m.code                as material_code,
         m.name                as material_name,
         m.category,
         m.uom,
         sup.code              as supplier_code,
         coalesce(m.lead_time_days, sup.lead_time_days, 0) as lead_time_days,
         n.qty_required::float8,
         st.qty_on_hand::float8,
         st.counted_on::text,
         (st.material_id is not null) as stock_known,
         case when st.material_id is not null
              then greatest(n.qty_required - st.qty_on_hand, 0)::float8
         end as shortfall,
         case when st.material_id is null then 'not counted'
              when st.qty_on_hand >= n.qty_required then 'covered'
              else 'short'
         end as status,
         n.first_needed_on,
         n.first_order_by,
         (n.first_order_by < current_date::text) as order_now,
         n.jobs::integer
    from needed n
    join public.materials m on m.code = n.material_code
    left join public.material_stock st on st.material_id = m.id
    left join public.suppliers sup on sup.id = m.supplier_id;

comment on view public.material_shortage is
  'Per material across the current plan: needed, on hand, and short — with "nobody has counted it" kept separate from "there is none".';

grant select on public.material_shortage to authenticated;

-- The masters list, for the screen and for the file.
create view public.material_master
with (security_invoker = true) as
  select m.code,
         m.name,
         m.category,
         m.uom,
         sup.code as supplier_code,
         sup.name as supplier_name,
         coalesce(m.lead_time_days, sup.lead_time_days, 0) as lead_time_days,
         st.qty_on_hand::float8,
         st.counted_on::text,
         m.is_active,
         (select count(*) from public.article_materials am
           where am.material_id = m.id)::integer as used_by
    from public.materials m
    left join public.suppliers sup on sup.id = m.supplier_id
    left join public.material_stock st on st.material_id = m.id;

grant select on public.material_master to authenticated;

create view public.article_material_list
with (security_invoker = true) as
  select a.code as article_code,
         m.code as material_code,
         m.name as material_name,
         d.code as department_code,
         am.qty_per_unit::float8,
         m.uom
    from public.article_materials am
    join public.articles a on a.id = am.article_id
    join public.materials m on m.id = am.material_id
    join public.departments d on d.id = am.department_id;

grant select on public.article_material_list to authenticated;
