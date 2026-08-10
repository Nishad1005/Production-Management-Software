-- Kram — the D-minus matrix, component rates and capacity exceptions.
--
-- Spec §4: "Capacity is per department, per shift, per component. Rev B's
-- central correction. A single '40 a day' figure conceals three separate
-- variables, each of which moves independently."

-- ---------------------------------------------------------------------------
-- D-minus: how many days before stuffing each department must be finished.
-- Spec §4: "held per pair and entered manually".
-- ---------------------------------------------------------------------------

create table public.article_dept_dminus (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,

  -- Null until someone enters it. Spec §3 parameter 2: calendar days.
  dminus_days integer check (dminus_days >= 0),

  -- Spec §5: "False until entered — blocks scheduling for that article."
  is_complete boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  unique (article_id, department_id),

  -- A row cannot claim to be complete while the value is still missing. This is
  -- the guard that stops a blank cell becoming a silent zero, which would
  -- produce an impossible schedule that looks entirely normal on screen.
  constraint article_dept_dminus_complete_has_value
    check (not is_complete or dminus_days is not null)
);
select public.attach_audit('public.article_dept_dminus');

create index article_dept_dminus_incomplete_idx
  on public.article_dept_dminus (article_id) where not is_complete;

-- Spec §4: "Adding a department creates blank rows flagged incomplete rather
-- than defaulting to zero, so a missing value is visible rather than silently
-- producing an impossible schedule." Both directions, so the matrix is never
-- sparse by accident.

create or replace function public.seed_dminus_for_department()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.article_dept_dminus (article_id, department_id)
  select a.id, new.id from public.articles a where a.is_active
  on conflict (article_id, department_id) do nothing;
  return new;
end;
$$;

create or replace function public.seed_dminus_for_article()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.article_dept_dminus (article_id, department_id)
  select new.id, d.id from public.departments d where d.is_active
  on conflict (article_id, department_id) do nothing;
  return new;
end;
$$;

create trigger departments_seed_dminus
  after insert on public.departments
  for each row execute function public.seed_dminus_for_department();

create trigger articles_seed_dminus
  after insert on public.articles
  for each row execute function public.seed_dminus_for_article();

-- ---------------------------------------------------------------------------
-- Component rates. Also the de facto answer to "which departments touch this
-- component?" — the engine derives the route for a component from the rows
-- present here, so a missing rate means the department simply does not handle
-- that component.
-- ---------------------------------------------------------------------------

create table public.component_rates (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.components (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,

  -- Spec §5: "At sanctioned headcount for that shift."
  units_per_day numeric(12, 3) not null check (units_per_day > 0),

  -- Spec §5: "True once derived from actuals rather than estimated." This is
  -- what makes the engine improve — capacity stops being an assertion and
  -- becomes a measurement (spec §13).
  is_measured boolean not null default false,
  measured_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  unique (component_id, department_id, shift_id),
  constraint component_rates_measured_has_timestamp
    check (not is_measured or measured_at is not null)
);
select public.attach_audit('public.component_rates');

create index component_rates_department_component_idx
  on public.component_rates (department_id, component_id);

-- ---------------------------------------------------------------------------
-- Capacity exceptions. A machine breakdown writes one of these for its
-- duration (spec §8), so downtime flows into the schedule automatically rather
-- than living on a separate dashboard.
-- ---------------------------------------------------------------------------

create table public.capacity_overrides (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,

  -- Null means "every component this department makes".
  component_id uuid references public.components (id) on delete cascade,

  from_date date not null,
  to_date date not null,

  -- Zero is meaningful: a department shut for the day.
  units_per_day numeric(12, 3) not null check (units_per_day >= 0),
  reason text not null check (length(btrim(reason)) > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  constraint capacity_overrides_date_order check (to_date >= from_date),

  -- Two overlapping overrides at the same specificity would leave the engine
  -- silently picking one. That is exactly the class of bug that looks normal on
  -- screen, so the database refuses it. A department-wide override and a
  -- component-specific one *may* overlap: they sit at different specificity and
  -- resolve_capacity() below prefers the more specific.
  constraint capacity_overrides_no_overlap exclude using gist (
    department_id with =,
    shift_id with =,
    coalesce(component_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(from_date, to_date, '[]') with &&
  )
);
select public.attach_audit('public.capacity_overrides');

create index capacity_overrides_lookup_idx
  on public.capacity_overrides (department_id, shift_id, from_date, to_date);

-- Effective units/day for one department, shift, component and date.
-- Precedence: component-specific override, then department-wide override, then
-- the standing rate. Null when the department does not make the component.
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
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is not distinct from p_component_id
      limit 1
    ),
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is null
      limit 1
    ),
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
  'Units/day for one department+shift+component+date. Component override beats department override beats standing rate.';
