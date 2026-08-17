-- Kram Phase 4 — a shortfall in pieces, said in hours and people.
--
-- docs/PROJECT-LOG.md §1 has claimed since day one that Kram "reports load
-- against capacity, shortfall in hours and people". The first half was true.
-- The second was not, and the client had already written the missing half
-- themselves: capacity-modules-prototype.html, "Module 2 · Overtime and
-- headcount — person-hour conversion". engine-parity.test.ts reproduced Module
-- 1 and stopped there.
--
-- Their arithmetic, verbatim from the prototype:
--
--     uph   = capacity / (headcount × hours)          units per person-hour
--     S     = load − capacity                         shortfall in units
--     otPer = S / (uph × efficiency) / headcount      overtime hours per person
--     heads = ceil(S / (uph × hours))                 people instead of overtime
--     extra = ceil((S − headcount × ceiling × uph × efficiency) / (uph × hours))
--
-- ---------------------------------------------------------------------------
-- Kram cannot use those directly, and the reason matters.
--
-- The prototype gives a department one capacity in units. Kram's departments
-- make several components, and units of legs cannot be added to units of
-- covers — only the fractions of a day they consume can. That is why every
-- planning view aggregates utilisation and never raw quantity. So there is no
-- single "S in units" to put in the numerator.
--
-- Substituting uph = capacity / (headcount × hours) into each formula, the
-- capacity cancels out and every one of them reduces to the overload fraction:
--
--     otPer = (utilisation − 1) × hours / efficiency
--     heads = ceil((utilisation − 1) × headcount)
--     extra = ceil(headcount × ((utilisation − 1) − ceiling × efficiency / hours))
--
-- which is the same arithmetic expressed in the one quantity Kram can add up.
-- For a department making a single component — the prototype's own case — these
-- are identically equal, and engine-parity.test.ts now proves it against the
-- prototype's default scenario rather than taking this comment's word for it.
-- ---------------------------------------------------------------------------

-- An hour of overtime does not produce an hour of output. The prototype makes
-- this an input rather than a constant, and so does this.
alter table public.shifts
  add column if not exists ot_efficiency_pct numeric(5, 2) not null default 85
    check (ot_efficiency_pct > 0 and ot_efficiency_pct <= 100);

comment on column public.shifts.ot_efficiency_pct is
  'What an overtime hour produces against a normal one. The prototype defaults it to 85%.';

create view public.overtime_and_headcount
with (security_invoker = true) as
  with over_days as (
    select dd.run_id, dd.department_id, dd.load_date, dd.utilisation
      from public.schedule_department_day dd
     where dd.status = 'over'
  ),
  -- Utilisation merges a department's shifts, so the crew has to as well.
  -- Person-weighted: with one shift these are exactly that shift's figures,
  -- which is the case the prototype covers and the case U&M runs today. With
  -- two, a mean weighted by who is actually on each is the honest reading of
  -- "hours in the day" for a department as a whole.
  --
  -- Attendance wins over the establishment where it has been recorded, because
  -- resolve_capacity has already scaled the day's capacity by it — costing the
  -- overtime against people who did not come in would quietly overstate how
  -- much the department can absorb.
  crew as (
    select o.run_id,
           o.department_id,
           o.load_date,
           o.utilisation,
           sum(coalesce(att.present, ds.sanctioned_headcount)) as people,
           sum(coalesce(att.present, ds.sanctioned_headcount) * s.net_production_hours)
             / nullif(sum(coalesce(att.present, ds.sanctioned_headcount)), 0) as hours,
           sum(coalesce(att.present, ds.sanctioned_headcount) * s.max_ot_hours)
             / nullif(sum(coalesce(att.present, ds.sanctioned_headcount)), 0) as ot_ceiling,
           sum(coalesce(att.present, ds.sanctioned_headcount) * s.ot_efficiency_pct / 100.0)
             / nullif(sum(coalesce(att.present, ds.sanctioned_headcount)), 0) as efficiency
      from over_days o
      join public.department_shifts ds
        on ds.department_id = o.department_id and ds.is_active
      join public.shifts s on s.id = ds.shift_id and s.is_active
      left join public.department_attendance att
        on att.department_id = o.department_id
       and att.shift_id = ds.shift_id
       and att.attendance_date = o.load_date
     group by o.run_id, o.department_id, o.load_date, o.utilisation
  ),
  figures as (
    select c.*,
           (c.utilisation - 1)::numeric as over_fraction
      from crew c
     -- A department with nobody on the books cannot be given overtime, and
     -- dividing by it would produce infinity rather than a finding.
     where c.people > 0 and c.hours > 0
  )
  select f.run_id,
         d.code                    as department_code,
         d.name                    as department_name,
         d.route_position,
         f.load_date::text         as load_date,
         (f.load_date - current_date)::integer as days_out,
         round(f.utilisation, 4)::float8       as utilisation,
         round(f.over_fraction, 4)::float8     as over_fraction,
         f.people::integer,
         round(f.hours, 2)::float8             as hours,
         round(f.ot_ceiling, 2)::float8        as ot_ceiling,
         round(100 * f.efficiency, 1)::float8  as efficiency_pct,
         -- The three figures the prototype reports.
         round(f.over_fraction * f.hours / f.efficiency, 2)::float8 as ot_hours_per_person,
         ceil(f.over_fraction * f.people)::integer                  as people_instead,
         greatest(
           ceil(f.people * (f.over_fraction - f.ot_ceiling * f.efficiency / f.hours)),
           0
         )::integer as extra_people,
         (f.over_fraction * f.hours / f.efficiency <= f.ot_ceiling) as covered_by_overtime
    from figures f
    join public.departments d on d.id = f.department_id;

comment on view public.overtime_and_headcount is
  'Every flagged department-day as overtime hours per person, or the extra people needed when the ceiling is reached. The prototype''s Module 2, expressed in utilisation because Kram cannot add units of legs to units of covers.';

grant select on public.overtime_and_headcount to authenticated;
