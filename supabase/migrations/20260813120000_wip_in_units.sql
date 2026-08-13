-- Kram — WIP measured in units, because that needs no cost data.
--
-- U&M: "What if we don't use cost as of now, since the main thing we want to do
-- is WIP." Nothing built so far touches money — there is no cost, price or value
-- column anywhere in the schema — so the answer is that it costs one card, and
-- this migration makes sure it costs less than that.
--
-- Two changes to md_dashboard:
--
--   `wip_units` is added, and computes today. Units on shipment lines that have
--   started somewhere and finished nowhere: "three containers, 550 chairs, part
--   made." Explicable to anyone standing on the floor, and derived entirely from
--   the ledger.
--
--   `wip_value` stays, and stays unavailable. Deleting it would quietly drop a
--   KPI the client asked for and leave nobody any the wiser. Left in, it names
--   the one outstanding ask every time the MD opens the screen — and its message
--   now points at exactly what is needed, which reading their costing sheet
--   properly has settled.

insert into public.kpi_targets (key, label, target, unit, higher_is_better, sort_order)
values ('wip_units', 'WIP in progress', 0, 'units', true, 35)
on conflict (key) do nothing;

-- A line's own quantity, not the yield-inflated component totals. A hundred
-- chairs part-made is a hundred chairs, however many legs that took.
create or replace view public.md_dashboard
with (security_invoker = true) as
  with current_run as (
    select id from public.schedule_runs where is_current limit 1
  ),
  done as (
    select department_id, shipment_line_id, component_id,
           sum(qty_good) as qty_good,
           max(production_date) as finished
      from public.production_declarations
     group by department_id, shipment_line_id, component_id
  ),
  lines as (
    select sl.id,
           sl.qty,
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
           (select bool_and(coalesce(d.qty_good, 0) >= t.qty_required)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as complete,
           -- Started anywhere. Together with `complete` this is what work in
           -- progress means: begun, not finished.
           (select bool_or(coalesce(d.qty_good, 0) > 0)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as started,
           (select bool_and(
                     coalesce(d.qty_good, 0) >= t.qty_required
                     and d.finished <= t.due_date)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as on_time_in_full
      from public.shipment_lines sl
  ),
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
    select 'wip_units',
           (select coalesce(sum(qty), 0) from lines
             where started and not complete)::numeric,
           true, null
    union all
    select 'wip_value', null, false,
           'Needs one row per article with the cost categories from page 33 of the costing sheet — wood, plywood, foam, fabric, packing, labour. The quantities are already here.'
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
  'Slide 6''s KPIs, plus WIP in units. Nine compute from the plan and the ledger; WIP value alone reports itself unavailable and names what it needs.';

grant select on public.md_dashboard to authenticated;

-- ---------------------------------------------------------------------------
-- Where every order actually is.
--
-- wip_by_order has existed since Phase 3 and nothing has ever rendered it — the
-- one thing U&M say they most want has been computed, tested and invisible.
-- This adds the per-line summary the screen needs so it does not have to fold
-- fourteen department rows together in the browser.
-- ---------------------------------------------------------------------------
create view public.wip_lines
with (security_invoker = true) as
  select w.erp_order_no,
         w.customer_code,
         w.article_code,
         w.shipment_line_id,
         w.line_no,
         w.line_qty,
         w.stuffing_date,
         (w.stuffing_date::date - current_date)::integer as days_to_stuffing,
         count(*)::integer                                    as departments,
         count(*) filter (where w.state = 'complete')::integer as departments_done,
         count(*) filter (where w.state = 'in progress')::integer as departments_running,
         max(w.last_declared)                                 as last_declared,
         -- Progress across the route, each department weighted equally. Not
         -- weighted by quantity: a department making four legs a chair would
         -- otherwise dominate one making a single cover, and neither is more
         -- finished than the other.
         round(avg(coalesce(w.fraction_done, 0))::numeric, 4)::float8 as fraction_done,
         bool_or(w.qty_good > 0)                              as started,
         bool_and(w.state = 'complete')                       as complete
    -- No breach count here on purpose: wip_by_order does not carry one, and
    -- reaching into schedule_tasks for it would make this view depend on the
    -- run as well as the ledger. Urgency on this screen is the container date.
    from public.wip_by_order w
   group by w.erp_order_no, w.customer_code, w.article_code,
            w.shipment_line_id, w.line_no, w.line_qty, w.stuffing_date;

comment on view public.wip_lines is
  'One row per shipment line: how far through its route the work has actually got, from the WIP ledger.';

grant select on public.wip_lines to authenticated;
