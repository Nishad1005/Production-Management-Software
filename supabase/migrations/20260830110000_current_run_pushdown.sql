-- Kram — reading one plan instead of every plan ever made.
--
-- ---------------------------------------------------------------------------
-- What the measurement said.
--
-- After the attention split, seven of the eight branches came back green on the
-- live project and `attention_overloaded` was still cancelled at eight seconds.
-- `explain (analyze)` on a local database holding five runs:
--
--   Seq Scan on schedule_daily_capacity  (actual rows=960)
--   Seq Scan on schedule_daily_load      (actual rows=215)
--
-- 960 is every capacity row of all five runs. 192 of them belong to the current
-- one. The view aggregated the entire history of the factory's plans, and only
-- then joined `schedule_runs` to throw four fifths of that work away — because
-- a join cannot be pushed through a GROUP BY, so the planner had no choice.
--
-- On U&M's project that history is far longer, the grid is 994 rates wide, and
-- every one of those rows pays its row-level policy on the way past.
--
-- ---------------------------------------------------------------------------
-- The change: a stable function instead of a join.
--
-- `current_run_id()` is marked `stable`, so the planner evaluates it once and
-- treats the result as a constant — and a constant qual on `run_id` *does* push
-- down through both GROUP BYs, onto the leading column of the grid index that
-- has existed since the schedule tables were created:
--
--   Index Scan using schedule_daily_capacity_grid_idx  (actual rows=192)
--     Index Cond: (run_id = current_run_id())
--
-- Same output, verified row for row against the old definition on a factory
-- with breaches in it. `schedule_runs_one_current_idx` is a unique partial
-- index on `is_current`, so at most one run can be current and a scalar is
-- exactly equivalent to the join it replaces.
--
-- `attention_breach` had the same join. It measured 61 ms because
-- `schedule_tasks` is small, but it would decay the same way as runs
-- accumulate, so it gets the same treatment rather than waiting to become
-- the next thing that fails in production.
-- ---------------------------------------------------------------------------

create or replace function public.current_run_id()
returns uuid
language sql
stable
as $fn$ select id from public.schedule_runs where is_current limit 1 $fn$;

comment on function public.current_run_id() is
  'The live plan, as a value the planner can fold to a constant and push down through an aggregate. A join to schedule_runs cannot be pushed through a GROUP BY; this can.';

grant execute on function public.current_run_id() to authenticated;

create or replace view public.attention_overloaded
with (security_invoker = true) as
-- A department asked for more than it can make. The triage already labels
  -- what is still possible at that lead time, and that label decides the
  -- severity: under a fortnight the answer stops being overtime and becomes a
  -- phone call to the customer.
  select 'overloaded' as kind,
         case when t.days_out < 15 then 'critical' else 'warning' end as severity,
         t.department_code || ' is over capacity on ' || t.load_date as title,
         'Asked for ' || round(100 * t.over_by)::text || '% more than it can make · ' ||
           replace(t.still_possible, '_', ' ') as detail,
         '/heatmap' as route,
         'overloaded:' || t.department_code || ':' || t.load_date as key,
         t.days_out as days_out
    from public.schedule_flag_triage t
   where t.run_id = public.current_run_id()
     and t.days_out >= 0;


create or replace view public.attention_breach
with (security_invoker = true) as
-- Work that cannot be made as planned at all. One row per order and
  -- department rather than per task: a department missing six components of one
  -- order is one conversation, not six alerts.
  select 'breach'                         as kind,
         case when min(g.days_out) < 15 then 'critical' else 'warning' end as severity,
         g.department_code || ' cannot make ' || g.erp_order_no || ' as planned'
                                          as title,
         max(g.breach_reason::text) || ' · ships ' || min(g.stuffing_date) as detail,
         '/gantt'                         as route,
         'breach:' || g.erp_order_no || ':' || g.department_code as key,
         min(g.days_out)                  as days_out
    from (
      -- The tables, not `schedule_gantt`. That view joins six tables to return
      -- twenty columns; this wants four, and every column it does not want is
      -- another table applying its row-level policy.
      select o.erp_order_no,
             d.code                as department_code,
             t.breach_reason,
             sl.stuffing_date::text as stuffing_date,
             (sl.stuffing_date - current_date)::integer as days_out
        from public.schedule_tasks t
        join public.shipment_lines sl on sl.id = t.shipment_line_id
        join public.orders o on o.id = sl.order_id
        join public.departments d on d.id = t.department_id
       where t.run_id = public.current_run_id()
         and not t.is_feasible
    ) g
   group by g.erp_order_no, g.department_code;


-- ---------------------------------------------------------------------------
-- And the reason the history was long enough to matter.
--
-- `prune_schedule_runs` was written on 10 Aug, keeps the current run and the
-- most recent twenty, and **nothing has ever called it**. Twenty days of
-- planning runs accumulated on the live project with no upper bound, each one
-- carrying its own full department × component × date grid.
--
-- This is the sixth time a built-and-tested thing has turned out to be wired to
-- nothing — after `capacity_overrides`, `wip_by_order`, `production_vs_plan`,
-- `employees` and the `kiosk` role. The others were invisible on screen; this
-- one was invisible and getting slower.
--
-- A statement trigger rather than an edit to `run_schedule`: the engine is four
-- hundred lines and rebuilding it by hand has twice reverted something quietly.
-- It fires as the run row is inserted, before the run is made current, so the
-- new run sorts first by `run_at` and is never itself a candidate.
-- ---------------------------------------------------------------------------

create or replace function public.prune_runs_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.prune_schedule_runs(20);
  return null;
end;
$fn$;

drop trigger if exists prune_runs on public.schedule_runs;
create trigger prune_runs
  after insert on public.schedule_runs
  for each statement
  execute function public.prune_runs_after_insert();

comment on function public.prune_runs_after_insert() is
  'Keeps schedule history bounded at twenty runs plus the current one. prune_schedule_runs existed from the first schedule migration and nothing had ever called it.';
