-- Kram — demonstration order book.
--
-- Applied on top of seed.sql in the offline build only. `supabase db reset`
-- picks up seed.sql by name and leaves this alone, so a real project never gets
-- fictional orders by accident.
--
-- The figures are chosen so the planning screens have something to say. On the
-- placeholder route stitching is the constraint at 30 covers a day, against
-- wood's 40 chairs, fabric cutting's 60 and assembly's 50 — so clustering
-- orders around one stuffing window is what produces flagged days, and the
-- quiet weeks either side are what produces the idle report.

insert into public.customers (code, name, country)
values
  ('NORDIC', 'Nordic Living ApS', 'Denmark'),
  ('CASAVERDE', 'Casa Verde SL', 'Spain'),
  ('HARPER', 'Harper & Co', 'United States')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Orders. erp_order_no mimics Panipuri's numbering so the import module has a
-- shape to expect.
-- ---------------------------------------------------------------------------

insert into public.orders
  (erp_order_no, customer_id, article_id, total_qty, order_date, confidence)
select v.erp_order_no,
       (select id from public.customers where code = v.customer_code),
       (select id from public.articles where code = 'AARA-LC'),
       v.total_qty,
       v.order_date,
       v.confidence::public.order_confidence
  from (values
    -- Three orders stuffing within a week of each other: the overlap is what
    -- pushes stitching over capacity, and the reason capacity flagging exists.
    ('SO/26-27/0412', 'NORDIC',    250, date '2026-08-28', 'confirmed'),
    ('SO/26-27/0418', 'CASAVERDE', 300, date '2026-09-01', 'confirmed'),
    ('SO/26-27/0423', 'HARPER',    200, date '2026-09-04', 'confirmed'),

    -- Ships in two phases from one order — the case that makes the shipment
    -- line, not the order, the scheduling unit.
    ('SO/26-27/0431', 'NORDIC',    400, date '2026-09-15', 'confirmed'),

    -- Comfortable, and far enough out to sit in the idle stretch.
    ('SO/26-27/0447', 'CASAVERDE', 120, date '2026-10-02', 'confirmed'),

    -- Material lands late; the schedule is arithmetically valid and physically
    -- impossible.
    ('SO/26-27/0455', 'HARPER',    180, date '2026-08-20', 'confirmed'),

    -- Not yet firm. Excluded when the planner filters to confirmed only.
    ('SO/26-27/0462', 'NORDIC',     90, date '2026-10-20', 'probable'),
    ('SO/26-27/0470', 'HARPER',    150, date '2026-11-05', 'forecast')
  ) as v (erp_order_no, customer_code, total_qty, order_date, confidence)
on conflict (erp_order_no) do nothing;

-- ---------------------------------------------------------------------------
-- Shipment lines. Every date calculation keys on these, never on the order.
-- ---------------------------------------------------------------------------

insert into public.shipment_lines
  (order_id, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready_date)
select (select id from public.orders where erp_order_no = v.erp_order_no),
       v.line_no, v.qty, v.stuffing_date, v.delivery_date, v.container_ref, v.material_ready
  from (values
    ('SO/26-27/0412', 1, 250, date '2026-11-16', date '2026-12-28', 'MSKU-4417290', null::date),
    ('SO/26-27/0418', 1, 300, date '2026-11-18', date '2026-12-30', 'MSKU-4417318', null::date),
    ('SO/26-27/0423', 1, 200, date '2026-11-20', date '2027-01-06', 'TGHU-2280154', null::date),

    -- One order, two containers, three weeks apart.
    ('SO/26-27/0431', 1, 150, date '2026-12-11', date '2027-01-22', 'CMAU-7741023', null::date),
    ('SO/26-27/0431', 2, 250, date '2027-01-08', date '2027-02-18', 'CMAU-7741566', null::date),

    ('SO/26-27/0447', 1, 120, date '2027-01-29', date '2027-03-12', 'MSKU-5120847', null::date),

    -- Fabric is not in the building until well after wood would have to start.
    ('SO/26-27/0455', 1, 180, date '2026-10-30', date '2026-12-11', 'TGHU-2291877', date '2026-10-05'),

    ('SO/26-27/0462', 1,  90, date '2027-02-12', date '2027-03-26', null, null::date),
    ('SO/26-27/0470', 1, 150, date '2027-03-05', date '2027-04-16', null, null::date)
  ) as v (erp_order_no, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready)
on conflict (order_id, line_no) do nothing;

-- ---------------------------------------------------------------------------
-- One manual pin, so the Gantt has something to show and later runs have
-- something to honour.
--
-- Stitching on the Casa Verde order is pulled six working days earlier than the
-- engine would place it. Spec §6: the engine schedules around it and reports
-- any breach it causes, rather than quietly putting it back.
-- ---------------------------------------------------------------------------

insert into public.schedule_pins
  (shipment_line_id, department_id, component_id, pinned_start_date, reason)
select sl.id,
       (select id from public.departments where code = 'STITCH'),
       (select id from public.components where code = 'COVER'),
       public.subtract_working_days(
         public.prev_working_day(sl.stuffing_date - 40), 6),
       'Line free after the Nordic run — start early to protect the January container'
  from public.shipment_lines sl
  join public.orders o on o.id = sl.order_id
 where o.erp_order_no = 'SO/26-27/0447'
on conflict do nothing;
