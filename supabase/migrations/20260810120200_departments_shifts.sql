-- Kram — the production route and the shift pattern running on it.
--
-- Spec §3 parameter 16: departments are a user-configurable master, not
-- hardcoded. Spec §2: the multi-shift model is Rev B's structural correction —
-- "A department running two shifts has roughly double the daily capacity, the
-- overtime ceiling applies per person per shift rather than per day, and
-- attendance is recorded per shift."

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  route_position integer not null,

  -- Spec §4: losses multiply along the route. Held as a percentage so the
  -- masters screen reads the way the floor talks about it.
  yield_pct numeric(6, 3) not null default 100
    check (yield_pct > 0 and yield_pct <= 100),
  buffer_pct numeric(6, 3) not null default 0
    check (buffer_pct >= 0 and buffer_pct < 100),

  -- Spec §5: "Soft delete — never hard-delete one with history."
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  -- Deferrable so a planner can reorder the route inside one transaction
  -- without tripping over an intermediate collision. Inactive departments keep
  -- their slot, which is what you want when reading back an old schedule run.
  constraint departments_route_position_key
    unique (route_position) deferrable initially deferred
);

select public.attach_audit('public.departments');

comment on column public.departments.route_position is
  'Integer ordering along the route. Lower runs earlier; the engine walks these ascending.';
comment on column public.departments.yield_pct is
  'Planned good output as a percentage. Compounds backwards across all downstream departments.';

alter table public.profiles
  add constraint profiles_department_id_fkey
  foreign key (department_id) references public.departments (id) on delete set null;

-- ---------------------------------------------------------------------------

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  start_time time not null,
  end_time time not null,

  -- Spec §3 parameter 7: eight hours *net production time*, excluding breaks,
  -- setup and cleanup. Capacity maths uses this, never the clock span.
  net_production_hours numeric(4, 2) not null default 8
    check (net_production_hours > 0 and net_production_hours <= 24),

  -- Spec §3 parameter 8, and the compliance note beside it: the ceiling is per
  -- person per shift, and it is configurable precisely because five hours on
  -- top of an eight-hour net shift is a long day under the Factories Act.
  max_ot_hours numeric(4, 2) not null default 5
    check (max_ot_hours >= 0 and max_ot_hours <= 12),

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

select public.attach_audit('public.shifts');

-- Deliberately no check that end_time > start_time: a night shift running
-- 22:00–06:00 is normal and legal here.
comment on table public.shifts is
  'A, B and General. Shifts may cross midnight, so end_time < start_time is valid.';

-- ---------------------------------------------------------------------------

create table public.department_shifts (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete restrict,
  shift_id uuid not null references public.shifts (id) on delete restrict,

  sanctioned_headcount integer not null default 0
    check (sanctioned_headcount >= 0),

  -- Spec §5: "A shift can be switched off without losing history."
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  unique (department_id, shift_id)
);

select public.attach_audit('public.department_shifts');

create index department_shifts_department_id_idx
  on public.department_shifts (department_id) where is_active;

comment on column public.department_shifts.sanctioned_headcount is
  'Establishment for this department on this shift. The denominator in units_per_person_hour (spec §13).';
