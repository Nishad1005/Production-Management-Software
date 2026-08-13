-- Kram — the MD's dashboard, slide 6.
--
--   KPI                  Target        Actual        Status
--   Orders Running       4             4             green
--   OTIF                 95%           90%           red
--   Daily Production     80 Units      75 Units      amber
--   WIP Value            Rs.24,50,000  Rs.21,50,000  amber
--   Production Efficiency 100%         93.75%        amber
--   Rejections           2%            1%            green
--   Material Shortages   2%            0%            green
--   Delayed Orders       1%            0%            green
--   Containers Ready     30            30            green
--
-- Held back until now on purpose: six of those nine need actuals from the
-- floor, and until Phase 3 there were none. Shipping it earlier would have put
-- six invented figures beside three real ones, which is worse than not shipping
-- it — a dashboard is believed.
--
-- Eight are computable now. **WIP Value is not**, and is reported as
-- unavailable with the reason rather than estimated. There is no component cost
-- master; costing-sheet.xlsx is a calculator for one product, not a per-article
-- cost table. A rupee figure derived from nothing would be the most quoted
-- number on the screen and the only fabricated one.
--
-- OTIF is measured, not projected, and the distinction is stated on the row: a
-- shipment line is on time and in full when every department it passes through
-- has declared at least what it owed, by the day it owed it. Kram has no
-- dispatch record — nothing tells it a container actually sailed — so this is
-- the floor's own account of whether the work was ready, which is the honest
-- limit of what the data supports.

create table public.kpi_targets (
  key text primary key,
  label text not null,
  target numeric not null,
  unit text not null default '%',
  -- Rejections at 1% beats a 2% target; OTIF at 90% misses a 95% one. Without
  -- this every low number reads as failure.
  higher_is_better boolean not null default true,
  sort_order integer not null,
  updated_at timestamptz not null default now()
);

select public.attach_audit('public.kpi_targets');

alter table public.kpi_targets enable row level security;

create policy kpi_targets_select_with_a_role on public.kpi_targets
  for select to authenticated using (public.auth_has_a_role());

create policy kpi_targets_write_planner on public.kpi_targets
  for all to authenticated
  using (public.auth_can_plan()) with check (public.auth_can_plan());

-- The deck's own figures, so the first thing the MD sees is the table they
-- drew. Editable, because they are targets rather than facts.
insert into public.kpi_targets (key, label, target, unit, higher_is_better, sort_order)
values
  ('orders_running',    'Orders running',       4,  'orders', true,  10),
  ('otif',              'OTIF',                95,  '%',      true,  20),
  ('daily_production',  'Daily production',    80,  'units',  true,  30),
  ('wip_value',         'WIP value',            0,  '₹',      true,  40),
  ('efficiency',        'Production efficiency', 100, '%',    true,  50),
  ('rejections',        'Rejections',           2,  '%',      false, 60),
  ('material_shortage', 'Material shortages',   2,  '%',      false, 70),
  ('delayed_orders',    'Delayed orders',       1,  '%',      false, 80),
  ('containers_ready',  'Containers ready',     0,  'lines',  true,  90)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Is the factory on track today?
