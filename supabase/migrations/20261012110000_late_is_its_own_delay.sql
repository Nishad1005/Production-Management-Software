-- Kram — late is the task's own delay; a feeder's delay keeps the name runway.
--
-- ---------------------------------------------------------------------------
-- 20261012100000 made a department that is behind start after the departments
-- feeding it, and let a feeder's delay carry down the route: a department
-- that was on time on its own account is placed after a late feeder and, if
-- that makes it miss its date, was reported 'late'. The word is wrong there.
-- On Accept an order, a proposed order's steps whose D-minus windows are too
-- narrow read "Late — what remains was re-planned from today and still
-- overruns the due date", for an order that has not been placed yet; the day
-- before they read Runway, which said why: the step before finishes too late
-- to leave this one enough working days. The placement is right and stays;
-- the reason is what changes.
--
-- 'late' is now reserved for a task behind on its own account — the latest
-- start that still meets its date is before the first working day from
-- today. A task placed forward only because a department upstream of it ends
-- later keeps the name 'runway' when it still misses its date, and is still
-- placed after them so the bar shows where it would land. attention_behind
-- (late only) therefore lists departments behind on their own account;
-- attention_breach lists the rest as runway, as it did.
--
-- Nothing with p_today null moves: the flag is only set in the depth passes.
--
-- Regenerated from the text of 20261012100000, not retyped.
-- ---------------------------------------------------------------------------

