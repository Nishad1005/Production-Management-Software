-- Kram — the working-day calendar.
--
-- Spec §3 parameter 4: six-day working week, Sunday off, plus a holiday
-- calendar. Spec §11: the engine rolls each department's due date back to a
-- working day and then walks backwards a computed number of working days.
--
-- Doing that per task, in a loop, is what turns a schedule run from seconds
-- into minutes at 40,000 tasks. So working days are numbered once, and
-- "N working days earlier" becomes an integer subtraction against an indexed
-- sequence rather than a walk.

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  description text not null check (length(btrim(description)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
select public.attach_audit('public.holidays');

comment on table public.holidays is
  'Declared holidays. Sundays are derived from the week pattern, not listed here (spec §5).';

-- ---------------------------------------------------------------------------

create table public.working_days (
  calendar_date date primary key,
  is_working boolean not null,

  -- Dense 1..n ordering across working days only; null on closed days.
  working_day_seq integer
);

create unique index working_days_seq_idx
  on public.working_days (working_day_seq) where working_day_seq is not null;

comment on table public.working_days is
  'Derived calendar. Never edited by hand — rebuild_working_days() owns every row.';

-- ---------------------------------------------------------------------------

-- Regenerates the calendar over a horizon. Called on holiday changes and
-- whenever the horizon needs extending. Returns the number of working days.
--
-- The weekly off day is Sunday (dow 0). If the factory ever moves to a
-- different pattern, this predicate is the single place it changes.
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

  delete from public.working_days;

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
  'Regenerates working_days over the current (or given) horizon. Returns working-day count.';

-- Holiday changes invalidate the numbering for every later date, so the whole
-- horizon is renumbered. At a few thousand rows this is cheaper than being
-- clever about it.
create or replace function public.holidays_rebuild_calendar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.rebuild_working_days();
  return null;
end;
$$;

create trigger holidays_rebuild_calendar
  after insert or update or delete on public.holidays
  for each statement execute function public.holidays_rebuild_calendar();

-- ---------------------------------------------------------------------------
-- Lookup helpers. Each returns null when the date falls outside the calendar
-- horizon, so a schedule run past the end fails visibly instead of quietly
-- producing wrong dates.
-- ---------------------------------------------------------------------------

create or replace function public.prev_working_day(p_date date)
returns date
language sql
stable
as $$
  -- The existence guard matters more than it looks. Without it a date past the
  -- end of the horizon quietly returns the last working day in the calendar,
  -- so a schedule running off the end of the horizon produces plausible dates
  -- that are years wrong. Outside the calendar there is no answer, and saying
  -- so is the only safe behaviour.
  select case
    when not exists (
      select 1 from public.working_days w where w.calendar_date = p_date
    ) then null
    else (
      select max(w.calendar_date)
        from public.working_days w
       where w.is_working and w.calendar_date <= p_date
    )
  end;
$$;

comment on function public.prev_working_day is
  'The date itself if it is a working day, else the working day before it (spec §11 roll_back_to_working_day).';

-- The mirror of prev_working_day, and the right one for a *start* date: a task
-- pinned to a Sunday begins on the Monday, not the Saturday before.
create or replace function public.next_working_day(p_date date)
returns date
language sql
stable
as $$
  select case
    when not exists (
      select 1 from public.working_days w where w.calendar_date = p_date
    ) then null
    else (
      select min(w.calendar_date)
        from public.working_days w
       where w.is_working and w.calendar_date >= p_date
    )
  end;
$$;

create or replace function public.subtract_working_days(p_date date, p_days integer)
returns date
language sql
stable
as $$
  with anchor as (
    select working_day_seq as seq
      from public.working_days
     where calendar_date = public.prev_working_day(p_date)
  )
  select w.calendar_date
    from public.working_days w, anchor
   where w.working_day_seq = anchor.seq - p_days;
$$;

comment on function public.subtract_working_days is
  'Rolls back p_days working days from the working day on or before p_date. 0 returns prev_working_day.';

create or replace function public.working_days_between(p_from date, p_to date)
returns integer
language sql
stable
as $$
  select count(*)::integer
    from public.working_days
   where is_working and calendar_date between p_from and p_to;
$$;

comment on function public.working_days_between is
  'Inclusive count of working days. Used for the runway feasibility check (spec §11).';

-- Build the calendar now, so a freshly migrated database can schedule
-- immediately rather than returning null dates until someone remembers to.
-- Default horizon is three years either side of today.
select public.rebuild_working_days();
