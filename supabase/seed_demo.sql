-- Kram — demonstration data, on U&M's own factory.
--
-- Applied on top of seed.sql in the offline build only. `supabase db reset`
-- picks up seed.sql by name and leaves this alone, so a real project never gets
-- fictional orders by accident, and the hosted database has never seen it.
--
-- seed.sql stays exactly as it is. Its four-department line is the fixture
-- `tests/engine-parity.test.ts` reproduces against the client's own prototype,
-- and that is the most valuable test in the project. This file parks those four
-- departments and lays U&M's fourteen over the top — the same thing
-- scripts/import-capacity-sheet.mjs does to the live database.
--
-- ===========================================================================
--  EVERY CAPACITY FIGURE AND EVERY ORDER BELOW IS INVENTED.
--
--  The department names, their dependencies and the article codes are real —
--  taken from U&M's capacity sheet and the structure PPC confirmed. The rates,
--  the yields, the D-minus offsets, the customers and the order book are not.
--  They are chosen so the screens have something to say. The header badge reads
--  "Offline draft" for this reason, and the rates carry the ESTIMATED tag.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Park the placeholder route. route_position is unique, and seed.sql occupies
-- exactly the numbers the real route wants.
-- ---------------------------------------------------------------------------
update public.departments
   set is_active = false, route_position = 900 + route_position
 where code in ('WOOD', 'FABCUT', 'STITCH', 'ASSY');

update public.articles set is_active = false where code = 'AARA-LC';

-- seed.sql wires its four departments into a single line. Parking them is not
-- enough, because two of its codes — STITCH and ASSY — are U&M's own, so those
-- rows are reused below rather than replaced and their edges survive. One of
-- them is `ASSY depends on STITCH`, which would leave Assembly waiting for
-- Stitching: backwards, and the sort of thing that reads as a real finding on
-- the capacity sheet during a demonstration.
--
-- Removed before the real graph goes in, so at this point these are the only
-- three edges that exist.
delete from public.department_dependencies dd
 using public.departments d, public.departments f
 where dd.department_id = d.id
   and dd.depends_on_department_id = f.id
   and (d.code in ('WOOD', 'FABCUT', 'STITCH', 'ASSY')
     or f.code in ('WOOD', 'FABCUT', 'STITCH', 'ASSY'));

-- ---------------------------------------------------------------------------
-- The route. Position orders the display; department_dependencies below is what
-- the engine walks.
--
-- Yields vary because they do: finishing and stitching lose more than packing.
-- It also gives Production's measured-yield view something to disagree with.
-- ---------------------------------------------------------------------------
insert into public.departments (code, name, route_position, yield_pct)
values
  ('PLYCUT',   'Ply Cutting',          10,  98),
  ('MACHINE',  'Machining',            20,  98),
  ('ASSY',     'Assembly',             30,  97),
  ('SAND',     'Sanding',              40,  99),
  ('WOODFIN',  'Wood Finishing',       50,  96),
  ('METALFIN', 'Metal Finishing',      60,  98),
  ('FOAM',     'Foam Pasting',         70,  99),
  ('FIBER',    'Fiber Processing',     80,  99),
  ('CUT',      'Cutting',              90,  97),
  ('STITCH',   'Stitching',           100,  96),
  ('STAPLE',   'Stapling',            110,  98),
  ('FIT',      'Fitting',             120,  99),
  ('QC',       'Final QC inspection', 130,  99),
  ('PACK',     'Final Packing',       140, 100)
on conflict (code) do update
  set name = excluded.name,
      route_position = excluded.route_position,
      yield_pct = excluded.yield_pct,
      is_active = true;

-- What feeds what, as PPC confirmed it: four entry points and three streams —
-- frame, fabric and metal — converging at stitching, stapling and fitting.
insert into public.department_dependencies (department_id, depends_on_department_id)
select d.id, f.id
  from (values
    ('ASSY',     'PLYCUT'),
    ('ASSY',     'MACHINE'),
    ('SAND',     'ASSY'),
    ('WOODFIN',  'SAND'),
    ('FOAM',     'WOODFIN'),
    ('METALFIN', 'MACHINE'),
    ('STITCH',   'CUT'),
    ('STITCH',   'FIBER'),
    ('STAPLE',   'FOAM'),
    ('STAPLE',   'STITCH'),
    ('FIT',      'STAPLE'),
    ('FIT',      'METALFIN'),
    ('QC',       'FIT'),
    ('PACK',     'QC')
  ) as v (dept_code, feeder_code)
  join public.departments d on d.code = v.dept_code
  join public.departments f on f.code = v.feeder_code
