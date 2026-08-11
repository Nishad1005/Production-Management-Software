-- Kram — what-if scenarios and run comparison.
--
-- Concept deck, slide 3: "What-if simulation to evaluate scenarios such as
-- adding overtime, changing priorities, or machine downtime before finalizing a
-- plan."
--
-- The engine already versions every run and already writes non-current ones, so
-- almost nothing new is needed: apply a temporary change, run the engine, take
-- the change back out, and leave the output behind to be compared against.

-- ---------------------------------------------------------------------------
-- Run a scenario.
--
-- One lever covers all three of the deck's examples, because they are the same
-- thing at different magnitudes: a factor applied to a department's capacity
-- over a window. 0 is a shutdown, 1.2 is overtime, 2.0 is a second shift.
--
-- Passing no department runs the book unchanged, which is how you compare
-- confidence filters — "what does the plan look like if the probable orders
-- land?"
-- ---------------------------------------------------------------------------
create or replace function public.run_what_if(
  p_note text,
  p_confidence public.order_confidence[]
    default array['confirmed', 'probable']::public.order_confidence[],
  p_department_code text default null,
  p_from date default null,
  p_to date default null,
  p_factor numeric default 1
)
returns uuid
language plpgsql
as $$
declare
  v_department_id uuid;
  v_override_ids uuid[] := '{}';
  v_intended integer := 0;
  v_run_id uuid;
