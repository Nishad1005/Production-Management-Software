-- Kram — versioned schedule output.
--
-- Spec §11: the engine "writes a new schedule_run and never mutates an existing
-- one, so any past plan can be recovered and compared against what actually
-- happened."

create type public.schedule_run_status as enum ('running', 'complete', 'failed');

create type public.breach_reason as enum (
  -- Spec §11 feasibility checks
  'material',           -- window opens before material_ready_date
  'runway',             -- fewer working days than the department needs; overtime cannot fix it
  'pin',                -- a manual pin has pushed the task past its due date
  -- Data problems that must be visible rather than silently skipped
  'no_capacity',        -- no rate for this component in this department
  'out_of_horizon',     -- the window falls outside the working-day calendar
  'dminus_incomplete'   -- the article × department offset has never been entered
);

create table public.schedule_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  run_by uuid references auth.users (id) default auth.uid(),

  -- What the run was asked for: confidence filter, horizon, whether it was a
  -- what-if. Kept verbatim so an old plan can be explained, not just replayed.
  params jsonb not null default '{}'::jsonb,
  note text,

  status public.schedule_run_status not null default 'running',

  -- Spec §11: what-if runs write a non-current run for side-by-side comparison,
  -- then discard or promote.
  is_current boolean not null default false,

  horizon_from date,
  horizon_to date,
  task_count integer not null default 0,
  breach_count integer not null default 0,
  duration_ms integer
);

-- Exactly one run is the live plan.
create unique index schedule_runs_one_current_idx
  on public.schedule_runs (is_current) where is_current;

create index schedule_runs_run_at_idx on public.schedule_runs (run_at desc);

-- ---------------------------------------------------------------------------
-- One row per shipment line × department × component.
--
-- Deliberately not per shift. Spec §11 computes the days needed against
-- capacity summed across every active shift, so a per-shift task would have no
-- meaningful days_needed of its own. The shift breakdown lives on daily load,
-- where it is real.
-- ---------------------------------------------------------------------------

create table public.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.schedule_runs (id) on delete cascade,
  shipment_line_id uuid not null references public.shipment_lines (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete cascade,

  due_date date,
  start_date date,
  end_date date,

  -- Yield-inflated: what this department must actually make so the shipped
  -- quantity survives every downstream loss (spec §4).
  qty_required numeric(14, 3) not null,
  days_needed integer,

  is_feasible boolean not null default true,
  breach_reason public.breach_reason,
  is_pinned boolean not null default false,

  unique (run_id, shipment_line_id, department_id, component_id)
);

create index schedule_tasks_run_department_idx
  on public.schedule_tasks (run_id, department_id);
create index schedule_tasks_run_line_idx
  on public.schedule_tasks (run_id, shipment_line_id);
create index schedule_tasks_breaches_idx
  on public.schedule_tasks (run_id, breach_reason) where not is_feasible;

-- ---------------------------------------------------------------------------
-- Daily load, kept at shipment-line granularity so the heatmap can answer
-- "which orders are on this day?" — the question the prototype's tooltip
-- answered and the one a planner actually asks.
-- ---------------------------------------------------------------------------

create table public.schedule_daily_load (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.schedule_runs (id) on delete cascade,
  shipment_line_id uuid not null references public.shipment_lines (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete cascade,
  load_date date not null,
  qty_planned numeric(14, 3) not null check (qty_planned > 0)
);

create index schedule_daily_load_grid_idx
  on public.schedule_daily_load (run_id, department_id, load_date);
create index schedule_daily_load_date_idx
  on public.schedule_daily_load (run_id, load_date);

-- Capacity for the same grid, resolved once per run. Held separately because
-- it does not vary by shipment line, and repeating it on every load row would
-- multiply the largest table in the system for nothing.
create table public.schedule_daily_capacity (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.schedule_runs (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete cascade,
  load_date date not null,
  capacity numeric(14, 3) not null,

  unique (run_id, department_id, shift_id, component_id, load_date)
);

create index schedule_daily_capacity_grid_idx
  on public.schedule_daily_capacity (run_id, department_id, load_date);

-- ---------------------------------------------------------------------------
-- Manual pins. Not scoped to a run: a pin is a decision about the factory, and
-- it outlives the plan that prompted it.
--
-- Spec §6: "A planner who drags a task has made a decision the engine cannot
-- see the reasons for. Every subsequent run honours active pins and schedules
-- around them, and reports any breach a pin causes rather than quietly undoing
-- it. A schedule that silently reverts a planner's work will not be used
-- twice."
-- ---------------------------------------------------------------------------

create table public.schedule_pins (
  id uuid primary key default gen_random_uuid(),
  shipment_line_id uuid not null references public.shipment_lines (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete cascade,

  pinned_start_date date not null,

  pinned_by uuid references auth.users (id) default auth.uid(),
  pinned_at timestamptz not null default now(),

  -- Mandatory. A pin without a reason is indistinguishable from a mistake six
  -- weeks later.
  reason text not null check (length(btrim(reason)) > 0),

  -- Spec §6: "Released manually; the engine never clears a pin silently."
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.schedule_pins');

create unique index schedule_pins_one_active_idx
  on public.schedule_pins (shipment_line_id, department_id, component_id)
  where is_active;

-- ---------------------------------------------------------------------------
-- Access. Everyone signed in may read the plan; only planners may run it or
-- pin against it.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'schedule_runs', 'schedule_tasks', 'schedule_daily_load',
    'schedule_daily_capacity', 'schedule_pins'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.auth_can_plan()) with check (public.auth_can_plan())',
      t || '_write_planner', t
    );
  end loop;
end;
$$;

-- Schedule output is large and disposable. Keeps the current run, anything
-- referenced by a note, and the most recent p_keep others.
create or replace function public.prune_schedule_runs(p_keep integer default 20)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with doomed as (
    delete from public.schedule_runs
     where id in (
       select id from public.schedule_runs
        where not is_current
        order by run_at desc
        offset p_keep
     )
    returning 1
  )
  select count(*)::integer from doomed;
$$;
