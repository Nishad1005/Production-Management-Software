-- Kram — Who is in shows a day the department entered as a number.
--
-- ---------------------------------------------------------------------------
-- department_manpower_day was built from the roster alone: a (department,
-- shift, day) appeared on Manpower's "Who is in" only when somebody had been
-- marked in or out person by person. A head count and overtime typed on
-- Production — the same fact, the guide says, and the figure the plan uses —
-- left the day blank there, and the demo week's day 3 found it: Stitching
-- said "12 in · 12 overtime hours · 108 man-hours" on Production and nothing
-- on Manpower.
--
-- Now a day appears when either the roster or the department's own entry
-- has it. The head count is the department's figure (the plan's), falling
-- back to the roster's count; out, on leave, the per-person overtime and
-- "not marked" are the roster's and read zero for a day entered as a total;
-- the department's overtime person-hours and the man-hours come from the
-- department entry, as they did since 15 Oct. Same columns, appended none,
-- so the client and the floor display read it unchanged.
-- ---------------------------------------------------------------------------

create or replace view public.department_manpower_day
with (security_invoker = true) as
  with roster as (
    select e.department_id,
           e.default_shift_id as shift_id,
           ea.attendance_date,
           count(*) filter (where ea.status = 'present')::integer as present,
           count(*) filter (where ea.status = 'absent')::integer  as absent,
           count(*) filter (where ea.status = 'leave')::integer   as on_leave,
           coalesce(sum(ea.ot_hours), 0)::float8                 as ot_hours,
           count(*) filter (where ea.ot_hours > 0)::integer       as people_on_ot,
           count(*)::integer                                      as marked
      from public.employees e
      join public.employee_attendance ea on ea.employee_id = e.id
     where e.is_active
       and e.department_id is not null
       and e.default_shift_id is not null
     group by e.department_id, e.default_shift_id, ea.attendance_date
  ),
  days as (
    select department_id, shift_id, attendance_date from roster
    union
    select department_id, shift_id, attendance_date from public.department_attendance
  )
  select d.code                     as department_code,
         d.name                     as department_name,
         d.route_position,
         s.code                     as shift_code,
         ds.sanctioned_headcount    as sanctioned,
         x.attendance_date::text    as attendance_date,
         coalesce(da.present, r.present, 0)::integer as present,
         coalesce(r.absent, 0)::integer              as absent,
         coalesce(r.on_leave, 0)::integer            as on_leave,
         coalesce(r.ot_hours, 0)::float8             as ot_hours,
         coalesce(r.people_on_ot, 0)::integer        as people_on_ot,
         -- On the books but not spoken for, person by person. A day entered
         -- as a total has nobody unmarked: the department said who came in.
         case when r.marked is not null
              then (ds.sanctioned_headcount - r.marked)
              else 0 end::integer                    as unrecorded,
         coalesce(da.ot_person_hours, 0)::float8     as ot_person_hours,
         (coalesce(da.present, r.present, 0) * s.net_production_hours
            + coalesce(da.ot_person_hours, 0))::float8 as man_hours
    from days x
    join public.departments d
      on d.id = x.department_id and d.is_active
    join public.department_shifts ds
      on ds.department_id = x.department_id and ds.shift_id = x.shift_id and ds.is_active
    join public.shifts s
      on s.id = x.shift_id and s.is_active
    left join roster r
      on r.department_id = x.department_id
     and r.shift_id = x.shift_id
     and r.attendance_date = x.attendance_date
    left join public.department_attendance da
      on da.department_id = x.department_id
     and da.shift_id = x.shift_id
     and da.attendance_date = x.attendance_date;

comment on view public.department_manpower_day is
  'Per department, shift and day with an entry — from the roster or typed as a total: establishment, in, out, on leave, unrecorded, overtime worked per person, the department''s overtime person-hours, and man-hours.';

grant select on public.department_manpower_day to authenticated;

-- ---------------------------------------------------------------------------
-- And the behind card's key carries the shipment line.
-- ---------------------------------------------------------------------------
create or replace view public.attention_behind
with (security_invoker = true) as
  with behind as (
    select o.erp_order_no,
           sl.line_no,
           d.code as department_code,
           c.code as component_code,
           t.department_id,
           t.component_id,
           t.qty_required,
           coalesce(t.qty_done, 0) as qty_done,
           coalesce(t.qty_remaining, t.qty_required) as qty_remaining,
           t.due_date,
           t.start_date,
           o.accepted_against_plan,
           o.acceptance_note,
           (sl.stuffing_date - current_date)::integer as days_out,
           (select count(*) from public.working_days w
             where w.is_working
               and w.calendar_date between greatest(current_date, t.start_date)
                                       and t.due_date) as days_left
      from public.schedule_tasks t
      join public.shipment_lines sl on sl.id = t.shipment_line_id
      join public.orders o on o.id = sl.order_id
      join public.departments d on d.id = t.department_id
      join public.components c on c.id = t.component_id
     where t.run_id = public.current_run_id()
       and t.breach_reason = 'late'
  ),
  rate as (
    select department_id, component_id,
           sum(capacity) / count(distinct load_date) as per_day
      from public.schedule_daily_capacity
     where run_id = public.current_run_id()
       and load_date >= current_date
     group by department_id, component_id
  )
  select 'behind' as kind,
         case when b.days_out < 15 then 'critical' else 'warning' end as severity,
         b.department_code || ' is behind on ' || b.erp_order_no as title,
         round(b.qty_done)::text || ' of ' || round(b.qty_required)::text || ' made · '
           || case when b.due_date < current_date
                   then 'the date has passed · ' || round(b.qty_remaining)::text || ' still to make'
                   when b.start_date > b.due_date
                   then 'cannot start before ' || b.start_date::text
                        || ', which is past its date · ' || round(b.qty_remaining)::text || ' still to make'
                   when b.days_left > 0
                   then 'needs ' || ceil(b.qty_remaining / b.days_left)::text
                        || ' a day from '
                        || case when b.start_date > current_date then b.start_date::text else 'today' end
                        || ' against ' || coalesce(round(r.per_day)::text, '?')
                   else 'no working day left before its date · ' || round(b.qty_remaining)::text || ' still to make'
              end
           || ' · due ' || b.due_date::text
           -- The card says it was a decision, as attention_breach's does.
           || case when b.accepted_against_plan
                   then ' · taken against the plan: ' || coalesce(b.acceptance_note, '')
                   else '' end as detail,
         '/gantt' as route,
         -- The line is in the key: an order in two containers, late at the same
         -- department, is two cards, and React wants two keys (found by the
         -- demo week, 15 Oct: 63 console errors on Attention).
         'behind:' || b.erp_order_no || ':' || b.line_no::text || ':' || b.department_code || ':' || b.component_code as key,
         b.days_out as days_out
    from behind b
    left join rate r
      on r.department_id = b.department_id
     and r.component_id = b.component_id;

comment on view public.attention_behind is
  'Jobs re-planned from today that still miss their date: what was made, what remains, and the rate needed from the day the department can start against the rate available.';

grant select on public.attention_behind to authenticated;
