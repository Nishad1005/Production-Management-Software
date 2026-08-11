-- Kram — the four planning outputs, plus the Gantt feed and the order
-- acceptance check (spec §14).
--
-- ---------------------------------------------------------------------------
-- A modelling point that everything here rests on, worth stating plainly.
--
-- component_rates.units_per_day is "what this department makes in a day at
-- sanctioned headcount *if it does nothing else*". So a department making 80
-- legs against a 160/day rate has spent half a day, and one making 80 legs and
-- 20 seat frames against rates of 160 and 40 has spent all of it.
--
-- Load therefore cannot be added up in units across components — legs and
-- covers are not the same thing — but *utilisation* can, because each component's
-- ratio is a fraction of the same day. Every view below aggregates the ratio,
-- never the raw quantity. Utilisation above 1.0 is the flag.
-- ---------------------------------------------------------------------------

-- Per component: what was planned, what was available, and the fraction of the
-- department's day it consumes. Driven from capacity rather than load, so days
-- with capacity and no work still appear — that is what makes idle reporting
-- possible at all.
create view public.schedule_component_load
with (security_invoker = true) as
  select cap.run_id,
         cap.department_id,
         cap.component_id,
         cap.load_date,
         cap.capacity,
         coalesce(l.qty_planned, 0) as qty_planned,
         coalesce(l.qty_planned, 0) / nullif(cap.capacity, 0) as utilisation
    from (
      select run_id, department_id, component_id, load_date, sum(capacity) as capacity
        from public.schedule_daily_capacity
       group by run_id, department_id, component_id, load_date
    ) cap
    left join (
      select run_id, department_id, component_id, load_date, sum(qty_planned) as qty_planned
        from public.schedule_daily_load
       group by run_id, department_id, component_id, load_date
    ) l
      on l.run_id = cap.run_id
     and l.department_id = cap.department_id
     and l.component_id = cap.component_id
     and l.load_date = cap.load_date;

-- ---------------------------------------------------------------------------
-- Output 1 — the load heatmap. Department × date, the daily symptom view.
-- ---------------------------------------------------------------------------
create view public.schedule_department_day
with (security_invoker = true) as
  select run_id,
         department_id,
         load_date,
         sum(utilisation) as utilisation,
         count(*) filter (where qty_planned > 0) as components_loaded,
         case
           when sum(utilisation) > 1.0001 then 'over'
           when sum(utilisation) > 0 then 'loaded'
           else 'idle'
         end as status
    from public.schedule_component_load
   group by run_id, department_id, load_date;

comment on view public.schedule_department_day is
  'Load heatmap feed. utilisation is the summed fraction of the day consumed across components; >1 is over capacity.';

-- ---------------------------------------------------------------------------
-- Output 2 — bottleneck utilisation.
--
-- Spec §14: "The heatmap shows which days hurt; this shows which department is
-- structurally the constraint. Capacity above the bottleneck is decorative — if
-- stitching runs at 30 a day against wood's 40, the factory's real throughput
-- is 30."
-- ---------------------------------------------------------------------------
create view public.schedule_bottleneck
with (security_invoker = true) as
  select dd.run_id,
         dd.department_id,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         round(avg(dd.utilisation), 4)::float8 as avg_utilisation,
         round(max(dd.utilisation), 4)::float8 as peak_utilisation,
         count(*)::integer as days_in_horizon,
         count(*) filter (where dd.status = 'over')::integer as flagged_days,
         count(*) filter (where dd.status = 'idle')::integer as idle_days,
         rank() over (
           partition by dd.run_id order by avg(dd.utilisation) desc
         )::integer as bottleneck_rank
    from public.schedule_department_day dd
    join public.departments d on d.id = dd.department_id
   group by dd.run_id, dd.department_id, d.code, d.name, d.route_position;

-- ---------------------------------------------------------------------------
-- Output 3 — flag triage.
--
-- Spec §14: "A sort and a label, no recommendation attached. It converts a flat
-- list of two hundred flags into a triaged one, which is the difference between
-- a report people act on and one they scroll past."
-- ---------------------------------------------------------------------------
create view public.schedule_flag_triage
with (security_invoker = true) as
  select dd.run_id,
         dd.department_id,
         d.code as department_code,
         dd.load_date::text as load_date,
         dd.utilisation::float8 as utilisation,
         round(dd.utilisation - 1, 4)::float8 as over_by,
         (dd.load_date - current_date)::integer as days_out,
         case
           when dd.load_date - current_date >= 45 then 'hiring'
           when dd.load_date - current_date >= 15 then 'overtime_resequence_subcontract'
           else 'customer_conversation'
         end as still_possible
    from public.schedule_department_day dd
    join public.departments d on d.id = dd.department_id
   where dd.status = 'over';

comment on view public.schedule_flag_triage is
  'Flagged days labelled by what is still possible at that lead time (spec §14). A label, not a recommendation.';

-- ---------------------------------------------------------------------------
-- Output 4 — idle capacity.
--
-- Spec §14: "Backward scheduling places work as late as possible, so empty days
-- frequently sit immediately before a breach. Reporting idle days alongside
-- flagged days is half the value of the exercise — and the trend matters more
-- than the number, because a floor with no idle days has no absorption left for
-- the next rush order."
-- ---------------------------------------------------------------------------
create view public.schedule_idle_capacity
with (security_invoker = true) as
  select dd.run_id,
         dd.department_id,
         d.code as department_code,
         dd.load_date::text as load_date,
         dd.utilisation::float8 as utilisation,
         round(greatest(0, 1 - dd.utilisation), 4)::float8 as idle_fraction
    from public.schedule_department_day dd
    join public.departments d on d.id = dd.department_id
   where dd.utilisation < 1;