on conflict do nothing;

insert into public.department_shifts (department_id, shift_id, sanctioned_headcount)
select d.id, s.id, v.headcount
  from (values
    ('PLYCUT', 8), ('MACHINE', 10), ('ASSY', 14), ('SAND', 6),
    ('WOODFIN', 9), ('METALFIN', 5), ('FOAM', 7), ('FIBER', 4),
    ('CUT', 6), ('STITCH', 22), ('STAPLE', 16), ('FIT', 12),
    ('QC', 4), ('PACK', 6)
  ) as v (dept_code, headcount)
  join public.departments d on d.code = v.dept_code
  join public.shifts s on s.code = 'GEN'
on conflict (department_id, shift_id) do nothing;

-- ---------------------------------------------------------------------------
-- Six articles, codes and names as they appear in U&M's capacity sheet.
-- ---------------------------------------------------------------------------
insert into public.articles (code, name, category)
values
  ('125034299',      'Boden Dining Chair — Smokey Taupe',      'Dining'),
  ('125034308',      'Boden Barstool — Smokey Taupe',          'Barstool'),
  ('UD354 SPPL WAL', 'Betsy Chair — Specter Pearl',            'Dining'),
  ('UT263 SPWL COU', 'Betsy Counter Stool — Specter Pearl',    'Barstool'),
  ('UO265 DEN VBR',  'Lucaya Ottoman — Denby Flax',            'Ottoman'),
  ('DL25107',        'Mable Chair',                            'Lounge')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Which departments each article actually passes through.
--
-- Not all fourteen, which is the point. A dining chair has no metalwork; an
-- ottoman is fully upholstered so nothing it contains is ever sanded or
-- lacquered. This is what makes the capacity sheet look like a real one — and
-- it exercises the rule that a component is inflated only for the losses of the
-- departments its own material passes through.
--
-- The ottoman is the instructive case. Foam Pasting normally waits for Wood
-- Finishing, which the ottoman skips entirely, so the engine walks back through
-- the graph and holds it behind Assembly instead.
-- ---------------------------------------------------------------------------
create temp table _route as
  select a.id   as article_id,
         a.code as article_code,
         d.id   as department_id,
         d.code as department_code,
         d.route_position
    from public.articles a
    cross join public.departments d
   where a.is_active and d.is_active
     and a.code in ('125034299', '125034308', 'UD354 SPPL WAL',
                    'UT263 SPWL COU', 'UO265 DEN VBR', 'DL25107')
     and not exists (
       select 1
         from (values
           -- No metalwork in a dining chair.
           ('125034299', 'MACHINE'), ('125034299', 'METALFIN'),
           ('UD354 SPPL WAL', 'MACHINE'), ('UD354 SPPL WAL', 'METALFIN'),
           -- Fully upholstered: no exposed timber to sand or finish, and no
           -- metal at all.
           ('UO265 DEN VBR', 'MACHINE'), ('UO265 DEN VBR', 'METALFIN'),
           ('UO265 DEN VBR', 'SAND'),    ('UO265 DEN VBR', 'WOODFIN')
         ) as skip (article_code, department_code)
        where skip.article_code = a.code and skip.department_code = d.code
     );

-- One stage component per article per department, named the way
-- set_capacity_cell() writes them, so the demo and a real capacity sheet agree.
insert into public.components (code, name)
select r.article_code || '::' || r.department_code,
       r.department_code || ' work on ' || r.article_code
  from _route r
on conflict (code) do nothing;

insert into public.article_bom (article_id, component_id, qty_per_unit)
select r.article_id, c.id, 1
  from _route r
  join public.components c on c.code = r.article_code || '::' || r.department_code
on conflict (article_id, component_id) do nothing;

