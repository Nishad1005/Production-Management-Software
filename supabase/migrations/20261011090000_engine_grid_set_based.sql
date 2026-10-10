-- Kram — the capacity grid built as one statement, not one call per cell.
--
-- ---------------------------------------------------------------------------
-- Measured on the live project, 4 Oct: 37 seconds for eleven orders and 220
-- tasks, and cancelled at the 120-second ceiling for anything larger. U&M's
-- real order book is around 324 orders and 40,000 tasks.
--
-- Locally, as the table owner, the dense scale fixture — 13,608 tasks — planned
-- in under five seconds. The difference was row-level security, and the
-- 3 Oct rewrite that made every policy evaluate once per statement did nothing
-- for the engine, which is the finding: `_cap_shift` is department × component
-- × shift × working day, and every cell called `resolve_capacity` — five
-- lookups, each its own statement, each paying the policy once. The number of
-- statements was the cost, not the cost of each. At U&M's scale the grid is
-- about a million cells.
--
-- ---------------------------------------------------------------------------
-- The change.
--
-- `resolve_capacity` is unchanged and remains the referee. The engine now
-- evaluates the same three branches — a figure typed for the component on the
-- day, else one typed for the department, else the standing rate scaled by
-- attendance and by machines running — as left joins over the whole grid in
-- one statement, with `machine_availability` computed once per department and
-- day in a small table of its own. Every left join is at most one row by
-- constraint, so the grid is not multiplied, and the filter that used to be a
-- DELETE is the statement's WHERE.
--
-- The same disease one order smaller: `prev_working_day`, `next_working_day`
-- and `working_days_between` were called once per task, and their bodies
-- cannot be inlined. They are three columns of one pass over the calendar now.
--
-- And a third, found by measuring as a planner rather than as the owner: the
-- department-day summary re-read the 300,000 rows it had just written through
-- a security_invoker view, and under row-level security that one statement
-- was 89 seconds of a 95-second run on the dense fixture — invisible in every
-- test, because the tests run as the owner. The same statement, as the owner,
-- took 82 seconds on a session that had just planned the small fixture and a
-- fifth of a second on a fresh one: its cached plan had been made for the
-- small run. The load and capacity rows are staged in temp tables now, written
-- from there, and summarised from there. Every heavy statement in the engine
-- reads temp tables, which are recreated each run, so no plan survives from a
-- run of a different size.
--
-- Not done, measured and rejected: `plan_cache_mode = force_custom_plan` on
-- the function as insurance against the stale plan. It applies to every
-- prepared statement in the session, the foreign-key checks included — five
-- per row written, 1.4 million on the dense fixture — and each one was
-- re-planned. The load insert went from 2.7 seconds to 8.6. Ordering the
-- rows by the indexes' keys was tried for the same insert and made no
-- difference (2.7 s in any order); the sort only spilled.
--
-- And statistics: the temp tables the placement joins read had none, so the
-- planner guessed. Three ANALYZEs, milliseconds each.
--
-- tests/engine-grid-parity.test.ts asserts every written cell equals the
-- function and that the set of cells is the function's, on every branch;
-- tests/calendar-as-a-set.test.ts proves the three calendar columns against
-- the functions for every date in the calendar and a month beyond it; the
-- parity suite against the client's prototype and every engine test are
-- unchanged. scripts/bench-engine.mjs dumped the plan before and after on
-- three fixtures and the dumps are identical.
--
-- ---------------------------------------------------------------------------
-- Measured with scripts/bench-engine.mjs, native Postgres 18 on this machine,
-- a fresh session per run, the engine's own duration_ms. "planner" is the
-- authenticated role with a planner's claims, as a request through PostgREST
-- arrives; "owner" is how the tests run. Before, the planner column is where
-- the live project lived; after, the two columns are the same.
--
--   fixture                       tasks   load rows   before owner  planner   after owner  planner
--   sparse (71 articles, 12 orders) 168        336        1.6 s     4.3 s        0.64 s    0.65 s
--   dense  (324 orders, 7 depts) 13,608    285,768        5.5 s    95 s          4.6 s     4.5 s
--   um     (994 pairings, 324 orders) 9,072  54,432   not done in 20 min  —      10.9 s    11.3 s
--   um4    (four components a cell) 36,288 217,728        —          —          53 s      58 s
--
-- What is left is writing the run: five foreign-key checks on every row of
-- 533,000 capacity rows at U&M's shape (6 s of the 11), and the running
-- total's window sort. Both scale with the size of the output, not with the
-- number of statements, and neither is dearer as a planner. The capacity
-- grid's volume — every shift of every pairing on every day of the window —
-- is the next lever, and it changes what schedule_component_load lists, so
-- it is a decision and not a rewrite.
--
-- Regenerated from the text of 20260830140000, not retyped.
-- ---------------------------------------------------------------------------