-- ---------------------------------------------------------------------------
-- Gantt feed. Filtered by department, customer or date window in the client —
-- spec §14 is explicit that 324 live orders will not render whole.
-- ---------------------------------------------------------------------------
create view public.schedule_gantt
with (security_invoker = true) as
  select t.run_id,
         t.id as task_id,
         o.erp_order_no,
         o.confidence::text as confidence,
         cu.code as customer_code,
         cu.name as customer_name,
         a.code as article_code,
         sl.id as shipment_line_id,
         sl.line_no,
         sl.qty::float8 as line_qty,
         sl.stuffing_date::text as stuffing_date,
         sl.container_ref,
         d.id as department_id,
         d.code as department_code,
         d.route_position,
         cmp.code as component_code,
         t.due_date::text as due_date,
         t.start_date::text as start_date,
         t.end_date::text as end_date,
         t.days_needed,
         t.qty_required::float8 as qty_required,
         t.is_feasible,
         t.breach_reason,
         t.is_pinned
    from public.schedule_tasks t
    join public.shipment_lines sl on sl.id = t.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id
    join public.departments d on d.id = t.department_id
    join public.components cmp on cmp.id = t.component_id;

-- ---------------------------------------------------------------------------
-- Order acceptance check.
--
-- Spec §14: "Everything else finds problems after the commitment; this finds
-- them before, which makes it the highest-value screen in the product."
--
-- Schedules a hypothetical line against the live order book, reports what
-- breaks, and removes every trace of itself. The provisional order is deleted
-- rather than rolled back because a function cannot roll back its own caller —
-- and leaving phantom orders in the book would be worse than the feature.
-- ---------------------------------------------------------------------------
create or replace function public.check_order_acceptance(
  p_article_id uuid,
  p_qty numeric,
  p_stuffing_date date,
  p_material_ready_date date default null,
  p_confidence public.order_confidence[]
    default array['confirmed', 'probable']::public.order_confidence[]
)
returns table (
  department_code text,
  component_code text,
  due_date text,
  start_date text,
  end_date text,
  qty_required double precision,
  is_feasible boolean,
  breach_reason public.breach_reason
)
language plpgsql
as $$
declare
  v_customer_id uuid;
  v_order_id uuid;
  v_line_id uuid;
  v_run_id uuid;
begin
  -- Inactive so it never appears in a customer picker.
  insert into public.customers (code, name, is_active)
  values ('__ACCEPTANCE_CHECK__', 'Order acceptance check', false)
  on conflict (code) do nothing;

  select id into v_customer_id
    from public.customers where code = '__ACCEPTANCE_CHECK__';

  insert into public.orders (erp_order_no, customer_id, article_id, total_qty, confidence)
  values ('__ACCEPTANCE_CHECK__/' || gen_random_uuid()::text,
          v_customer_id, p_article_id, p_qty, 'confirmed')
  returning id into v_order_id;

  insert into public.shipment_lines
    (order_id, line_no, qty, stuffing_date, material_ready_date)
  values (v_order_id, 1, p_qty, p_stuffing_date, p_material_ready_date)
  returning id into v_line_id;

  v_run_id := public.run_schedule(p_confidence, false, 'Order acceptance check');

  -- Materialise before the run is deleted out from under the result set.
  create temp table _acceptance on commit drop as
  select d.code as department_code,
         cmp.code as component_code,
         t.due_date,
         t.start_date,
         t.end_date,
         t.qty_required,
         t.is_feasible,
         t.breach_reason,
         d.route_position
    from public.schedule_tasks t
    join public.departments d on d.id = t.department_id
    join public.components cmp on cmp.id = t.component_id
   where t.run_id = v_run_id
     and t.shipment_line_id = v_line_id;

  delete from public.schedule_runs where id = v_run_id;
  delete from public.orders where id = v_order_id;

  return query
    select a.department_code, a.component_code, a.due_date::text,
           a.start_date::text, a.end_date::text, a.qty_required::float8,
           a.is_feasible, a.breach_reason
      from _acceptance a
     order by a.route_position, a.component_code;

  drop table _acceptance;
end;
$$;

comment on function public.check_order_acceptance is
  'Schedules a hypothetical shipment line against the live book and reports what breaches. Leaves no trace.';

-- Earliest stuffing date that breaches nothing, searched forward in steps.
--
-- Each candidate is a full schedule run, so this is deliberately bounded and
-- deliberately coarse: it answers "roughly when could we take this?" cheaply
-- enough to be interactive, and the planner confirms the exact date with the
-- check above.
create or replace function public.suggest_stuffing_date(
  p_article_id uuid,
  p_qty numeric,
  p_from_date date default current_date,
  p_step_days integer default 7,
  p_max_attempts integer default 12
)
returns date
language plpgsql
as $$
declare
  v_candidate date := p_from_date;
  v_breaches integer;
begin
  for i in 1..p_max_attempts loop
    select count(*) into v_breaches
      from public.check_order_acceptance(p_article_id, p_qty, v_candidate)
     where not is_feasible;

    if v_breaches = 0 then
      return v_candidate;
    end if;

    v_candidate := v_candidate + p_step_days;
  end loop;

  -- Nothing clean inside the search window. Null says "further out than we
  -- looked", which is honest; a guess would not be.
  return null;
end;
$$;

comment on function public.suggest_stuffing_date is
  'Coarse forward search for the earliest breach-free stuffing date. Null means none within the search window.';
