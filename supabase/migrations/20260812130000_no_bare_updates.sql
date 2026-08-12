-- Kram — no UPDATE or DELETE without a WHERE clause.
--
-- Supabase preloads the `safeupdate` library for the roles PostgREST connects
-- as, and it refuses any UPDATE or DELETE whose plan carries no qualifier:
--
--     ERROR: UPDATE requires a WHERE clause
--
-- Two functions did exactly that, and **neither has ever worked on the live
-- project** — `run_history` holds zero rows, because `run_schedule` has failed
-- on every call since the day the schema was pushed. `rebuild_working_days`
-- fails the same way, so adding or removing a holiday has never worked either.
-- The calendar exists only because migrations run as the table owner, whose
-- session does not preload the library. The engine is the centre of the product
-- and it had never once run in production.
--
-- Nothing catches this locally. Native Postgres does not load `safeupdate`, so
-- all 108 tests pass against a build that cannot run at all on Supabase — the
-- same shape of gap as the day anon could call every function while every
-- policy was green. Two things are added alongside this migration: a test that
-- reads the migrations and fails on a bare UPDATE or DELETE, and a `verify:live`
-- probe that actually calls both functions against production.
--
-- `where true` would not have fixed it. The planner folds a constant-true
-- qualifier away and the plan arrives at `safeupdate` bare regardless, so both
-- fixes here are structural rather than a qualifier added to satisfy a check.
--
-- Otherwise identical to 20260812120100_engine_walks_graph.sql, which this
-- replaces; the breach classification moves from a follow-up UPDATE into the
-- select that builds the table.
--
-- Replaces the definition in 20260810130200_schedule_engine.sql. Two temp tables
-- change; everything else is carried across unaltered so the diff between the
-- two files is the whole of what moved.
--
-- What moved, and why: route_position used to mean both "the order to list
-- departments in" and "each one follows the one before it". PPC has confirmed
-- the second is false — Metal Finishing, Fibre Processing and fabric Cutting are
-- entry points that feed the line rather than sitting in it. What actually feeds
-- what now lives in department_dependencies (20260812120000_route_graph.sql),
-- and this reads it.
--
--   _upstream took the previous department by position. It now takes the latest
--   due date among a department's actual ancestors, so a feeder is held behind
--   nothing and stops raising runway breaches that are not real.
--
--   _dept computed cumulative yield over every active department and joined it
--   to tasks without reference to the article. So a component carried the losses
--   of departments it never entered — a wooden leg charged for fabric cutting
--   and stitching. It is now computed per article and department, over that
--   department's descendants within that article's own route.
--
-- Under the linear edges seeded by the previous migration this is arithmetically
-- identical to what it replaces for any article that passes through every
-- department — which is what the parity harness runs, so parity holds. It is
-- deliberately *not* identical for an article that skips departments: that
-- difference is the defect leaving.
--
-- Spec §11: "A pure function of the masters and the order book. It writes a new
-- schedule_run and never mutates an existing one."
--
-- The whole thing is set-based. At ~40,000 tasks and 300–400k daily-load rows a
-- row-by-row walk would take minutes; the two decisions that keep it in seconds
-- are the pre-numbered working-day calendar and the cumulative-capacity trick
-- below, which turns "how far back does this work stretch?" into an indexed
-- range lookup instead of a loop.
--
-- The cumulative trick, once, in plain terms:
--
--   cum(d) is the capacity available on every working day up to and including d.
--   Capacity in the window [s, due] is therefore cum(due) - cum(s) + cap(s).
--   So the days a task occupies are exactly those d <= due where
--       cum(d) > cum(due) - qty_required
--   and the quantity landing on each of them is
--       least( cap(d), qty_required - (cum(due) - cum(d)) )
--   which fills every day to capacity and leaves the remainder on the earliest,
--   as spec §11 requires. No iteration anywhere.

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
                       _cap_shift, _cum, _win, _upstream, _final;

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
         case when adm.is_complete
              then public.prev_working_day(sl.stuffing_date - adm.dminus_days)
         end                          as due_date,
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
     and adm.department_id = p.department_id;

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
  create temp table _cap_shift on commit drop as
  select p.department_id,
         ds.shift_id,
         p.component_id,
         w.calendar_date,
         public.resolve_capacity(p.department_id, ds.shift_id, p.component_id, w.calendar_date)
           as capacity
    from _pair p
    join public.department_shifts ds
      on ds.department_id = p.department_id and ds.is_active
    join public.shifts s on s.id = ds.shift_id and s.is_active
    join public.working_days w
      on w.is_working and w.calendar_date between v_from and v_to;

  -- A shift with no rate for a component contributes nothing; a zero-capacity
  -- day (breakdown, shutdown) simply cannot absorb work.
  delete from _cap_shift where capacity is null or capacity <= 0;

  create index on _cap_shift (department_id, component_id, calendar_date);

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
           and s.calendar_date = public.next_working_day(w.pinned_start_date)
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
         case when f.start_date is not null and f.end_date is not null
              then public.working_days_between(f.start_date, f.end_date)
         end,
         f.breach is null,
         f.breach,
         f.is_pinned
    from _final f;

  get diagnostics v_tasks = row_count;

  -- Daily load, split across the shifts working that day in proportion to what
  -- each contributes. Written wherever a window exists — including for flagged
  -- tasks, because a material or runway breach is precisely the thing a planner
  -- needs to *see* on the heatmap.
  insert into public.schedule_daily_load (
    run_id, shipment_line_id, department_id, shift_id, component_id,
    load_date, qty_planned
  )
  select v_run_id,
         f.shipment_line_id,
         f.department_id,
         cs.shift_id,
         f.component_id,
         c.calendar_date,
         round(pl.planned * cs.capacity / c.capacity, 3)
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

  -- Capacity for the same grid, bounded to the dates actually in play.
  insert into public.schedule_daily_capacity (
    run_id, department_id, shift_id, component_id, load_date, capacity
  )
  select v_run_id, cs.department_id, cs.shift_id, cs.component_id,
         cs.calendar_date, cs.capacity
    from _cap_shift cs
   where cs.calendar_date between
           (select min(start_date) from _final where start_date is not null)
       and (select max(end_date) from _final where end_date is not null);

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

