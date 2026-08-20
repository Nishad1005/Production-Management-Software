-- Kram Phase 10 — prediction, with its evidence attached.
--
-- ---------------------------------------------------------------------------
-- The disagreement this was built through, recorded because it matters.
--
-- I recommended measuring before modelling: the live project holds no
-- production history at all, and a model trained on nothing is not a cautious
-- model, it is a confident wrong one. Nishad chose to build the models now.
-- That is the decision, and this is it built.
--
-- The condition it is built under: **nothing here states a figure without
-- stating what it is based on**. Every view carries an observation count, and
-- below a threshold it reports `too few to say` and shows the count instead of
-- a number. A prediction from two data points and one from two hundred look
-- identical on a screen, and only one of them should be acted on.
--
-- ---------------------------------------------------------------------------
-- The threshold is ten, and it is a judgement.
--
-- Ten observations is not a statistical result; it is a line drawn where a
-- figure stops being an anecdote. It lives in one function so it can be argued
-- with and changed in one place, rather than being sprinkled through five
-- views as a magic number.
--
-- On U&M's live project today every one of these will report `too few to say`,
-- because there are zero declarations against it. That is the correct output
-- and the screen is built around it rather than embarrassed by it.
-- ---------------------------------------------------------------------------

create or replace function public.forecast_threshold()
returns integer
language sql
immutable
as $$ select 10 $$;

comment on function public.forecast_threshold() is
  'Observations below which a prediction refuses to state a figure. A judgement, in one place so it can be argued with.';

-- ---------------------------------------------------------------------------
-- 1. What a department actually achieves, against what its master claims.
--
-- The rate version of `measured_yield`, which has existed since Phase 3, and
-- deliberately the same shape: **reported, never applied**. A master that edits
-- itself is one nobody can account for, and a rate that drifts on its own would
-- move every date in the system with no entry anywhere saying why.
-- ---------------------------------------------------------------------------
create view public.measured_rate
with (security_invoker = true) as
  with per_day as (
    -- A department can declare the same component twice in a day across two
    -- shifts; the day's output is the sum, and the day is the observation.
    select decl.department_id,
           decl.component_id,
           decl.production_date,
           sum(decl.qty_good) as qty_good
      from public.production_declarations decl
     group by decl.department_id, decl.component_id, decl.production_date
  ),
  measured as (
    select department_id,
           component_id,
           count(*)                       as observations,
           round(avg(qty_good), 2)        as avg_per_day,
           min(qty_good)                  as worst_day,
           max(qty_good)                  as best_day,
           min(production_date)           as first_seen,
           max(production_date)           as last_seen
      from per_day
     group by department_id, component_id
  )
  select d.code                       as department_code,
         d.name                       as department_name,
         c.code                       as component_code,
         m.observations::integer,
         -- The standing rate this is being compared against. Null where the
         -- department has produced something it has no rate for, which is
         -- itself worth seeing.
         rate.units_per_day::float8   as standing_rate,
         case when m.observations >= public.forecast_threshold()
              then m.avg_per_day::float8 end as measured_rate,
         case when m.observations >= public.forecast_threshold()
                   and rate.units_per_day is not null and rate.units_per_day > 0
              then round(100 * (m.avg_per_day - rate.units_per_day)
                         / rate.units_per_day, 1)::float8 end as against_plan_pct,
         m.worst_day::float8,
         m.best_day::float8,
         m.first_seen::text,
         m.last_seen::text,
         case when m.observations >= public.forecast_threshold()
              then 'measured' else 'too few to say' end as confidence
    from measured m
    join public.departments d on d.id = m.department_id
    join public.components c on c.id = m.component_id
    left join lateral (
      select cr.units_per_day
        from public.component_rates cr
       where cr.department_id = m.department_id
         and cr.component_id = m.component_id
       limit 1
    ) rate on true;

comment on view public.measured_rate is
  'What each department actually achieves per day, against the rate its master claims. Reported, never applied — the same rule as measured_yield.';

grant select on public.measured_rate to authenticated;

-- ---------------------------------------------------------------------------
-- 2. How long an article actually takes, against how long the plan allows.
--
-- Observed from finished shipment lines only. A line still in progress has a
-- span that grows every day it is not finished, and averaging those in would
-- make every article look faster than it is.
-- ---------------------------------------------------------------------------
create view public.predicted_lead_time
with (security_invoker = true) as
  with line_span as (
    select sl.id as shipment_line_id,
           o.article_id,
           min(decl.production_date) as started,
           max(decl.production_date) as finished,
           count(distinct decl.department_id) as departments_touched
      from public.production_declarations decl
      join public.shipment_lines sl on sl.id = decl.shipment_line_id
      join public.orders o on o.id = sl.order_id
     group by sl.id, o.article_id
  ),
  routed as (
    select b.article_id,
           count(distinct cr.department_id) as departments_on_route,
           max(adm.dminus_days) - min(adm.dminus_days) as planned_span
      from public.article_bom b
      join public.component_rates cr on cr.component_id = b.component_id
      join public.article_dept_dminus adm
        on adm.article_id = b.article_id
       and adm.department_id = cr.department_id
       and adm.is_complete
     group by b.article_id
  ),
  finished as (
    -- Complete means every department on the route has declared. Anything less
    -- is a line still moving, and its span is not a lead time yet.
    select ls.article_id,
           (ls.finished - ls.started + 1) as span_days
      from line_span ls
      join routed r on r.article_id = ls.article_id
     where ls.departments_touched >= r.departments_on_route
  ),
  observed as (
    select article_id,
           count(*) as observations,
           round(avg(span_days), 1) as avg_span,
           min(span_days) as fastest,
           max(span_days) as slowest
      from finished
     group by article_id
  )
  select a.code                    as article_code,
         a.name                    as article_name,
         coalesce(o.observations, 0)::integer as observations,
         r.planned_span::integer,
         case when coalesce(o.observations, 0) >= public.forecast_threshold()
              then o.avg_span::float8 end as measured_span,
         case when coalesce(o.observations, 0) >= public.forecast_threshold()
              then o.fastest::integer end as fastest,
         case when coalesce(o.observations, 0) >= public.forecast_threshold()
              then o.slowest::integer end as slowest,
         case when coalesce(o.observations, 0) >= public.forecast_threshold()
              then 'measured' else 'too few to say' end as confidence
    from public.articles a
    join routed r on r.article_id = a.id
    left join observed o on o.article_id = a.id
   where a.is_active;

