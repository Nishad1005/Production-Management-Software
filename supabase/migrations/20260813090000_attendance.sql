-- Kram — the day rate is variable, so let the floor say what it is.
--
-- U&M's answer to "can you give a dedicated-day rate" was: not one number, it
-- moves — and they gave three reasons at once.
--
--   *It differs by article and we will keep editing it.* Already works: the
--   capacity sheet is editable and every figure reruns the plan.
--
--   *It depends on the day.* Already in the schema, never on a screen.
--   capacity_overrides has been here since Phase 0 with a mandatory reason and
--   a constraint refusing overlaps, and resolve_capacity() already prefers it.
--
--   *It depends on how many people turned up.* This migration.
--
-- The rate stays what it has always been: what the department makes in a day
-- doing nothing else, with the crew that rate was measured on. That crew size
-- is `component_rates.manpower`. Record how many actually came in, and the
-- day's capacity moves in proportion.
--
-- Which finally gives the capacity sheet's "missing manpower" count a job. A
-- rate with no crew size against it cannot be scaled — we do not know what it
-- was measured with — so attendance simply does not apply to it. Reported, not
-- guessed at.

create table public.department_attendance (
  id uuid primary key default gen_random_uuid(),

  department_id uuid not null references public.departments (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  attendance_date date not null,

  -- Zero is meaningful: nobody came in. It is not the same as no entry, which
  -- means nobody has said, and leaves the standing rate alone.
  present integer not null check (present >= 0),
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (department_id, shift_id, attendance_date)
);

create index on public.department_attendance (attendance_date);

select public.attach_audit('public.department_attendance');

comment on table public.department_attendance is
  'How many people a department actually had on a given day and shift. Scales the standing rate in proportion to the crew it was measured with.';

-- ---------------------------------------------------------------------------
-- Access.
--
-- U&M asked for anyone with a role to be able to enter a changed day rate. That
-- is a wide door, and it is theirs to choose — so what makes it defensible is
-- that every row carries who wrote it and when, and an override carries a
-- reason it will not accept as blank. The audit trigger keeps the history.
-- ---------------------------------------------------------------------------
alter table public.department_attendance enable row level security;

create policy department_attendance_select_with_a_role
  on public.department_attendance
  for select to authenticated
  using (public.auth_has_a_role());

create policy department_attendance_write_with_a_role
  on public.department_attendance
  for all to authenticated
  using (public.auth_has_a_role())
  with check (public.auth_has_a_role());

-- Overrides were already planner-only. Widened to match, on the same reasoning.
drop policy if exists capacity_overrides_write_planner on public.capacity_overrides;

create policy capacity_overrides_write_with_a_role
  on public.capacity_overrides
  for all to authenticated
  using (public.auth_has_a_role())
  with check (public.auth_has_a_role());

-- ---------------------------------------------------------------------------
-- Resolving a day's capacity, now in four steps rather than three.
--
-- Order matters and is the point. A figure a person typed for that day beats a
-- figure worked out from attendance, because someone looked at the day and
-- said so — a breakdown, a power cut, a difficult fabric. Attendance beats the
-- standing rate. The standing rate is what is left when nobody has said
-- anything.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_capacity(
  p_department_id uuid,
  p_shift_id uuid,
  p_component_id uuid,
  p_date date
)
returns numeric
language sql
stable
as $$
  select coalesce(
    -- 1. Someone typed a figure for this component on this day.
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is not distinct from p_component_id
      limit 1
    ),
    -- 2. Someone typed a figure for the whole department on this day.
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is null
      limit 1
    ),
    -- 3. The standing rate, in proportion to who came in.
    --
    -- Only where the rate carries the crew it was measured with. Without that
    -- there is no ratio to apply, and inventing one — assuming the sanctioned
    -- headcount, say — would silently move every number on the screen.
    (
      select round(cr.units_per_day * att.present::numeric / cr.manpower, 3)
        from public.component_rates cr
        join public.department_attendance att
          on att.department_id = cr.department_id
         and att.shift_id = cr.shift_id
         and att.attendance_date = p_date
       where cr.department_id = p_department_id
         and cr.shift_id = p_shift_id
         and cr.component_id = p_component_id
         and cr.manpower is not null
         and cr.manpower > 0
    ),
    -- 4. Nobody has said anything.
    (
      select cr.units_per_day
      from public.component_rates cr
      where cr.department_id = p_department_id
        and cr.shift_id = p_shift_id
        and cr.component_id = p_component_id
    )
  );
$$;

comment on function public.resolve_capacity is
  'Units/day for one department+shift+component+date. A typed override beats attendance-scaled capacity, which beats the standing rate.';
