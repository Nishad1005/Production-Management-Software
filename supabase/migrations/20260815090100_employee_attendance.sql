-- Kram Phase 4 — who was actually there, and who stayed late.
--
-- `employees` has sat in the schema since Phase 0 with nothing referencing it
-- but RLS policies. Its own header says why it landed early and what it was
-- waiting for: "Attendance, leave and overtime are Phase 4… per-employee
-- attendance is what skill mix and 'four skilled carpenters on leave tomorrow'
-- require, but it is more entry than aggregate head counts."
--
-- U&M have now chosen that entry, and chosen to record overtime **worked**
-- rather than only overtime the plan would need.

create type public.attendance_status as enum ('present', 'absent', 'leave');

create table public.employee_attendance (
  id uuid primary key default gen_random_uuid(),

  employee_id uuid not null references public.employees (id) on delete cascade,
  attendance_date date not null,
  shift_id uuid not null references public.shifts (id),

  status public.attendance_status not null default 'present',

  -- Hours actually worked beyond the shift, not hours the plan asked for.
  -- overtime_and_headcount says what would close a gap; this says what happened.
  ot_hours numeric(4, 2) not null default 0 check (ot_hours >= 0),
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  -- One record per person per day. A second shift for the same person on the
  -- same day is a real thing but not one U&M has asked for, and allowing it
  -- would let the headcount below double-count somebody.
  unique (employee_id, attendance_date)
);

create index on public.employee_attendance (attendance_date);

select public.attach_audit('public.employee_attendance');

comment on table public.employee_attendance is
  'Per person per day: in, out, on leave, and overtime worked. The department head count that drives capacity is derived from these where they exist.';

alter table public.employee_attendance enable row level security;

create policy employee_attendance_select_with_a_role
  on public.employee_attendance
  for select to authenticated using (public.auth_has_a_role());

-- Same door U&M chose for department attendance, and defensible for the same
-- reason: every row carries who wrote it and when.
create policy employee_attendance_write_with_a_role
  on public.employee_attendance
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

-- ---------------------------------------------------------------------------
-- Writing one person's day, and keeping the department count honest.
--
-- resolve_capacity reads department_attendance and nothing else. Two ways to
-- say how many people were in is exactly how a number ends up wrong on screen
-- while looking entirely normal — so marking individuals *derives* the
-- department figure through the same set_attendance() the count screen uses.
-- One input to capacity, two ways to arrive at it.
-- ---------------------------------------------------------------------------
create or replace function public.set_employee_attendance(
  p_emp_code text,
  p_date date,
  p_status public.attendance_status,
  p_ot_hours numeric default 0,
  p_note text default null
)
returns void
language plpgsql
as $$
declare
  v_employee uuid;
  v_department uuid;
  v_shift uuid;
  v_department_code text;
  v_shift_code text;
  v_present integer;
begin
  select e.id, e.department_id, e.default_shift_id
    into v_employee, v_department, v_shift
    from public.employees e
   where e.emp_code = p_emp_code and e.is_active;

  if v_employee is null then
    raise exception 'unknown or inactive employee %', p_emp_code;
  end if;
  if v_department is null or v_shift is null then
    raise exception
      'employee % has no department or shift, so their day cannot be counted anywhere',
      p_emp_code;
  end if;

  insert into public.employee_attendance
    (employee_id, attendance_date, shift_id, status, ot_hours, note)
  values (v_employee, p_date, v_shift, p_status, coalesce(p_ot_hours, 0), p_note)
  on conflict (employee_id, attendance_date)
  do update set shift_id = excluded.shift_id,
                status = excluded.status,
                ot_hours = excluded.ot_hours,
                note = excluded.note;

  select count(*) into v_present
    from public.employee_attendance ea
    join public.employees e on e.id = ea.employee_id
   where e.department_id = v_department
     and ea.shift_id = v_shift
     and ea.attendance_date = p_date
     and ea.status = 'present';

  select d.code, s.code into v_department_code, v_shift_code
    from public.departments d, public.shifts s
   where d.id = v_department and s.id = v_shift;

  perform public.set_attendance(v_department_code, v_shift_code, p_date, v_present);
end;
$$;

revoke execute on function public.set_employee_attendance(
  text, date, public.attendance_status, numeric, text) from public, anon;