-- ---------------------------------------------------------------------------
-- Rates — INVENTED. Dedicated figures: what the department manages in a day
-- with the whole establishment on that one thing and nothing else, which is the
-- convention that makes utilisation additive and the one PPC has to enter real
-- numbers against.
--
-- Stitching is deliberately the tightest at 38 a day. It is what makes the
-- bottleneck view say something, and it is a plausible shape for upholstery —
-- machines and trained operators, against benches that can absorb more.
--
-- The rest are generous on purpose. A shipment line can never be larger than
-- the tightest D-minus window it passes through multiplied by that department's
-- rate, and if any window is narrow then the answer to "can we take this order"
-- stops depending on the date at all — which is exactly the thing the
-- acceptance screen exists to show.
-- ---------------------------------------------------------------------------
insert into public.component_rates
  (component_id, department_id, shift_id, units_per_day, manpower)
select c.id, r.department_id, s.id, v.units_per_day, v.crew
  from _route r
  join public.components c on c.code = r.article_code || '::' || r.department_code
  join public.shifts s on s.code = 'GEN'
  join (values
    -- units/day, and the crew that figure was measured with. The crew matters:
    -- without it a day's attendance has nothing to scale against, and the
    -- production screen correctly refuses to pretend otherwise.
    ('PLYCUT', 130, 8), ('MACHINE', 110, 10), ('ASSY', 75, 14),
    ('SAND', 120, 6), ('WOODFIN', 90, 9), ('METALFIN', 95, 5),
    ('FOAM', 100, 7), ('FIBER', 160, 4), ('CUT', 120, 6),
    ('STITCH', 38, 22), ('STAPLE', 90, 16), ('FIT', 120, 12),
    ('QC', 150, 4), ('PACK', 170, 6)
  ) as v (dept_code, units_per_day, crew) on v.dept_code = r.department_code
on conflict (component_id, department_id, shift_id) do nothing;

-- ---------------------------------------------------------------------------
-- D-minus — INVENTED. Working days before the container stuffing date that each
-- department has to be finished.
--
-- A base profile plus a per-article offset, so the matrix varies the way a real
-- one does without any article contradicting the route graph: shifting every
-- department of an article by the same amount cannot reorder them.
--
-- The gaps between consecutive departments are what give each one room to work.
-- Too narrow and a single order cannot fit however far ahead it is placed, so
-- the answer to "can we take this" becomes a flat no and the demonstration has
-- nothing to say.
-- ---------------------------------------------------------------------------
update public.article_dept_dminus adm
   set dminus_days = base.days + off.offset_days,
       is_complete = true
  from _route r
  join (values
    ('PLYCUT', 80), ('MACHINE', 80), ('ASSY', 64), ('SAND', 56),
    ('WOODFIN', 46), ('METALFIN', 50), ('FOAM', 36), ('FIBER', 50),
    ('CUT', 50), ('STITCH', 30), ('STAPLE', 21), ('FIT', 13),
    ('QC', 8), ('PACK', 4)
  ) as base (dept_code, days) on base.dept_code = r.department_code
  join (values
    ('125034299', 0), ('125034308', 3), ('UD354 SPPL WAL', 2),
    ('UT263 SPWL COU', 3), ('UO265 DEN VBR', -2), ('DL25107', 5)
  ) as off (article_code, offset_days) on off.article_code = r.article_code
 where adm.article_id = r.article_id
   and adm.department_id = r.department_id;

drop table _route;

-- ---------------------------------------------------------------------------
-- Customers and orders — INVENTED. erp_order_no mimics Panipuri's numbering so
-- the import module has a shape to expect.
--
-- Dated relative to today rather than fixed, so the demonstration still has an
-- order book whenever it is opened. Fixed dates would quietly become a factory
-- with nothing left to schedule, some weeks after they were written.
-- ---------------------------------------------------------------------------
insert into public.customers (code, name, country)
values
  ('NORDIC', 'Nordic Living ApS', 'Denmark'),
  ('CASAVERDE', 'Casa Verde SL', 'Spain'),
  ('HARPER', 'Harper & Co', 'United States')
on conflict (code) do nothing;

insert into public.orders
  (erp_order_no, customer_id, article_id, total_qty, order_date, confidence)
