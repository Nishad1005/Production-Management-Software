-- Kram — the API for today's capacity.

-- ---------------------------------------------------------------------------
-- What a department's day looks like: who is meant to be in, who is, and
-- whether anyone has overruled the figure outright.
--
-- One row per department, shift and date that has anything to say. Left joins
-- from department_shifts so a department with nothing recorded still appears —
-- "nobody has said" is a state worth seeing, and an inner join would hide
-- exactly the departments someone needs to chase.
-- ---------------------------------------------------------------------------
create view public.department_day
with (security_invoker = true) as
  select d.code                       as department_code,
         d.name                       as department_name,
         d.route_position,
         s.code                       as shift_code,
         ds.sanctioned_headcount      as sanctioned,
         att.present,
         att.note                     as attendance_note,
         att.attendance_date::text    as attendance_date,
         co.units_per_day::float8     as override_units,
         co.reason                    as override_reason,
         co.from_date::text           as override_from,
         co.to_date::text             as override_to,
         -- Null rather than a number when there is nothing to divide by: a
         -- department with no establishment recorded is not at 0%.
         case when ds.sanctioned_headcount > 0 and att.present is not null
              then round(att.present::numeric / ds.sanctioned_headcount, 4)::float8
         end as attendance_fraction,
         -- How many of this department's rates can actually be scaled. A rate
         -- with no crew size against it is untouched by attendance, and if that
         -- is most of them the figure on screen is quieter than it looks.
         (select count(*) from public.component_rates cr
           where cr.department_id = d.id and cr.shift_id = s.id) as rates,
         (select count(*) from public.component_rates cr
           where cr.department_id = d.id and cr.shift_id = s.id
             and cr.manpower is not null and cr.manpower > 0) as rates_with_crew
    from public.departments d
    join public.department_shifts ds on ds.department_id = d.id and ds.is_active
    join public.shifts s on s.id = ds.shift_id and s.is_active
    left join public.department_attendance att
      on att.department_id = d.id and att.shift_id = s.id
    left join public.capacity_overrides co
      on co.department_id = d.id
     and co.shift_id = s.id
     and co.component_id is null
     and att.attendance_date between co.from_date and co.to_date
   where d.is_active;

comment on view public.department_day is
  'Per department, shift and day: establishment, who turned up, and any typed override of the day''s capacity.';

grant select on public.department_day to authenticated;

-- ---------------------------------------------------------------------------
-- Writes.
-- ---------------------------------------------------------------------------

-- Upsert, so entering it twice corrects rather than fails.
create or replace function public.set_attendance(
  p_department_code text,
  p_shift_code text,
  p_date date,
  p_present integer,
  p_note text default null
)
returns void
language plpgsql
as $$
declare
  v_department uuid;
  v_shift uuid;
begin
  select id into v_department from public.departments where code = p_department_code;
  select id into v_shift from public.shifts where code = p_shift_code;

  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;
  if v_shift is null then
    raise exception 'unknown shift %', p_shift_code;
  end if;

  -- Null clears the entry, which is not the same as entering zero. Zero says
  -- nobody came in and drops the day's capacity to nothing; clearing says
  -- nobody has recorded it, and hands the day back to the standing rate.
  if p_present is null then
    delete from public.department_attendance
     where department_id = v_department
       and shift_id = v_shift
       and attendance_date = p_date;
    return;
  end if;

  insert into public.department_attendance
    (department_id, shift_id, attendance_date, present, note)
  values (v_department, v_shift, p_date, p_present, p_note)
  on conflict (department_id, shift_id, attendance_date)
  do update set present = excluded.present, note = excluded.note;
end;
$$;

revoke execute on function
  public.set_attendance(text, text, date, integer, text) from public, anon;
grant execute on function
  public.set_attendance(text, text, date, integer, text) to authenticated;

-- One day at a time, which is the case this exists for: a breakdown, a power
-- cut, a fabric nobody can sew at the usual pace. A longer shutdown is the same
-- function called across a range, and the overlap constraint on the table is
-- what stops two of them quietly disagreeing.
create or replace function public.set_day_capacity(
  p_department_code text,
  p_shift_code text,
  p_date date,
  p_units numeric,
  p_reason text default null
)
returns void
language plpgsql
as $$
declare
  v_department uuid;
  v_shift uuid;
begin
  select id into v_department from public.departments where code = p_department_code;
  select id into v_shift from public.shifts where code = p_shift_code;

  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;
  if v_shift is null then
    raise exception 'unknown shift %', p_shift_code;
  end if;

  if p_units is null then
    delete from public.capacity_overrides
     where department_id = v_department
       and shift_id = v_shift
       and component_id is null
       and from_date = p_date
       and to_date = p_date;
    return;
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'an override needs a reason';
  end if;

  -- Clear this one day first. Without it the exclusion constraint refuses the
  -- insert against the row already covering the day, and a correction would
  -- look like a failure.
  delete from public.capacity_overrides
   where department_id = v_department
     and shift_id = v_shift
     and component_id is null
     and from_date = p_date
     and to_date = p_date;

  insert into public.capacity_overrides
    (department_id, shift_id, component_id, from_date, to_date, units_per_day, reason)
  values (v_department, v_shift, null, p_date, p_date, p_units, p_reason);
end;
$$;

revoke execute on function
  public.set_day_capacity(text, text, date, numeric, text) from public, anon;
grant execute on function
  public.set_day_capacity(text, text, date, numeric, text) to authenticated;