grant execute on function public.set_employee_attendance(
  text, date, public.attendance_status, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The masters and the deployment chart.
-- ---------------------------------------------------------------------------
create view public.employee_list
with (security_invoker = true) as
  select e.id,
         e.emp_code,
         e.name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         s.code as shift_code,
         e.skill_level::text as skill_level,
         e.employment_type::text as employment_type,
         e.is_active
    from public.employees e
    left join public.departments d on d.id = e.department_id
    left join public.shifts s on s.id = e.default_shift_id;

grant select on public.employee_list to authenticated;

-- Every active person with whatever has been said about a given day. Left
-- joined from employees so somebody nobody has marked still appears — an
-- unrecorded person is the one a supervisor needs to chase, and an inner join
-- would hide exactly them.
create view public.employee_day
with (security_invoker = true) as
  select e.emp_code,
         e.name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         s.code as shift_code,
         e.skill_level::text as skill_level,
         ea.attendance_date::text as attendance_date,
         coalesce(ea.status::text, 'unrecorded') as status,
         coalesce(ea.ot_hours, 0)::float8 as ot_hours,
         ea.note
    from public.employees e
    join public.departments d on d.id = e.department_id
    join public.shifts s on s.id = e.default_shift_id
    left join public.employee_attendance ea on ea.employee_id = e.id
   where e.is_active;

grant select on public.employee_day to authenticated;

create or replace function public.set_employee(
  p_emp_code text,
  p_name text,
  p_department_code text default null,
  p_shift_code text default null,
  p_skill_level public.skill_level default 'semi_skilled',
  p_employment_type public.employment_type default 'permanent'
)
returns uuid
language sql
as $$
  insert into public.employees
    (emp_code, name, department_id, default_shift_id, skill_level, employment_type)
  values (
    p_emp_code, p_name,
    (select id from public.departments where code = p_department_code),
    (select id from public.shifts where code = p_shift_code),
    p_skill_level, p_employment_type
  )
  on conflict (emp_code) do update
    set name = excluded.name,
        department_id = coalesce(excluded.department_id, public.employees.department_id),
        default_shift_id = coalesce(excluded.default_shift_id, public.employees.default_shift_id),
        skill_level = excluded.skill_level,
        employment_type = excluded.employment_type,
        is_active = true
  returning id;
$$;

revoke execute on function public.set_employee(
  text, text, text, text, public.skill_level, public.employment_type)
  from public, anon;
grant execute on function public.set_employee(
  text, text, text, text, public.skill_level, public.employment_type)
  to authenticated;

create or replace function public.set_employee_active(p_emp_code text, p_is_active boolean)
returns void
language sql
as $$
  -- Soft delete only, as everywhere else: somebody with attendance history
  -- keeps it.
  update public.employees set is_active = p_is_active where emp_code = p_emp_code;
$$;

revoke execute on function public.set_employee_active(text, boolean) from public, anon;
grant execute on function public.set_employee_active(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- A department's day, in people.
--
-- department_day already carries the establishment and the head count; this
-- adds what the individual records say — who is out, who is on leave, who is
-- unrecorded, and the overtime actually worked. Left joined from
-- department_shifts so a department nobody has marked still appears.
-- ---------------------------------------------------------------------------
create view public.department_manpower_day
with (security_invoker = true) as
  select d.code                as department_code,
         d.name                as department_name,
         d.route_position,
         s.code                as shift_code,
         ds.sanctioned_headcount as sanctioned,
         ea.attendance_date::text as attendance_date,
         count(*) filter (where ea.status = 'present')::integer as present,
         count(*) filter (where ea.status = 'absent')::integer  as absent,
         count(*) filter (where ea.status = 'leave')::integer   as on_leave,
         coalesce(sum(ea.ot_hours), 0)::float8 as ot_hours,
         count(*) filter (where ea.ot_hours > 0)::integer as people_on_ot,
         -- On the books but not spoken for. The figure a supervisor chases.
         (ds.sanctioned_headcount - count(*))::integer as unrecorded
    from public.departments d
    join public.department_shifts ds on ds.department_id = d.id and ds.is_active
    join public.shifts s on s.id = ds.shift_id and s.is_active
    left join public.employees e
      on e.department_id = d.id and e.default_shift_id = s.id and e.is_active
    left join public.employee_attendance ea on ea.employee_id = e.id
   where d.is_active
   group by d.code, d.name, d.route_position, s.code,
            ds.sanctioned_headcount, ea.attendance_date;

comment on view public.department_manpower_day is
  'Per department, shift and day: establishment, in, out, on leave, unrecorded, and overtime actually worked.';

grant select on public.department_manpower_day to authenticated;