create or replace function public.run_schedule(
  p_confidence public.order_confidence[]
    default array['confirmed', 'probable']::public.order_confidence[],
  p_make_current boolean default true,
  p_note text default null,
  p_today date default null
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
  v_prev uuid;
  v_today_next date;
  v_max_depth integer := 0;
  v_depth integer;
begin
  -- The run that is current as this one starts. With p_today given, the days
  -- before today are taken from it rather than planned again ("The past is
  -- frozen", below).
  select id into v_prev from public.schedule_runs where is_current;

  insert into public.schedule_runs (params, note, status)
  values (
    jsonb_build_object(
      'confidence', to_jsonb(p_confidence),
      'make_current', p_make_current,
      'today', p_today
    ),
    p_note,
    'running'
  )
  returning id into v_run_id;

  -- Guards so two runs inside one explicit transaction do not collide: ON
  -- COMMIT DROP only fires at commit, which may be a long way off.
  drop table if exists _dept, _edge, _reach, _article_dept, _yield, _pair, _task,
                       _cap_pair, _mach, _cap_shift, _cum, _win, _upstream, _final,
                       _wd, _load, _cap_window, _depth, _pb, _fwd;

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

  -- The first working day on or after today, when the engine has been told
  -- what day it is. Outside the calendar there is no such day, and saying so
  -- beats planning from a date that does not exist.
  if p_today is not null then
    select next_working into v_today_next from _wd where calendar_date = p_today;
    if v_today_next is null then
      raise exception 'Today (%) is outside the working-day calendar', p_today;
    end if;
  end if;

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

  -- Depth along the route: the longest path from an entry point, so that
  -- every edge runs from a lower depth to a higher one. Work that is behind
  -- is placed in this order, feeders before the departments they feed, and
  -- when a depth is placed everything upstream of it already is. The cycle
  -- trigger on department_dependencies is what keeps the walk finite.
  create temp table _depth on commit drop as
  with recursive d (department_id, depth) as (
    select d.id, 0
      from _dept d
     where not exists (select 1 from _edge e where e.department_id = d.id)
    union
    select e.department_id, d.depth + 1
      from d
      join _edge e on e.depends_on_department_id = d.department_id
  )
  select department_id, max(depth) as depth
    from d
   group by department_id;

  select coalesce(max(depth), 0) into v_max_depth from _depth;

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
         round(sl.qty * bom.qty_per_unit / y.cum_yield, 3) as qty_required,
         -- What the department has declared good against this job, every day
         -- and shift summed, and what that leaves. qty_required keeps its
         -- meaning for every view that compares declared against required;
         -- placement, load and the breach tests work on what remains.
         coalesce(done.qty_good, 0)                      as qty_done,
         greatest(round(sl.qty * bom.qty_per_unit / y.cum_yield, 3)
                  - coalesce(done.qty_good, 0), 0)       as qty_remaining
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
      on wd.calendar_date = sl.stuffing_date - adm.dminus_days
    -- Grouped first, so the task set is not multiplied by the days declared.
    left join (
      select shipment_line_id, department_id, component_id,
             sum(qty_good) as qty_good
        from public.production_declarations
       group by shipment_line_id, department_id, component_id
    ) done
      on done.shipment_line_id = sl.id
     and done.department_id = p.department_id
     and done.component_id = p.component_id;

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

  -- Work that is behind is placed forward from today, and the grid has to
  -- reach past the last due date for it to land anywhere: a year, in keeping
  -- with the two it already reaches back.
  if p_today is not null then
    v_to := greatest(v_to, p_today + 365);
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

  -- Backward placement, as a table: the forward passes below read it more
  -- than once, and a department that is behind needs to know where the
  -- departments feeding it ended up.
  create temp table _pb on commit drop as
  select w.*,
         u.start_date as unpinned_start
    from _win w

    -- Unpinned: the latest window that still ends on the due date, sized to
    -- what remains. Nothing to place when nothing remains.
    left join lateral (
      select min(c.calendar_date) as start_date
        from _cum c
       where not w.is_pinned
         and w.qty_remaining > 0
         and w.cum_due is not null
         and c.department_id = w.department_id
         and c.component_id = w.component_id
         and c.calendar_date <= w.eff_due
         and c.cum > w.cum_due - w.qty_remaining
    ) u on true;

  create index on _pb (shipment_line_id, department_id);
  analyze _pb;

  -- Forward placement: start on a given day and run until what remains is
  -- covered. One row per task placed forward, with null dates when the day it
  -- should start on is not in the grid; a task with no row here is placed
  -- back from its date.
  create temp table _fwd (
    shipment_line_id uuid not null,
    department_id uuid not null,
    component_id uuid not null,
    forward_start date,
    forward_end date,
    -- Whether the task is behind on its own account: the latest start that
    -- still meets its date is before the first working day from today. False
    -- for a task placed forward only because a department feeding it ends
    -- later — that is the runway case, and it keeps that name.
    own_late boolean not null default false,
    primary key (shipment_line_id, department_id, component_id)
  ) on commit drop;

  -- Pinned work starts where the planner put it (spec §6 — honoured, then
  -- reported, never undone). A pin already in the past starts from today:
  -- the days before today are frozen below, and what remains cannot be made
  -- on them. Pins wait for nothing; what they collide with is reported.
  insert into _fwd (shipment_line_id, department_id, component_id,
                    forward_start, forward_end)
  select pb.shipment_line_id, pb.department_id, pb.component_id,
         f.start_date, f.end_date
    from _pb pb
    left join lateral (
          select s.calendar_date as start_date,
                 (
                   select min(c2.calendar_date)
                     from _cum c2
                    where c2.department_id = pb.department_id
                      and c2.component_id = pb.component_id
                      and c2.calendar_date >= s.calendar_date
                      and c2.cum >= pb.qty_remaining + s.cum - s.capacity
                 ) as end_date
            from _cum s
           where s.department_id = pb.department_id
             and s.component_id = pb.component_id
             and s.calendar_date = (
               select nw.next_working from _wd nw
                where nw.calendar_date = case
                  when p_today is null then pb.pinned_start_date
                  else greatest(pb.pinned_start_date, p_today)
                end)
        ) f on true
   where pb.is_pinned
     and pb.qty_remaining > 0;

  -- Work that is behind. Told what day it is, the engine asks of every
  -- unpinned task with something left: what is the first day it can actually
  -- begin — the first working day from today, or the working day after the
  -- last department upstream of it ends, whichever is later — and is the
  -- latest start that still meets its date before that day? If so the task is
  -- behind, through its own delay or a feeder's, and is placed forward from
  -- that day. Under batch handoff a department cannot start before the
  -- departments feeding it have finished (the runway rule), and a plan that
  -- had Assembly start today on chairs whose covers Stitching also started
  -- today was asking for something the floor cannot do.
  --
  -- Depth by depth, nearest the entry points first, so that by the time a
  -- department is asked every department upstream of it already has its end:
  -- a pin's or a late start's from this table, a job placed back from its
  -- date ends on that date. A statement reads the rows the statements before
  -- it wrote and never its own, which is what makes each pass see exactly the
  -- depths below it. Upstream is the whole closure, not the direct feeders,
  -- so a department the article skips does not break the chain; and it is
  -- restricted to departments with something left to make, so a feeder that
  -- has declared the whole job holds nothing back. One that has not declared
  -- does: the plan is honest to the declarations it has. An ancestor without
  -- an end (one that could not be placed at all) holds nothing either; it
  -- carries its own breach.
  if p_today is not null then
    for v_depth in 0..v_max_depth loop
      insert into _fwd (shipment_line_id, department_id, component_id,
                        forward_start, forward_end, own_late)
      select pb.shipment_line_id, pb.department_id, pb.component_id,
             f.start_date, f.end_date,
             (pb.unpinned_start is null or pb.unpinned_start < v_today_next)
        from _pb pb
        join _depth dp
          on dp.department_id = pb.department_id
         and dp.depth = v_depth
        cross join lateral (
          select (select nw.next_working from _wd nw
                   where nw.calendar_date = greatest(p_today, coalesce(up.last_end + 1, p_today)))
                   as first_day
            from (
              select max(case when fw.shipment_line_id is not null then fw.forward_end
                              else a.eff_due end) as last_end
                from _reach r
                join _pb a
                  on a.shipment_line_id = pb.shipment_line_id
                 and a.department_id = r.root
                 and a.qty_remaining > 0
                left join _fwd fw
                  on fw.shipment_line_id = a.shipment_line_id
                 and fw.department_id = a.department_id
                 and fw.component_id = a.component_id
               where r.node = pb.department_id
                 and r.root <> pb.department_id
            ) up
        ) can
        left join lateral (
          select s.calendar_date as start_date,
                 (
                   select min(c2.calendar_date)
                     from _cum c2
                    where c2.department_id = pb.department_id
                      and c2.component_id = pb.component_id
                      and c2.calendar_date >= s.calendar_date
                      and c2.cum >= pb.qty_remaining + s.cum - s.capacity
                 ) as end_date
            from _cum s
           where s.department_id = pb.department_id
             and s.component_id = pb.component_id
             and s.calendar_date = can.first_day
        ) f on true
       where not pb.is_pinned
         and pb.qty_remaining > 0
         and pb.cum_due is not null
         and (pb.unpinned_start is null
              or can.first_day is null
              or pb.unpinned_start < can.first_day);
    end loop;
  end if;

  create temp table _final on commit drop as
  with placed as (
    select pb.*,
           fw.forward_start,
           fw.forward_end,
           -- Behind: placed forward without a pin, because its own latest
           -- start had passed or because a department feeding it ends later.
           (fw.shipment_line_id is not null and not pb.is_pinned) as is_late,
           coalesce(fw.own_late, false) as own_late
      from _pb pb
      left join _fwd fw
        on fw.shipment_line_id = pb.shipment_line_id
       and fw.department_id = pb.department_id
       and fw.component_id = pb.component_id
  ),
  anchored as (
    select pl.*,
           case when pl.is_pinned or pl.is_late then pl.forward_start
                else pl.unpinned_start end as start_date,
           -- Unpinned work ends on the last day it can actually be worked,
           -- which is the due date unless the department is down over it. A
           -- job with nothing left has no window at all.
           case when pl.qty_remaining <= 0 then null
                when pl.is_pinned or pl.is_late then pl.forward_end
                else pl.eff_due end as end_date
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
             when a.is_pinned or a.is_late then null
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
  -- Breach classification. Order matters: a job with nothing left to make has
  -- nothing to breach; a task with no D-minus has no dates to test for
  -- anything else; and a pin or a late start that cannot finish in time is a
  -- more useful thing to report than the material date it also happens to
  -- miss.
  select r.*,
         (case
           when r.qty_remaining <= 0                     then null
           when not r.dminus_complete                    then 'dminus_incomplete'
           when r.due_date is null or r.cum_due is null  then 'out_of_horizon'
           when r.is_pinned
                and (r.end_date is null or r.end_date > r.due_date) then 'pin'
           when r.is_late and r.own_late
                and (r.end_date is null or r.end_date > r.due_date) then 'late'
           when r.is_late and not r.own_late
                and (r.end_date is null or r.end_date > r.due_date) then 'runway'
           when not r.is_pinned and not r.is_late
                and (r.available is null or r.available < r.qty_remaining)
                                                         then 'out_of_horizon'
           when r.material_ready_date is not null
                and r.start_date < r.material_ready_date then 'material'
           when not r.is_late
                and r.upstream_due is not null
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
    is_feasible, breach_reason, is_pinned, qty_done, qty_remaining
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
         f.is_pinned,
         f.qty_done,
         f.qty_remaining
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
               f.qty_remaining - case
                 when f.is_pinned or f.is_late then c.cum - c.capacity - (f.start_cum - f.start_cap)
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

  -- -------------------------------------------------------------------------
  -- The past is frozen.
  --
  -- With p_today given, nothing above lands before it: work that is behind
  -- starts from today, and so does what remains of a pin in the past. The
  -- days before today are taken from the run that was current when this one
  -- started — load and capacity, and from those the department-day figure —
  -- so production against plan, the efficiency figure and the heatmap's past
  -- stay what they were when the day was planned. A line that has left the
  -- order book is dropped (the foreign key already did that for a deleted
  -- order); a cancelled order's past plan is kept, because it is what the day
  -- was planned to hold. A frozen row for a job since declared complete is
  -- kept: it is what was asked for that day, and the declaration beside it is
  -- the answer. The first run told what day it is freezes whatever its
  -- predecessor had.
  -- -------------------------------------------------------------------------
  if p_today is not null and v_prev is not null then
    insert into _load (shipment_line_id, department_id, shift_id, component_id,
                       load_date, qty_planned)
    select l.shipment_line_id, l.department_id, l.shift_id, l.component_id,
           l.load_date, l.qty_planned
      from public.schedule_daily_load l
      join public.shipment_lines sl on sl.id = l.shipment_line_id
     where l.run_id = v_prev
       and l.load_date < p_today;
  end if;

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
           -- From today when the engine knows it, so the idle days between
           -- today and the first late start are on the heatmap.
           coalesce(p_today,
                    (select min(start_date) from _final where start_date is not null))
       and (select max(end_date) from _final where end_date is not null);

  if p_today is not null and v_prev is not null then
    insert into _cap_window (department_id, shift_id, component_id, load_date, capacity)
    select c.department_id, c.shift_id, c.component_id, c.load_date, c.capacity
      from public.schedule_daily_capacity c
     where c.run_id = v_prev
       and c.load_date < p_today;
  end if;

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
         horizon_from = least((select min(start_date) from _final),
                              (select min(load_date) from _load)),
         horizon_to = greatest((select max(end_date) from _final),
                               (select max(load_date) from _load)),
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
  'Backward-schedules what remains of every open shipment line, netting off what each department has declared. Told what day it is (p_today), it places work that is behind forward from today and keeps the days before today from the previous run. Returns the new schedule_runs id. Never mutates a previous run.';

alter function public.run_schedule(public.order_confidence[], boolean, text, date)
  set statement_timeout = '120s';

-- The running total is a window sort over the whole grid — a hundred and
-- thirty thousand rows on twelve orders, a million at U&M's scale — and it
-- spilled to disk at the default four megabytes on the smallest fixture. A
-- ceiling per sort, not an allocation; the demonstration build's grid never
-- approaches it.
alter function public.run_schedule(public.order_confidence[], boolean, text, date)
  set work_mem = '32MB';

revoke execute on function public.run_schedule(public.order_confidence[], boolean, text, date)
  from public, anon;
grant execute on function public.run_schedule(public.order_confidence[], boolean, text, date)
  to authenticated;
