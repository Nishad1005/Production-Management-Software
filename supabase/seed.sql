-- Kram — placeholder seed.
--
-- Spec §19, Phase 0: "Seeded with a placeholder route the client replaces."
--
-- The route, capacities and D-minus offsets below are the illustrative figures
-- from the capacity-flagging prototype (docs/source/capacity-modules-prototype.html),
-- not U&M's real numbers. The real route is ~7 departments and the real D-minus
-- matrix is manual entry per article × department, which needs a working
-- session with PPC. Everything here is replaceable from the masters screens
-- without a migration — that is the point of departments being a master.

-- ---------------------------------------------------------------------------
-- Shifts. Spec §3 parameter 7 and 8: eight hours net production, five hours
-- overtime ceiling per person per shift.
-- ---------------------------------------------------------------------------

insert into public.shifts (code, name, start_time, end_time, net_production_hours, max_ot_hours)
values
  ('GEN', 'General', '09:00', '18:00', 8, 5),
  ('A',   'Shift A', '06:00', '14:00', 8, 5),
  ('B',   'Shift B', '14:00', '22:00', 8, 5)
on conflict (code) do nothing;

-- Only the General shift is switched on to begin with. Turning on A and B is a
-- masters edit, and the engine picks up the extra capacity on the next run.
update public.shifts set is_active = false where code in ('A', 'B');

-- ---------------------------------------------------------------------------
-- Route. route_position ascending is the order work flows.
-- ---------------------------------------------------------------------------

insert into public.departments (code, name, route_position, yield_pct)
values
  ('WOOD',   'Wood',           10, 98),
  ('FABCUT', 'Fabric cutting', 20, 97),
  ('STITCH', 'Stitching',      30, 98),
  ('ASSY',   'Assembly',       40, 99)
on conflict (code) do nothing;

insert into public.department_shifts (department_id, shift_id, sanctioned_headcount)
select d.id, s.id, v.headcount
  from (values ('WOOD', 10), ('FABCUT', 6), ('STITCH', 12), ('ASSY', 10))
       as v (dept_code, headcount)
  join public.departments d on d.code = v.dept_code
  join public.shifts s on s.code = 'GEN'
on conflict (department_id, shift_id) do nothing;

-- ---------------------------------------------------------------------------
-- One article, six components. Spec §4: departments produce components, not
-- chairs, and the chair is only ready when the scarcest component is.
-- ---------------------------------------------------------------------------

insert into public.articles (code, name, category)
values ('AARA-LC', 'Aara Lounge Chair', 'Lounge seating')
on conflict (code) do nothing;

insert into public.components (code, name, uom)
values
  ('LEG',        'Leg',               'NOS'),
  ('SEAT-FRAME', 'Seat frame',        'NOS'),
  ('BACK-FRAME', 'Back frame',        'NOS'),
  ('FAB-PANEL',  'Cut fabric panel',  'NOS'),
  ('COVER',      'Stitched cover',    'NOS'),
  ('CHAIR',      'Assembled chair',   'NOS')
on conflict (code) do nothing;

insert into public.article_bom (article_id, component_id, qty_per_unit)
select a.id, c.id, v.qty
  from (values ('LEG', 4), ('SEAT-FRAME', 1), ('BACK-FRAME', 1),
               ('FAB-PANEL', 6), ('COVER', 1), ('CHAIR', 1))
       as v (component_code, qty)
  join public.articles a on a.code = 'AARA-LC'
  join public.components c on c.code = v.component_code
on conflict (article_id, component_id) do nothing;

-- ---------------------------------------------------------------------------
-- Which department makes which component, and how fast on the General shift.
-- component_rates is also what tells the engine a department handles a
-- component at all — no row means it does not touch it.
--
-- These are *dedicated* rates: what the department manages in a day with the
-- whole establishment on that one component and nothing else. That is what
-- makes utilisation additive across components (see the planning views), and it
-- is the convention PPC has to enter real figures against.
--
-- Worked through for wood, which is the only department here making more than
-- one thing. A chair needs 4 legs, 1 seat frame and 1 back frame. At the
-- prototype's 40 chairs a day that is 160 + 40 + 40 a day, and it must come to
-- one full day:
--     160/480 + 40/120 + 40/120  =  1/3 + 1/3 + 1/3  =  1.0
-- Entering 160/40/40 instead — the per-day figures rather than the dedicated
-- ones — would have wood asking for three days of work every day, and would
-- have made it look like the factory's bottleneck when stitching is.
-- ---------------------------------------------------------------------------

insert into public.component_rates (component_id, department_id, shift_id, units_per_day)
select c.id, d.id, s.id, v.units_per_day
  from (values
          ('WOOD',   'LEG',        480),
          ('WOOD',   'SEAT-FRAME', 120),
          ('WOOD',   'BACK-FRAME', 120),
          ('FABCUT', 'FAB-PANEL',  360),
          ('STITCH', 'COVER',       30),
          ('ASSY',   'CHAIR',       50)
       ) as v (dept_code, component_code, units_per_day)
  join public.departments d on d.code = v.dept_code
  join public.components c on c.code = v.component_code
  join public.shifts s on s.code = 'GEN'
on conflict (component_id, department_id, shift_id) do nothing;

-- ---------------------------------------------------------------------------
-- D-minus. The rows already exist, blank and incomplete, created by trigger
-- when the article and departments were inserted (spec §4). Filling them in is
-- what makes the article schedulable.
-- ---------------------------------------------------------------------------

update public.article_dept_dminus adm
   set dminus_days = v.dminus, is_complete = true
  from (values ('WOOD', 60), ('FABCUT', 50), ('STITCH', 40), ('ASSY', 25))
       as v (dept_code, dminus)
  join public.departments d on d.code = v.dept_code
 where adm.department_id = d.id
   and adm.article_id = (select id from public.articles where code = 'AARA-LC');

-- ---------------------------------------------------------------------------
-- A couple of holidays, so the calendar is visibly doing something. The full
-- year's list is a masters screen entry, not a migration.
-- ---------------------------------------------------------------------------

insert into public.holidays (holiday_date, description)
values
  ('2026-08-15', 'Independence Day'),
  ('2026-09-14', 'Ganesh Chaturthi'),
  ('2026-10-20', 'Diwali'),
  ('2026-10-21', 'Diwali')
on conflict (holiday_date) do nothing;