select v.erp_order_no,
       (select id from public.customers where code = v.customer_code),
       (select id from public.articles where code = v.article_code),
       v.total_qty,
       v.order_date,
       v.confidence::public.order_confidence
  from (values
    -- Three orders stuffing within a week of each other. The overlap is what
    -- pushes stitching over capacity, and the reason capacity flagging exists.
    ('SO/26-27/0412', 'NORDIC',    '125034299',      250, current_date - 75, 'confirmed'),
    ('SO/26-27/0418', 'CASAVERDE', 'UD354 SPPL WAL', 300, current_date - 71, 'confirmed'),
    ('SO/26-27/0423', 'HARPER',    '125034308',      200, current_date - 68, 'confirmed'),

    -- Ships in two phases from one order — the case that makes the shipment
    -- line, not the order, the scheduling unit.
    ('SO/26-27/0431', 'NORDIC',    'DL25107',        400, current_date - 57, 'confirmed'),

    -- Comfortable, and far enough out to sit in the idle stretch.
    ('SO/26-27/0447', 'CASAVERDE', 'UO265 DEN VBR',  120, current_date - 40, 'confirmed'),

    -- Material lands late; the schedule is arithmetically valid and physically
    -- impossible.
    ('SO/26-27/0455', 'HARPER',    'UT263 SPWL COU', 180, current_date - 88, 'confirmed'),

    -- Not yet firm. Excluded when the planner filters to confirmed only.
    ('SO/26-27/0462', 'NORDIC',    '125034299',       90, current_date - 22, 'probable'),
    ('SO/26-27/0470', 'HARPER',    'UO265 DEN VBR',  150, current_date - 7,  'forecast')
  ) as v (erp_order_no, customer_code, article_code, total_qty, order_date, confidence)
on conflict (erp_order_no) do nothing;

-- ---------------------------------------------------------------------------
-- Shipment lines. Every date calculation keys on these, never on the order.
-- ---------------------------------------------------------------------------
insert into public.shipment_lines
  (order_id, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready_date)
select (select id from public.orders where erp_order_no = v.erp_order_no),
       v.line_no, v.qty, v.stuffing_date, v.delivery_date, v.container_ref, v.material_ready
  from (values
    -- Already in production. Its upstream departments were due a fortnight ago,
    -- which is what gives the Production screen real history and puts flagged
    -- days inside the fortnight where the only remaining option is a phone call
    -- to the customer.
    --
    -- Fabric is not in the building until well after cutting would have to
    -- start: arithmetically valid, physically impossible.
    ('SO/26-27/0455', 1, 180, current_date + 34, current_date + 76, 'TGHU-2291877', current_date + 9),

    -- The cluster. Three containers inside a week is what pushes stitching over
    -- capacity, and the reason capacity flagging exists at all. Close enough in
    -- that its earliest work is already inside the fortnight, so flag triage has
    -- all three of its lead-time bands to show rather than one.
    ('SO/26-27/0412', 1, 250, current_date + 55,  current_date + 97 , 'MSKU-4417290', null::date),
    ('SO/26-27/0418', 1, 300, current_date + 57,  current_date + 99 , 'MSKU-4417318', null::date),
    ('SO/26-27/0423', 1, 200, current_date + 59,  current_date + 101, 'TGHU-2280154', null::date),

    -- One order, two containers, four weeks apart.
    ('SO/26-27/0431', 1, 150, current_date + 82,  current_date + 124, 'CMAU-7741023', null::date),
    ('SO/26-27/0431', 2, 250, current_date + 110, current_date + 152, 'CMAU-7741566', null::date),

    ('SO/26-27/0447', 1, 120, current_date + 131, current_date + 173, 'MSKU-5120847', null::date),

    ('SO/26-27/0462', 1,  90, current_date + 145, current_date + 187, null, null::date),
    ('SO/26-27/0470', 1, 150, current_date + 166, current_date + 208, null, null::date)
  ) as v (erp_order_no, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready)
on conflict (order_id, line_no) do nothing;

-- ---------------------------------------------------------------------------
-- One manual pin, so the Gantt has something to show and later runs have
-- something to honour. Spec §6: the engine schedules around it and reports any
-- breach it causes, rather than quietly putting it back.
-- ---------------------------------------------------------------------------
insert into public.schedule_pins
  (shipment_line_id, department_id, component_id, pinned_start_date, reason)
select sl.id,
       d.id,
       c.id,
       public.subtract_working_days(
         public.prev_working_day(sl.stuffing_date - 22), 6),
       'Line free after the Nordic run — start early to protect the March container'
  from public.shipment_lines sl
  join public.orders o on o.id = sl.order_id
  join public.articles a on a.id = o.article_id
  join public.departments d on d.code = 'STITCH'
  join public.components c on c.code = a.code || '::STITCH'
 where o.erp_order_no = 'SO/26-27/0447'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A few days of production already declared — INVENTED.