--
-- Every figure carries `available`. A KPI that cannot be computed says so and
-- says why, instead of showing a zero — a zero is a number, and on a dashboard
-- it will be read as one.
-- ---------------------------------------------------------------------------
create view public.md_dashboard
with (security_invoker = true) as
  with current_run as (
    select id from public.schedule_runs where is_current limit 1
  ),
  lines as (
    select sl.id,
           sl.stuffing_date,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as tasks,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id
               and t.breach_reason is not null) as breached,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id
               and t.breach_reason = 'material') as material_breached,
           -- Ready to stuff: every department has declared at least what it owed.
           (select bool_and(coalesce(done.qty_good, 0) >= t.qty_required)
              from public.schedule_tasks t
              left join (
                select department_id, shipment_line_id, component_id,
                       sum(qty_good) as qty_good
                  from public.production_declarations
                 group by department_id, shipment_line_id, component_id
              ) done
                on done.department_id = t.department_id
               and done.shipment_line_id = t.shipment_line_id
               and done.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as complete,
           -- On time and in full: everything owed, delivered by the day it was
           -- owed. A late completion is complete but not OTIF.
           (select bool_and(
                     coalesce(done.qty_good, 0) >= t.qty_required
                     and done.finished <= t.due_date)
              from public.schedule_tasks t
              left join (
                select department_id, shipment_line_id, component_id,
                       sum(qty_good) as qty_good,
                       max(production_date) as finished
                  from public.production_declarations
                 group by department_id, shipment_line_id, component_id
              ) done
                on done.department_id = t.department_id
               and done.shipment_line_id = t.shipment_line_id
               and done.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as on_time_in_full
      from public.shipment_lines sl
  ),
  -- A rolling month, so one quiet day does not read as collapse.
  recent as (
    select coalesce(sum(qty_good), 0) as good,
           coalesce(sum(qty_rejected), 0) as rejected
      from public.production_declarations
     where production_date >= current_date - 30
  ),
  today as (
    select coalesce(sum(qty_good), 0) as good
      from public.production_declarations
     where production_date = current_date
  ),
  planned_recent as (
    select coalesce(sum(dl.qty_planned), 0) as planned
      from public.schedule_daily_load dl
     where dl.run_id = (select id from current_run)
       and dl.load_date between current_date - 30 and current_date
  ),
  computed as (
    select 'orders_running' as key,
           (select count(*) from public.orders
             where status in ('open', 'in_production'))::numeric as actual,
           true as available, null::text as unavailable_because
    union all
    select 'otif',
           case when (select count(*) from lines where complete) > 0
                then round(100.0 * (select count(*) from lines where on_time_in_full)
                                 / (select count(*) from lines where complete), 1)
           end,
           (select count(*) from lines where complete) > 0,
           'No shipment line has been completed yet, so there is nothing to be on time about.'
    union all
    select 'daily_production', (select good from today), true, null
    union all
    select 'wip_value', null, false,
           'Needs a cost per component. costing-sheet.xlsx is a calculator for one product, not a per-article cost table.'
    union all
    select 'efficiency',
           case when (select planned from planned_recent) > 0
                then round(100.0 * (select good from recent)
                                 / (select planned from planned_recent), 1)
           end,
           (select planned from planned_recent) > 0,
           'Nothing has been planned in the last 30 days to measure against.'
    union all
    select 'rejections',
           case when (select good + rejected from recent) > 0
                then round(100.0 * (select rejected from recent)
                                 / (select good + rejected from recent), 2)
           end,
           (select good + rejected from recent) > 0,
           'Nothing has been declared in the last 30 days.'
    union all
    select 'material_shortage',
           case when (select count(*) from lines where tasks > 0) > 0
                then round(100.0 * (select count(*) from lines where material_breached > 0)
                                 / (select count(*) from lines where tasks > 0), 1)
           end,
           (select count(*) from lines where tasks > 0) > 0,
           'Nothing is scheduled.'
    union all
    select 'delayed_orders',
           case when (select count(*) from lines where tasks > 0) > 0
                then round(100.0 * (select count(*) from lines where breached > 0)
                                 / (select count(*) from lines where tasks > 0), 1)
           end,
           (select count(*) from lines where tasks > 0) > 0,
           'Nothing is scheduled.'
    union all
    select 'containers_ready',
           (select count(*) from lines where complete)::numeric, true, null
  )
  select t.key,
         t.label,
         t.target::float8,
         t.unit,
         t.higher_is_better,
         t.sort_order,
         c.actual::float8,
         (c.available and c.actual is not null) as available,
         case when c.available and c.actual is not null
              then null else c.unavailable_because end as unavailable_because,
         case
           when not (c.available and c.actual is not null) then 'unavailable'
           -- A target of zero is "no target set", not "must be zero". Reporting
           -- red against a target nobody chose would train people to ignore it.
           when t.target = 0 then 'none'
           when t.higher_is_better and c.actual >= t.target then 'good'
           when t.higher_is_better and c.actual >= t.target * 0.9 then 'warn'
           when t.higher_is_better then 'bad'
           when c.actual <= t.target then 'good'
           when c.actual <= t.target * 1.5 then 'warn'
           else 'bad'
         end as status
    from public.kpi_targets t
    join computed c on c.key = t.key;

comment on view public.md_dashboard is
  'Slide 6''s nine KPIs. Eight computed from the plan and the WIP ledger; WIP value reports itself unavailable rather than estimating a rupee figure from nothing.';

grant select on public.md_dashboard to authenticated;

create or replace function public.set_kpi_target(p_key text, p_target numeric)
returns void
language sql
as $$
  update public.kpi_targets set target = p_target where key = p_key;
$$;

revoke execute on function public.set_kpi_target(text, numeric) from public, anon;
grant execute on function public.set_kpi_target(text, numeric) to authenticated;