grant select on public.predicted_lead_time to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Which shipments look like missing their container.
--
-- Bands, not percentages. A percentage implies a calibration nothing here has
-- earned — 73% would be read as a probability, and it would be a number made up
-- to look like one. Three bands, each with the reason it landed in that band.
-- ---------------------------------------------------------------------------
create view public.shipment_risk
with (security_invoker = true) as
  with planned as (
    select t.shipment_line_id,
           min(t.start_date) as starts,
           max(t.due_date)   as ends,
           sum(t.qty_required) as qty_planned,
           count(*) filter (where not t.is_feasible) as infeasible
      from public.schedule_tasks t
      join public.schedule_runs r on r.id = t.run_id and r.is_current
     group by t.shipment_line_id
  ),
  done as (
    select decl.shipment_line_id,
           sum(decl.qty_good) as qty_good,
           count(*) as declarations
      from public.production_declarations decl
     group by decl.shipment_line_id
  )
  select o.erp_order_no,
         sl.line_no,
         a.code                        as article_code,
         cu.name                       as customer_name,
         sl.stuffing_date::text,
         (sl.stuffing_date - current_date)::integer as days_to_stuffing,
         p.qty_planned::float8,
         coalesce(d.qty_good, 0)::float8 as qty_made,
         coalesce(d.declarations, 0)::integer as observations,
         -- How far through the window we are, against how far through the work
         -- we are. Both are fractions of the same thing, which is the only
         -- comparison that needs no model.
         case when p.ends > p.starts
              then round(100.0 * (current_date - p.starts) / (p.ends - p.starts), 0)
         end::float8 as window_elapsed_pct,
         case when p.qty_planned > 0
              then round(100.0 * coalesce(d.qty_good, 0) / p.qty_planned, 0)
         end::float8 as work_done_pct,
         p.infeasible::integer,
         case
           when p.infeasible > 0 then 'likely late'
           when current_date < p.starts then 'not started'
           when p.qty_planned > 0 and p.ends > p.starts
                and (current_date - p.starts)::numeric / (p.ends - p.starts)
                    - coalesce(d.qty_good, 0) / p.qty_planned > 0.2
             then 'at risk'
           else 'on track'
         end as band,
         case
           when p.infeasible > 0
             then 'The plan already cannot be made as scheduled'
           when current_date < p.starts then 'Work has not started yet'
           when p.qty_planned > 0 and p.ends > p.starts
                and (current_date - p.starts)::numeric / (p.ends - p.starts)
                    - coalesce(d.qty_good, 0) / p.qty_planned > 0.2
             then 'More of the window has gone than of the work'
           else 'Progress is keeping up with the window'
         end as because
    from planned p
    join public.shipment_lines sl on sl.id = p.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
    join public.customers cu on cu.id = o.customer_id
    left join done d on d.shipment_line_id = p.shipment_line_id
   where o.status in ('open', 'in_production');

comment on view public.shipment_risk is
  'Open shipment lines banded on track / at risk / likely late, each with the reason. Bands rather than percentages: a percentage would imply a calibration nothing here has earned.';

grant select on public.shipment_risk to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Whether any of the above should be believed yet.
--
-- The first thing on the screen, deliberately. Everything above is capable of
-- printing a confident figure the moment it has ten rows behind it, and on a
-- factory that started using Kram a fortnight ago ten rows is not a lot of
-- factory. This says how much history exists, in the units a person thinks in.
-- ---------------------------------------------------------------------------
create view public.forecast_readiness
with (security_invoker = true) as
  select (select count(*) from public.production_declarations)::integer
           as declarations,
         (select count(distinct production_date)
            from public.production_declarations)::integer as days_recorded,
         (select min(production_date)::text
            from public.production_declarations) as first_day,
         (select max(production_date)::text
            from public.production_declarations) as last_day,
         (select count(*) from public.measured_rate
           where confidence = 'measured')::integer as rates_measured,
         (select count(*) from public.measured_rate)::integer as rates_seen,
         (select count(*) from public.predicted_lead_time
           where confidence = 'measured')::integer as articles_measured,
         (select count(*) from public.predicted_lead_time)::integer as articles_seen,
         public.forecast_threshold() as threshold;

grant select on public.forecast_readiness to authenticated;