--
-- The Harper counter stool ships in about five weeks, so its early departments
-- ran a fortnight ago and its later ones have not started. This
-- is what stops the Production screen, WIP by order and measured yield from
-- opening empty on the one part of the system nobody has seen before.
--
-- Dates are the departments' own due dates, which is where backward scheduling
-- puts the work, so the entries line up with the plan rather than floating
-- beside it.
-- ---------------------------------------------------------------------------
insert into public.production_declarations
  (shipment_line_id, department_id, component_id, production_date, shift_id,
   qty_good, qty_rejected, note)
select sl.id,
       d.id,
       c.id,
       public.prev_working_day(sl.stuffing_date - adm.dminus_days),
       s.id,
       v.good,
       v.rejected,
       v.note
  from public.shipment_lines sl
  join public.orders o on o.id = sl.order_id
  join public.articles a on a.id = o.article_id
  join (values
    ('PLYCUT',  214, 4, null),
    ('MACHINE', 208, 9, 'Two lengths of tube out of tolerance'),
    ('ASSY',    198, 3, null)
  ) as v (dept_code, good, rejected, note) on true
  join public.departments d on d.code = v.dept_code
  join public.components c on c.code = a.code || '::' || v.dept_code
  join public.article_dept_dminus adm
    on adm.article_id = a.id and adm.department_id = d.id
  join public.shifts s on s.code = 'GEN'
 where o.erp_order_no = 'SO/26-27/0455'
on conflict do nothing;

-- Assembly counted in what ply cutting handed over, and counted six fewer than
-- were declared. The gap is kept rather than reconciled — it is the reason the
-- second count exists.
insert into public.production_acceptances
  (declaration_id, department_id, qty_accepted, note)
select decl.id,
       (select id from public.departments where code = 'ASSY'),
       208,
       'Six panels damaged in transit between benches'
  from public.production_declarations decl
  join public.departments d on d.id = decl.department_id and d.code = 'PLYCUT'
  join public.shipment_lines sl on sl.id = decl.shipment_line_id
  join public.orders o on o.id = sl.order_id and o.erp_order_no = 'SO/26-27/0455'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- The people. Phase 4, deck slide 13.
--
-- Generated from each department's own establishment, so the roster and the
-- sanctioned head count cannot disagree — a screen that says "9 of 10 in" while
-- eleven names are listed is the kind of quietly wrong that this project keeps
-- refusing. Names are invented like everything else in this file; the head
-- counts are the ones above.
--
-- Roughly a third skilled, and the last two of any department are on contract:
-- enough of a mix that the deployment chart shows one, not a wall of identical
-- rows.
-- ---------------------------------------------------------------------------
insert into public.employees
  (emp_code, name, department_id, default_shift_id, skill_level, employment_type)
select d.code || '-' || lpad(n::text, 2, '0'),
       (array['Ramesh','Sunil','Anjali','Farid','Kavita','Imran','Deepa',
              'Sanjay','Meera','Vikas','Prakash','Nisha','Arun','Rekha',
              'Salim','Pooja','Mahesh','Latha','Girish','Shabana',
              'Dinesh','Yasmin'])[1 + ((n * 7 + d.route_position) % 22)]
         || ' ' ||
       (array['Patil','Sheikh','Naik','Kulkarni','Ansari','Rane','Joshi',
              'Gaikwad','Sawant','Qureshi','More'])[1 + ((n * 3 + d.route_position) % 11)],
       d.id,
       ds.shift_id,
       case when n % 3 = 1 then 'skilled' else 'semi_skilled' end::public.skill_level,
       case when n > ds.sanctioned_headcount - 2 then 'contract' else 'permanent' end
         ::public.employment_type
  from public.department_shifts ds
  join public.departments d on d.id = ds.department_id and d.is_active
  cross join lateral generate_series(1, ds.sanctioned_headcount) as n
on conflict (emp_code) do nothing;

-- Today, as a supervisor would have left it by mid-morning: most of the floor
-- marked, a few absent, one on leave, a couple who stayed late on the Harper
-- run — and, deliberately, a whole department nobody has touched yet, because
-- "nobody has said" is a state the screen has to show honestly rather than
-- reading as a full attendance.
--
-- Written through set_employee_attendance so the department head count is
-- derived the same way the floor derives it, and capacity for today moves with
-- it. current_date, so the demonstration is always about this morning.
do $$
declare
  r record;