-- ---------------------------------------------------------------------------
-- The calendar rebuild, which fails the same way.
--
-- `delete from public.working_days;` wiped the table before regenerating it, so
-- every holiday edit from the Masters screen has been failing on the live
-- project since it went up. The trigger fires as the signed-in user, and
-- security definer does not help: `session_preload_libraries` is loaded at
-- connection time and the library does not care which role the function runs as.
--
-- Scoped to the horizon being rebuilt rather than given a token qualifier. On
-- the path that matters — the holiday trigger, which passes no arguments —
-- v_from and v_to are the existing minimum and maximum, so this deletes exactly
-- what the bare statement did.
--
-- It does differ when called with an explicit narrower horizon: rows outside it
-- now survive instead of being wiped. That is the behaviour the function's own
-- comment already claimed ("so a holiday edit does not silently shrink the
-- calendar out from under a live schedule run") and did not have.
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_working_days(
  p_from date default null,
  p_to date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to date;
  v_count integer;
begin
  -- Keep the existing horizon unless told otherwise, so a holiday edit does not
  -- silently shrink the calendar out from under a live schedule run.
  select coalesce(p_from, min(calendar_date), (current_date - interval '3 years')::date),
         coalesce(p_to, max(calendar_date), (current_date + interval '3 years')::date)
    into v_from, v_to
    from public.working_days;

  delete from public.working_days
   where calendar_date between v_from and v_to;

  insert into public.working_days (calendar_date, is_working)
  select d::date,
         extract(dow from d) <> 0
           and not exists (
             select 1 from public.holidays h where h.holiday_date = d::date
           )
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d;

  with numbered as (
    select calendar_date, row_number() over (order by calendar_date) as rn
      from public.working_days
     where is_working
  )
  update public.working_days w
     set working_day_seq = numbered.rn
    from numbered
   where w.calendar_date = numbered.calendar_date;

  select count(*) into v_count from public.working_days where is_working;
  return v_count;
end;
$$;

comment on function public.rebuild_working_days is
  'Regenerates working_days over the current (or given) horizon. Returns working-day count. Deletes only within that horizon — dates outside it are left alone.';