create or replace function public.run_schedule(
  p_confidence public.order_confidence[]
    default array['confirmed', 'probable']::public.order_confidence[],
  p_make_current boolean default true,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_run_id uuid;
  v_started timestamptz := clock_timestamp();
  v_from date;
  v_to date;
  v_tasks integer := 0;
  v_breaches integer := 0;
begin
  insert into public.schedule_runs (params, note, status)
  values (
    jsonb_build_object(
      'confidence', to_jsonb(p_confidence),
      'make_current', p_make_current
    ),
    p_note,
    'running'
  )
  returning id into v_run_id;

  -- Guards so two runs inside one explicit transaction do not collide: ON
  -- COMMIT DROP only fires at commit, which may be a long way off.
  drop table if exists _dept, _edge, _reach, _article_dept, _yield, _pair, _task,
                       _cap_pair, _mach, _cap_shift, _cum, _win, _upstream, _final,
                       _wd, _load, _cap_window;

  -- -------------------------------------------------------------------------
  -- The route graph.
  --
  -- Cumulative yield used to live here, as a window running down route_position.
  -- It depends on the article, so it has moved to _yield below; this is now just
  -- the set of departments in play.
  -- -------------------------------------------------------------------------
  create temp table _dept on commit drop as
  select d.id, d.route_position, d.yield_pct
    from public.departments d
   where d.is_active;

  -- -------------------------------------------------------------------------
  -- The calendar, as a set.
  --
  -- prev_working_day, next_working_day and working_days_between are SQL
  -- functions with sub-selects in their bodies, which the planner will not
  -- inline, so every call is its own statement — forty thousand tasks would be
  -- eighty thousand statements, each paying the row-level policy once. The
  -- same three answers as three columns of one pass over working_days: the
  -- running maximum of working dates (the day itself if it works, else the
  -- last one before), the running minimum from the other end, and the dense
  -- working-day sequence, whose difference counts the working days between
  -- two working days. A date outside the calendar has no row here, so a join
  -- reads null — the functions' own answer for it, and the behaviour the
  -- engine relies on to fail visibly rather than snap to the horizon.
  -- tests/calendar-as-a-set.test.ts proves all three against the functions.
  -- -------------------------------------------------------------------------
  create temp table _wd on commit drop as
  select calendar_date,
         is_working,
         working_day_seq,
         max(case when is_working then calendar_date end) over (
           order by calendar_date
           rows between unbounded preceding and current row
         ) as prev_working,
         min(case when is_working then calendar_date end) over (
           order by calendar_date
           rows between current row and unbounded following
         ) as next_working
    from public.working_days;

  create unique index on _wd (calendar_date);

  create temp table _edge on commit drop as
  select dd.department_id, dd.depends_on_department_id
    from public.department_dependencies dd
    join _dept a on a.id = dd.department_id
    join _dept b on b.id = dd.depends_on_department_id;

  -- Reachability, closed once: (root, node) for every department downstream of
  -- root, root included via the base case. Fourteen nodes, so the closure is a
  -- few hundred rows and both directions read off the same table — descendants
  -- by fixing root, ancestors by fixing node.
  --
  -- union rather than union all: it deduplicates, which both terminates the walk
  -- and keeps a department from being counted twice when two branches rejoin. A
  -- yield must not be applied twice because the material reaches it two ways.
  create temp table _reach on commit drop as
  with recursive down (root, node) as (
    select d.id, d.id from _dept d
    union
    select r.root, e.department_id
      from down r
      join _edge e on e.depends_on_department_id = r.node
  )
  select root, node from down;

  create index on _reach (root);
  create index on _reach (node);

  -- Department × component pairs that can actually run: a rate on an active
  -- shift that the department actually works. No row here means the department
  -- does not touch that component.
  create temp table _pair on commit drop as
  select distinct cr.department_id, cr.component_id
    from public.component_rates cr
    join public.shifts s on s.id = cr.shift_id and s.is_active
    join public.department_shifts ds
      on ds.department_id = cr.department_id
     and ds.shift_id = cr.shift_id
     and ds.is_active
    join _dept d on d.id = cr.department_id;

  -- The departments each article actually passes through — the union across its
  -- components of the departments that hold a rate for them.
  create temp table _article_dept on commit drop as
  select distinct bom.article_id, p.department_id
    from public.article_bom bom
    join _pair p on p.component_id = bom.component_id;

  create index on _article_dept (article_id, department_id);

  -- -------------------------------------------------------------------------
  -- Cumulative yield, per article and department.
  --
  -- Spec §4: "a department must produce the shipped quantity divided by its own
  -- yield and the yield of every department after it." After it means downstream
  -- of it along the route the material takes — not, as this previously read,
  -- every department with a higher route_position.
  --
  -- The difference is the whole of the defect this migration exists to fix. A
  -- wooden leg is made in Wood and goes into the chair at Assembly; it never
  -- enters Fabric Cutting or Stitching, and must not be inflated by their
  -- losses. Restricting to _article_dept matters as much as walking the graph:
  -- a department downstream in the graph that this article never visits cannot
  -- lose any of its material either.
  --
  -- One row per (article, department) rather than per task — 71 × 14 at U&M,
  -- against roughly 40,000 tasks.
  -- -------------------------------------------------------------------------
  create temp table _yield on commit drop as
  select ad.article_id,
         ad.department_id,
         exp(sum(ln(d.yield_pct / 100.0))) as cum_yield
    from _article_dept ad
    join _reach r on r.root = ad.department_id
    join _article_dept visited
      on visited.article_id = ad.article_id
     and visited.department_id = r.node
    join _dept d on d.id = r.node
   group by ad.article_id, ad.department_id;

  create index on _yield (article_id, department_id);

  -- -------------------------------------------------------------------------
  -- Candidate tasks: shipment line × department × component.
  -- Spec §4: the shipment line is the scheduling unit, never the order.
  -- -------------------------------------------------------------------------
  create temp table _task on commit drop as
  select sl.id                        as shipment_line_id,
         p.department_id,
         p.component_id,
         d.route_position,
         sl.material_ready_date,
         adm.is_complete              as dminus_complete,
         case when adm.is_complete then wd.prev_working end as due_date,
         round(sl.qty * bom.qty_per_unit / y.cum_yield, 3) as qty_required
    from public.shipment_lines sl
    join public.orders o
      on o.id = sl.order_id
     and o.status in ('open', 'in_production')
     and o.confidence = any (p_confidence)
    join public.article_bom bom on bom.article_id = o.article_id
    join _pair p on p.component_id = bom.component_id
    join _dept d on d.id = p.department_id
    join _yield y
      on y.article_id = o.article_id
     and y.department_id = p.department_id
    join public.article_dept_dminus adm
      on adm.article_id = o.article_id
     and adm.department_id = p.department_id
    left join _wd wd
      on wd.calendar_date = sl.stuffing_date - adm.dminus_days;

  analyze _task;

  select min(due_date) - 730, max(due_date)
    into v_from, v_to
    from _task
   where due_date is not null;

  -- Nothing has a schedulable date — every article is missing its D-minus, or
  -- there are no orders at all. The pipeline still runs to completion so those
  -- tasks are written down with their reasons. Returning early here would make
  -- "no order book" and "the whole order book is unschedulable" look identical,
  -- which is the difference between nothing to do and an urgent problem.
  if v_to is null then
    v_from := date '3000-01-01';
    v_to := date '3000-01-01';
  end if;

  -- -------------------------------------------------------------------------
  -- Capacity grid, per shift and per day.
  -- Spec §11: capacity is the sum across active shifts of the override for that
  -- date, falling back to the standing rate.
  -- -------------------------------------------------------------------------
  -- Only where work is actually being planned: the pairings in _task, not the
  -- 994 in the masters (30 Aug).
  create temp table _cap_pair on commit drop as
  select distinct department_id, component_id from _task;

  -- machine_availability() as a set: once per department and day rather than
  -- once per cell. Active machines, less the ones with a downtime row covering
  -- the day, over active machines. The exclusion constraint on machine_downtime
  -- lets at most one row cover a machine on a day, so the left join cannot
  -- count a machine twice. No row where the department has no active machine;
  -- the join below then reads null and falls back to 1 — "nobody has said",
  -- which is what the function's null meant and how it was resolved.
  create temp table _mach on commit drop as
  select m.department_id,
         w.calendar_date,
         count(*) filter (where dt.id is null)::numeric / count(*) as availability
    from public.machines m
    join (select distinct department_id from _cap_pair) p
      on p.department_id = m.department_id
    join public.working_days w
      on w.is_working and w.calendar_date between v_from and v_to
    left join public.machine_downtime dt
      on dt.machine_id = m.id
     and w.calendar_date between dt.from_date and dt.to_date
   where m.is_active
   group by m.department_id, w.calendar_date;

  create index on _mach (department_id, calendar_date);

  -- resolve_capacity(), as one statement over the whole grid instead of one
  -- call per cell. The same three branches in the same order: a figure typed
  -- for this component on this day, else one typed for the whole department,
  -- else the standing rate scaled by who came in and what is running. Each
  -- left join is at most one row by constraint — the gist exclusion on
  -- capacity_overrides, the unique keys on component_rates and
  -- department_attendance — so the grid is not multiplied. The function itself
  -- is unchanged and still the referee: tests/engine-grid-parity.test.ts
  -- asserts every written cell equals it, on every branch.
  --
  -- A shift with no rate for a component contributes nothing unless somebody
  -- typed a figure for it; a zero-capacity day (breakdown, shutdown) cannot
  -- absorb work. Both are the WHERE at the end, which is what the DELETE this
  -- replaces used to do.
  create temp table _cap_shift on commit drop as
  select g.department_id, g.shift_id, g.component_id, g.calendar_date, g.capacity
    from (
      select p.department_id,
             ds.shift_id,
             p.component_id,
             w.calendar_date,
             coalesce(
               co_comp.units_per_day,
               co_dept.units_per_day,
               round(
                 cr.units_per_day
                 * coalesce(
                     case when cr.manpower is not null and cr.manpower > 0
                          then att.present::numeric / cr.manpower
                     end,
                     1)
                 * coalesce(m.availability, 1),
                 3)
             ) as capacity
        from _cap_pair p
        join public.department_shifts ds
          on ds.department_id = p.department_id and ds.is_active
        join public.shifts s on s.id = ds.shift_id and s.is_active
        join public.working_days w
          on w.is_working and w.calendar_date between v_from and v_to
        left join public.capacity_overrides co_comp
          on co_comp.department_id = p.department_id
         and co_comp.shift_id = ds.shift_id
         and co_comp.component_id = p.component_id
         and w.calendar_date between co_comp.from_date and co_comp.to_date
        left join public.capacity_overrides co_dept
          on co_dept.department_id = p.department_id
         and co_dept.shift_id = ds.shift_id
         and co_dept.component_id is null
         and w.calendar_date between co_dept.from_date and co_dept.to_date
        left join public.component_rates cr
          on cr.department_id = p.department_id
         and cr.shift_id = ds.shift_id
         and cr.component_id = p.component_id
        left join public.department_attendance att
          on att.department_id = p.department_id
         and att.shift_id = ds.shift_id
         and att.attendance_date = w.calendar_date
        left join _mach m
          on m.department_id = p.department_id
         and m.calendar_date = w.calendar_date
    ) g
   where g.capacity > 0;

  create index on _cap_shift (department_id, component_id, calendar_date);
  analyze _cap_shift;

  create temp table _cum on commit drop as
  select department_id,
         component_id,
         calendar_date,
         capacity,
         sum(capacity) over (
           partition by department_id, component_id
           order by calendar_date
           rows between unbounded preceding and current row
         ) as cum
    from (
      select department_id, component_id, calendar_date, sum(capacity) as capacity
        from _cap_shift
       group by department_id, component_id, calendar_date
    ) g;

  create index on _cum (department_id, component_id, calendar_date);
  analyze _cum;

  -- -------------------------------------------------------------------------
  -- Resolve each task's window.
  -- -------------------------------------------------------------------------
  create temp table _win on commit drop as
  select t.*,
         pin.pinned_start_date,
         (pin.id is not null) as is_pinned,
         cd.calendar_date     as eff_due,
         cd.cum               as cum_due
    from _task t
    left join public.schedule_pins pin
      on pin.is_active
     and pin.shipment_line_id = t.shipment_line_id
     and pin.department_id = t.department_id
     and pin.component_id = t.component_id

    -- The last day *with capacity* on or before the due date, not the due date
    -- itself. A department shut down over its own deadline still has a
    -- schedule; it just has to finish earlier. Matching the due date exactly
    -- would leave those tasks with no cumulative to work from and quietly
    -- report them as out of horizon.
    left join lateral (
      select c.calendar_date, c.cum
        from _cum c
       where c.department_id = t.department_id
         and c.component_id = t.component_id
         and c.calendar_date <= t.due_date
       order by c.calendar_date desc
       limit 1
    ) cd on true;

  -- Upstream due date, for the runway check. Under batch handoff a department
  -- cannot start before the departments feeding it have finished.
  --
  -- The latest due date among this department's ancestors, restricted to the
  -- ones this shipment line actually has work in. Max rather than nearest: due
  -- dates run earlier the further upstream you go, so the maximum is the nearest
  -- anyway, and it stays correct when D-minus figures contradict the graph —
  -- which route_order_conflicts reports rather than silently absorbing.
  --
  -- A department with no ancestors produces no row, so the left join below
  -- leaves upstream_due null and no runway breach is raised. That is the entry
  -- point case, and it is the point: a feeder waits for nothing.
  create temp table _upstream on commit drop as
  with dated as (
    select distinct shipment_line_id, department_id, due_date from _task
  )
  select t.shipment_line_id,
         t.department_id,
         max(ancestor.due_date) as upstream_due
    from dated t
    join _reach r
      on r.node = t.department_id
     and r.root <> t.department_id
    join dated ancestor
      on ancestor.shipment_line_id = t.shipment_line_id
     and ancestor.department_id = r.root
   group by t.shipment_line_id, t.department_id;

  create temp table _final on commit drop as
  with placed as (
    select w.*,
           u.start_date as unpinned_start,
           p.start_date as pinned_start,
           p.end_date   as pinned_end
      from _win w

      -- Unpinned: the latest window that still ends on the due date.
      left join lateral (
        select min(c.calendar_date) as start_date
          from _cum c
         where not w.is_pinned
           and w.cum_due is not null
           and c.department_id = w.department_id
           and c.component_id = w.component_id
           and c.calendar_date <= w.eff_due
           and c.cum > w.cum_due - w.qty_required
      ) u on true

      -- Pinned: start where the planner put it and run forward until the
      -- quantity is covered. Spec §6 — honoured, then reported, never undone.
      left join lateral (
        select s.calendar_date as start_date,
               (
                 select min(c2.calendar_date)
                   from _cum c2
                  where c2.department_id = w.department_id
                    and c2.component_id = w.component_id
                    and c2.calendar_date >= s.calendar_date
                    and c2.cum >= w.qty_required + s.cum - s.capacity
               ) as end_date
          from _cum s
         where w.is_pinned
           and s.department_id = w.department_id
           and s.component_id = w.component_id
           and s.calendar_date = (select nw.next_working from _wd nw
                                   where nw.calendar_date = w.pinned_start_date)
      ) p on true
  ),
  anchored as (
    select pl.*,
           coalesce(pl.pinned_start, pl.unpinned_start) as start_date,
           -- Unpinned work ends on the last day it can actually be worked,
           -- which is the due date unless the department is down over it.
           case when pl.is_pinned then pl.pinned_end else pl.eff_due end as end_date
      from placed pl
  ),
  resolved as (
    select a.*,
           cs.cum      as start_cum,
           cs.capacity as start_cap,
           up.upstream_due,
           -- Capacity actually available inside the resolved window.
           case
             when a.start_date is null or cs.cum is null then null
             when a.is_pinned then null
             else a.cum_due - cs.cum + cs.capacity
           end as available
      from anchored a
      left join _cum cs
        on cs.department_id = a.department_id
       and cs.component_id = a.component_id
       and cs.calendar_date = a.start_date
      left join _upstream up
        on up.shipment_line_id = a.shipment_line_id
       and up.department_id = a.department_id
  )
  -- Breach classification. Order matters: a task with no D-minus has no dates
  -- to test for anything else, and a pin that cannot finish in time is a more
  -- useful thing to report than the material date it also happens to miss.
  --
  -- Computed here rather than by a follow-up UPDATE, which is what this
  -- migration is for. `available` is why it used to need one — it is derived in
  -- the select above and so was not addressable until the table existed. One
  -- more CTE removes that constraint entirely.
  select r.*,
         (case
           when not r.dminus_complete                    then 'dminus_incomplete'
           when r.due_date is null or r.cum_due is null  then 'out_of_horizon'
           when r.is_pinned
                and (r.end_date is null or r.end_date > r.due_date) then 'pin'
           when not r.is_pinned
                and (r.available is null or r.available < r.qty_required)
                                                         then 'out_of_horizon'
           when r.material_ready_date is not null
                and r.start_date < r.material_ready_date then 'material'
           when r.upstream_due is not null
                and r.start_date < r.upstream_due        then 'runway'
         end)::public.breach_reason as breach
    from resolved r;

  analyze _final;

  -- -------------------------------------------------------------------------
  -- Write the run.
  -- -------------------------------------------------------------------------
  insert into public.schedule_tasks (
    run_id, shipment_line_id, department_id, component_id,
    due_date, start_date, end_date, qty_required, days_needed,
    is_feasible, breach_reason, is_pinned
  )
  select v_run_id, f.shipment_line_id, f.department_id, f.component_id,
         f.due_date, f.start_date, f.end_date, f.qty_required,
         -- Both are working days (they are _cum dates), so the inclusive
         -- count is the difference of their working-day sequence numbers.
         case when f.start_date is not null and f.end_date is not null
              then we.working_day_seq - ws.working_day_seq + 1
         end,
         f.breach is null,
         f.breach,
         f.is_pinned
    from _final f
    left join _wd ws on ws.calendar_date = f.start_date
    left join _wd we on we.calendar_date = f.end_date;

  get diagnostics v_tasks = row_count;

  -- Daily load, split across the shifts working that day in proportion to what
  -- each contributes. Written wherever a window exists — including for flagged
  -- tasks, because a material or runway breach is precisely the thing a planner
  -- needs to *see* on the heatmap.
  --
  -- Into a temp table first, then to the run and the department-day summary
  -- from the same rows. The summary used to re-read what had just been
  -- written through schedule_component_load, a security_invoker view: as the
  -- owner that was fast, and as a signed-in planner — which is every run on
  -- the live project — it was 89 of a 95-second run at the dense scale, the
  -- grid of 300,000 rows aggregated again under row-level security. The rows
  -- are in hand here; summarising them costs a tenth of a second.
  create temp table _load on commit drop as
  select f.shipment_line_id,
         f.department_id,
         cs.shift_id,
         f.component_id,
         c.calendar_date as load_date,
         round(pl.planned * cs.capacity / c.capacity, 3) as qty_planned
    from _final f
    join _cum c
      on c.department_id = f.department_id
     and c.component_id = f.component_id
     and c.calendar_date between f.start_date and f.end_date
    cross join lateral (
      select least(
               c.capacity,
               f.qty_required - case
                 when f.is_pinned then c.cum - c.capacity - (f.start_cum - f.start_cap)
                 else f.cum_due - c.cum
               end
             ) as planned
    ) pl
    join _cap_shift cs
      on cs.department_id = f.department_id
     and cs.component_id = f.component_id
     and cs.calendar_date = c.calendar_date
   where f.start_date is not null
     and f.end_date is not null
     and pl.planned > 0;

  insert into public.schedule_daily_load (
    run_id, shipment_line_id, department_id, shift_id, component_id,
    load_date, qty_planned
  )
  select v_run_id, shipment_line_id, department_id, shift_id, component_id,
         load_date, qty_planned
    from _load;

  -- Capacity for the same grid, bounded to the dates actually in play.
  create temp table _cap_window on commit drop as
  select cs.department_id, cs.shift_id, cs.component_id,
         cs.calendar_date as load_date, cs.capacity
    from _cap_shift cs
   where cs.calendar_date between
           (select min(start_date) from _final where start_date is not null)
       and (select max(end_date) from _final where end_date is not null);

  insert into public.schedule_daily_capacity (
    run_id, department_id, shift_id, component_id, load_date, capacity
  )
  select v_run_id, department_id, shift_id, component_id, load_date, capacity
    from _cap_window;

  -- -------------------------------------------------------------------------
  -- The department-day figure, written once instead of aggregated on every read.
  --
  -- `schedule_department_day` used to compute this by summing the two grids
  -- above on every read — 3.1 seconds a screen on Supabase, and over the API's
  -- eight-second ceiling once anything joined to it. Stored since 30 Aug.
  --
  -- The expression is schedule_component_load's, over the rows just staged:
  -- capacity summed across shifts per component and day, load summed across
  -- shifts and lines, the ratio per component, the ratios added per
  -- department-day. Same rounding (both columns are numeric(14,3) and the
  -- staged values already are), same null handling, same thresholds.
  -- tests/engine-scale.test.ts compares the stored row to the view's own
  -- aggregate and must find no difference.
  -- -------------------------------------------------------------------------
  insert into public.schedule_daily_department (
    run_id, department_id, load_date, utilisation, components_loaded, status
  )
  select v_run_id,
         cap.department_id,
         cap.load_date,
         sum(coalesce(l.qty_planned, 0) / nullif(cap.capacity, 0)),
         count(*) filter (where coalesce(l.qty_planned, 0) > 0),
         case
           when sum(coalesce(l.qty_planned, 0) / nullif(cap.capacity, 0)) > 1.0001 then 'over'
           when sum(coalesce(l.qty_planned, 0) / nullif(cap.capacity, 0)) > 0 then 'loaded'
           else 'idle'
         end
    from (
      select department_id, component_id, load_date, sum(capacity) as capacity
        from _cap_window
       group by department_id, component_id, load_date
    ) cap
    left join (
      select department_id, component_id, load_date, sum(qty_planned) as qty_planned
        from _load
       group by department_id, component_id, load_date
    ) l
      on l.department_id = cap.department_id
     and l.component_id = cap.component_id
     and l.load_date = cap.load_date
   group by cap.department_id, cap.load_date;

  select count(*) into v_breaches from _final where breach is not null;

  update public.schedule_runs
     set status = 'complete',
         horizon_from = (select min(start_date) from _final),
         horizon_to = (select max(end_date) from _final),
         task_count = v_tasks,
         breach_count = v_breaches,
         duration_ms = (extract(epoch from clock_timestamp() - v_started) * 1000)::integer
   where id = v_run_id;

  if p_make_current then
    update public.schedule_runs set is_current = false where is_current;
    update public.schedule_runs set is_current = true where id = v_run_id;
  end if;

  return v_run_id;
end;
$$;

comment on function public.run_schedule is
  'Backward-schedules every open shipment line. Returns the new schedule_runs id. Never mutates a previous run.';

alter function public.run_schedule(public.order_confidence[], boolean, text)
  set statement_timeout = '120s';

-- The running total is a window sort over the whole grid — a hundred and
-- thirty thousand rows on twelve orders, a million at U&M's scale — and it
-- spilled to disk at the default four megabytes on the smallest fixture. A
-- ceiling per sort, not an allocation; the demonstration build's grid never
-- approaches it.
alter function public.run_schedule(public.order_confidence[], boolean, text)
  set work_mem = '32MB';