begin
  for r in
    select e.emp_code,
           row_number() over (partition by d.code order by e.emp_code) as seat,
           d.code as dept
      from public.employees e
      join public.departments d on d.id = e.department_id and d.is_active
     where e.is_active
       -- Fitting has not been marked at all. Someone has to chase it.
       and d.code <> 'FIT'
  loop
    perform public.set_employee_attendance(
      r.emp_code,
      current_date,
      case
        when r.seat % 11 = 0 then 'absent'
        when r.seat % 17 = 0 then 'leave'
        else 'present'
      end::public.attendance_status,
      case when r.dept = 'STITCH' and r.seat <= 3 then 2 else 0 end,
      case when r.dept = 'STITCH' and r.seat <= 3
           then 'Stayed on the Harper stitching run' end
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Material. Phase 5, and the second row of U&M's own scope of work.
--
-- The categories and the material names are real — they are the cost lines in
-- U&M's own costing sheet: wood, plywood, metal, spring, foam, fibre, fabric,
-- leather, packing. The suppliers, the lead times, the quantities per chair and
-- every stock figure are invented like everything else in this file.
--
-- Three stock states are represented deliberately, because the screen's whole
-- job is telling them apart: counted and enough, counted and short, and nobody
-- has been to the store.
-- ---------------------------------------------------------------------------
insert into public.suppliers (code, name, lead_time_days)
values
  ('TIMBER',  'Sharma Timber & Ply',      21),
  ('FOAMCO',  'Agarwal Foam',             10),
  ('FABRIC',  'Shila Furnishings',        35),
  ('METALW',  'Nashik Metal Works',       18),
  ('PACKING', 'Kalpataru Packaging',       7)
on conflict (code) do nothing;

insert into public.materials (code, name, category, uom, supplier_id, lead_time_days)
select v.code, v.name, v.category, v.uom,
       (select id from public.suppliers where code = v.supplier),
       v.lead_time
  from (values
    ('WD-OAK',   'Oak, 25mm',                'Wood',     'CFT', 'TIMBER',  null::integer),
    ('WD-MANGO', 'Mango, 50mm',              'Wood',     'CFT', 'TIMBER',  null),
    ('PLY-18',   'Plywood 18mm, 8x4',        'Plywood',  'SHT', 'TIMBER',  null),
    ('PLY-12',   'Plywood 12mm, 8x4',        'Plywood',  'SHT', 'TIMBER',  null),
    ('MTL-TUBE', 'MS tube, 25mm',            'Metal',    'MTR', 'METALW',  null),
    ('SPR-60',   'Spring 60A27.5',           'Spring',   'NOS', 'METALW',  null),
    ('SPR-CLIP', 'Spring clips',             'Spring',   'NOS', 'METALW',  null),
    ('FM-25',    'Foam 25mm, 72x36',         'Foam',     'SHT', 'FOAMCO',  null),
    ('FM-50',    'Foam 50mm, 72x36',         'Foam',     'SHT', 'FOAMCO',  null),
    ('FIB-WAD',  'Fibre wadding',            'Fibre',    'KG',  'FOAMCO',  null),
    ('FAB-LIN',  'Linen, natural',           'Fabric',   'MTR', 'FABRIC',  null),
    ('LTH-01',   'Leather, full grain',      'Leather',  'SQF', 'FABRIC',  56),
    ('FAB-DACK', 'Dacking fabric',           'Fabric',   'MTR', 'FABRIC',  null),
    ('THR-01',   'Thread, bonded nylon',     'Thread',   'CON', 'FABRIC',  null),
    ('PK-BOX',   'Carton, 5 ply',            'Packing',  'NOS', 'PACKING', null)
  ) as v (code, name, category, uom, supplier, lead_time)
on conflict (code) do nothing;

-- What each article eats, and where. The department is the point: leather is
-- needed when cutting starts, not when the container sails.
insert into public.article_materials (article_id, material_id, department_id, qty_per_unit)
select a.id, m.id, d.id, v.qty
  from public.articles a
  cross join (values
    ('PLY-18',   'PLYCUT',  0.35),
    ('WD-OAK',   'MACHINE', 2.10),
    ('FM-25',    'FOAM',    0.60),
    ('FIB-WAD',  'FOAM',    0.40),
    ('FAB-LIN',  'CUT',     3.20),
    ('THR-01',   'STITCH',  0.08),
    ('PK-BOX',   'PACK',    1.00)
  ) as v (material_code, dept_code, qty)
  join public.materials m on m.code = v.material_code
  join public.departments d on d.code = v.dept_code and d.is_active
 where a.is_active
on conflict (article_id, material_id, department_id) do nothing;

-- Two articles carry metal and leather; the dining chairs do not.
insert into public.article_materials (article_id, material_id, department_id, qty_per_unit)
select a.id, m.id, d.id, v.qty
  from (values
    ('UT263 SPWL COU', 'MTL-TUBE', 'MACHINE', 1.80),
    ('UT263 SPWL COU', 'LTH-01',   'CUT',     9.50),
    ('UO265 DEN VBR',  'SPR-60',   'ASSY',   12.00),
    ('UO265 DEN VBR',  'SPR-CLIP', 'ASSY',   24.00)
  ) as v (article_code, material_code, dept_code, qty)
  join public.articles a on a.code = v.article_code
  join public.materials m on m.code = v.material_code
  join public.departments d on d.code = v.dept_code and d.is_active
on conflict (article_id, material_id, department_id) do nothing;

-- Stock. Deliberately incomplete: plywood and thread have never been counted,
-- and the linen is genuinely short — which are three different sentences on
-- screen and must not collapse into one.
insert into public.material_stock (material_id, qty_on_hand, counted_on, note)
select m.id, v.qty, current_date - v.days_ago, v.note
  from (values
    ('WD-OAK',   4200::numeric, 2, null),
    ('WD-MANGO',  900,          2, null),
    ('PLY-12',    260,          5, null),
    ('MTL-TUBE',  700,          3, null),
    ('SPR-60',   9000,          9, null),
    ('SPR-CLIP',18000,          9, null),
    ('FM-25',     240,          1, null),
    ('FM-50',     110,          1, 'Reserved against the Boden run'),
    ('FIB-WAD',   380,          4, null),
    ('FAB-LIN',   900,          1, 'Short — the mill slipped a fortnight'),
    ('LTH-01',   3100,          6, null),
    ('FAB-DACK',  450,          6, null),
    ('PK-BOX',    260,          3, null)
  ) as v (code, qty, days_ago, note)
  join public.materials m on m.code = v.code
on conflict (material_id) do nothing;

-- ---------------------------------------------------------------------------
-- Quality. Phase 6.
--
-- The defect names are the ones an upholstery floor actually uses. The
-- quantities are invented, and deliberately do not add up to every reject —
-- the screen's job is to show what is unexplained, and a demonstration where
-- everything is explained would hide the one panel worth looking at.
-- ---------------------------------------------------------------------------
insert into public.defect_types (code, name, category)
values
  ('SPLIT',   'Split on the joint',          'workmanship'),
  ('KNOT',    'Knot or shake in the face',   'material'),
  ('SAND',    'Sanding marks through finish','workmanship'),
  ('SHADE',   'Fabric shade variation',      'material'),
  ('PUCKER',  'Seam puckering',              'workmanship'),
  ('TENSION', 'Machine tension',             'machine'),
  ('STAPLE',  'Staple pull-through',         'workmanship'),
  ('PATTERN', 'Pattern match out',           'design'),
  ('TRANSIT', 'Damaged between benches',     'handling')
on conflict (code) do nothing;

-- Against the three declarations the demo already carries.
insert into public.production_defects (declaration_id, defect_type_id, qty, note)
select decl.id, dt.id, v.qty, v.note
  from (values
    ('PLYCUT',  'KNOT',    2::numeric, 'Two boards from the same bundle'),
    ('PLYCUT',  'SPLIT',   1,          null),
    ('MACHINE', 'TENSION', 5,          'Head 3 — belt slipping, maintenance told'),
    ('MACHINE', 'SPLIT',   2,          null),
    ('ASSY',    'TRANSIT', 1,          null)
  ) as v (dept_code, defect_code, qty, note)
  join public.departments d on d.code = v.dept_code
  join public.defect_types dt on dt.code = v.defect_code
  join public.production_declarations decl on decl.department_id = d.id
on conflict (declaration_id, defect_type_id) do nothing;