begin
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'A scenario needs a label, so the run can be told apart later';
  end if;

  if p_department_code is not null
     and p_from is not null and p_to is not null and p_factor is not null then

    select id into v_department_id
      from public.departments
     where code = p_department_code and is_active;

    if v_department_id is null then
      raise exception 'No active department with code %', p_department_code;
    end if;

    select count(*) into v_intended
      from public.component_rates cr
      join public.department_shifts ds
        on ds.department_id = cr.department_id
       and ds.shift_id = cr.shift_id and ds.is_active
      join public.shifts s on s.id = cr.shift_id and s.is_active
     where cr.department_id = v_department_id;

    -- ON CONFLICT DO NOTHING is deliberate. capacity_overrides carries an
    -- exclusion constraint against overlapping entries at the same
    -- specificity, so a scenario touching a window that already has a real
    -- override — a booked shutdown, say — must not silently replace it. The
    -- real one wins, and the count of what was skipped is reported on the run
    -- so the planner can see the scenario was only partly applied.
    with inserted as (
      insert into public.capacity_overrides
        (department_id, shift_id, component_id, from_date, to_date,
         units_per_day, reason)
      select cr.department_id, cr.shift_id, cr.component_id, p_from, p_to,
             round(cr.units_per_day * p_factor, 3),
             'What-if: ' || p_note
        from public.component_rates cr
        join public.department_shifts ds
          on ds.department_id = cr.department_id
         and ds.shift_id = cr.shift_id and ds.is_active
        join public.shifts s on s.id = cr.shift_id and s.is_active
       where cr.department_id = v_department_id
      on conflict do nothing
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_override_ids from inserted;
  end if;

  -- The temporary overrides must come back out whatever happens. Leaving one
  -- behind would quietly corrupt the real plan, and it would look like a
  -- capacity change nobody remembers making.
  begin
    v_run_id := public.run_schedule(p_confidence, false, p_note);
  exception
    when others then
      delete from public.capacity_overrides where id = any (v_override_ids);
      raise;
  end;

  delete from public.capacity_overrides where id = any (v_override_ids);

  update public.schedule_runs
     set params = params || jsonb_build_object(
           'what_if', jsonb_build_object(
             'department', p_department_code,
             'from', p_from,
             'to', p_to,
             'factor', p_factor,
             'applied', cardinality(v_override_ids),
             'intended', v_intended
           ))
   where id = v_run_id;

  return v_run_id;
end;
$$;

comment on function public.run_what_if is
  'Runs a scenario as a non-current schedule run, then removes the temporary capacity changes. Returns the run id.';

-- ---------------------------------------------------------------------------
-- Compare two runs, department by department.
-- ---------------------------------------------------------------------------
create or replace function public.compare_schedule_runs(
  p_base uuid,
  p_scenario uuid
)
returns table (
  department_code text,
  route_position integer,
  base_utilisation double precision,
  scenario_utilisation double precision,
  utilisation_delta double precision,
  base_flagged_days integer,
  scenario_flagged_days integer,
  base_breaches integer,
  scenario_breaches integer
)
language sql
stable
as $$
  with base as (
    select * from public.schedule_bottleneck where run_id = p_base
  ),
  scenario as (
    select * from public.schedule_bottleneck where run_id = p_scenario
  ),
  breaches as (
    select run_id, department_id, count(*)::integer as n
      from public.schedule_tasks
     where not is_feasible and run_id in (p_base, p_scenario)
     group by run_id, department_id
  )
  select coalesce(b.department_code, s.department_code),
         coalesce(b.route_position, s.route_position),
         b.avg_utilisation::float8,
         s.avg_utilisation::float8,
         round(coalesce(s.avg_utilisation::numeric, 0)
               - coalesce(b.avg_utilisation::numeric, 0), 4)::float8,
         coalesce(b.flagged_days, 0)::integer,
         coalesce(s.flagged_days, 0)::integer,
         coalesce(bb.n, 0),
         coalesce(sb.n, 0)
    from base b
    full outer join scenario s on s.department_id = b.department_id
    left join breaches bb
      on bb.run_id = p_base and bb.department_id = b.department_id
    left join breaches sb
      on sb.run_id = p_scenario and sb.department_id = s.department_id
   order by coalesce(b.route_position, s.route_position);
$$;

-- ---------------------------------------------------------------------------
-- Only the tasks that actually changed.
--
-- "These six stop breaching if you do this" is the answer a planner wants; a
-- full task list with six differences buried in it is not.
-- ---------------------------------------------------------------------------
create or replace function public.compare_run_tasks(
  p_base uuid,
  p_scenario uuid
)
returns table (
  change text,
  erp_order_no text,
  line_no integer,
  department_code text,
  component_code text,
  base_start text,
  scenario_start text,
  base_breach public.breach_reason,
  scenario_breach public.breach_reason
)
language sql
stable
as $$
  select case
           when b.breach_reason is not null and s.breach_reason is null then 'resolved'
           when b.breach_reason is null and s.breach_reason is not null then 'new_breach'
           when b.breach_reason is distinct from s.breach_reason then 'changed_reason'
           else 'moved'
         end as change,
         o.erp_order_no,
         sl.line_no,
         d.code,
         c.code,
         b.start_date::text,
         s.start_date::text,
         b.breach_reason,
         s.breach_reason
    from public.schedule_tasks b
    join public.schedule_tasks s
      on s.run_id = p_scenario
     and s.shipment_line_id = b.shipment_line_id
     and s.department_id = b.department_id
     and s.component_id = b.component_id
    join public.shipment_lines sl on sl.id = b.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.departments d on d.id = b.department_id
    join public.components c on c.id = b.component_id
   where b.run_id = p_base
     and (b.breach_reason is distinct from s.breach_reason
          or b.start_date is distinct from s.start_date)
   order by 1, o.erp_order_no, d.route_position, c.code;
$$;

-- ---------------------------------------------------------------------------
-- Make a scenario the live plan.
-- ---------------------------------------------------------------------------
create or replace function public.promote_schedule_run(p_run_id uuid)
returns void
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.schedule_runs
     where id = p_run_id and status = 'complete'
  ) then
    raise exception 'Run % has not completed, so it cannot become the plan', p_run_id;
  end if;

  -- Two statements rather than one: schedule_runs carries a partial unique
  -- index on is_current, and clearing before setting keeps it satisfied at
  -- every point rather than relying on statement ordering inside an update.
  update public.schedule_runs set is_current = false where is_current;
  update public.schedule_runs set is_current = true where id = p_run_id;
end;
$$;

comment on function public.promote_schedule_run is
  'Promotes a what-if run to be the live plan. The run it replaces is kept, as every run is.';
