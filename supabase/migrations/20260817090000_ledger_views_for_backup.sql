-- Kram — the ledger, readable as rows.
--
-- Every screen reads a view and every write calls a function, because that is
-- all PostgREST offers. It has served well, but it means the client can only
-- ever see data that some screen needed shaped a particular way — and the
-- production ledger has never needed that shape. `wip_by_order` aggregates it,
-- `production_worklist` slices it by department and day. Nothing returns the
-- rows.
--
-- Which matters for exactly one reason. Masters can be re-entered from a
-- spreadsheet and the schedule can be re-run from nothing, but **what a
-- department declared it made on a Tuesday cannot be reconstructed from
-- anything**. It is the only data in Kram with no other source, and until now
-- it could not leave the database at all.
--
-- These three views exist so it can be copied out. They are deliberately flat
-- and keyed by natural keys — order number, department code, dates — never
-- internal ids, so a file written from one database is legible against another,
-- exactly as the masters file already is.

create view public.declaration_list
with (security_invoker = true) as
  select o.erp_order_no,
         sl.line_no,
         d.code                      as department_code,
         c.code                      as component_code,
         decl.production_date::text  as production_date,
         s.code                      as shift_code,
         decl.qty_good::float8       as qty_good,
         decl.qty_rejected::float8   as qty_rejected,
         decl.note,
         decl.created_at::text       as created_at
    from public.production_declarations decl
    join public.shipment_lines sl on sl.id = decl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.departments d on d.id = decl.department_id
    join public.components c on c.id = decl.component_id
    join public.shifts s on s.id = decl.shift_id;

comment on view public.declaration_list is
  'Every production declaration as a flat row, keyed by natural keys. Exists so the ledger can be copied out of the database — it is the only data here that cannot be reconstructed from anything else.';

grant select on public.declaration_list to authenticated;

-- The second count, kept beside the first rather than reconciled into it. A
-- backup that carried only what was declared would quietly discard every
-- disagreement between two benches, which is the thing the ledger exists to
-- hold.
create view public.acceptance_list
with (security_invoker = true) as
  select o.erp_order_no,
         sl.line_no,
         from_d.code               as from_department_code,
         c.code                    as component_code,
         decl.production_date::text as production_date,
         to_d.code                 as accepted_by_code,
         acc.qty_accepted::float8  as qty_accepted,
         acc.note,
         acc.created_at::text      as created_at
    from public.production_acceptances acc
    join public.production_declarations decl on decl.id = acc.declaration_id
    join public.shipment_lines sl on sl.id = decl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.departments from_d on from_d.id = decl.department_id
    join public.departments to_d on to_d.id = acc.department_id
    join public.components c on c.id = decl.component_id;

comment on view public.acceptance_list is
  'Every handover counted in, against the declaration it answers. The gap between the two is kept, not reconciled.';

grant select on public.acceptance_list to authenticated;

-- Attendance, per person per day, for everybody — including people since
-- deactivated. `employee_day` is a screen's view and filters to active
-- employees, which is right for a screen and wrong for a copy: somebody who
-- left in March still worked in February, and a backup that forgets them
-- rewrites history quietly.
create view public.attendance_list
with (security_invoker = true) as
  select e.emp_code,
         e.name,
         d.code                     as department_code,
         s.code                     as shift_code,
         ea.attendance_date::text   as attendance_date,
         ea.status::text            as status,
         ea.ot_hours::float8        as ot_hours,
         ea.note,
         ea.created_at::text        as created_at
    from public.employee_attendance ea
    join public.employees e on e.id = ea.employee_id
    left join public.departments d on d.id = e.department_id
    join public.shifts s on s.id = ea.shift_id;

comment on view public.attendance_list is
  'Per person per day, including people since deactivated — a copy that dropped them would rewrite history.';

grant select on public.attendance_list to authenticated;

-- The two remaining tables somebody types into that no view returns as rows.
-- department_attendance is where a head count is entered directly rather than
-- derived from individuals, and capacity_overrides is the "this department is
-- shut on Friday" figure. Both are small, both are typed by a person, and
-- neither can be recomputed.
create view public.department_attendance_list
with (security_invoker = true) as
  select d.code                     as department_code,
         s.code                     as shift_code,
         att.attendance_date::text  as attendance_date,
         att.present,
         att.note,
         att.created_at::text       as created_at
    from public.department_attendance att
    join public.departments d on d.id = att.department_id
    join public.shifts s on s.id = att.shift_id;

grant select on public.department_attendance_list to authenticated;

create view public.capacity_override_list
with (security_invoker = true) as
  select d.code               as department_code,
         s.code               as shift_code,
         c.code               as component_code,
         ov.from_date::text   as from_date,
         ov.to_date::text     as to_date,
         ov.units_per_day::float8 as units_per_day,
         ov.reason,
         ov.created_at::text  as created_at
    from public.capacity_overrides ov
    join public.departments d on d.id = ov.department_id
    join public.shifts s on s.id = ov.shift_id
    left join public.components c on c.id = ov.component_id;

grant select on public.capacity_override_list to authenticated;

-- ---------------------------------------------------------------------------
-- The order book, keyed the way a file has to be keyed.
--
-- `order_book` is the screen's view and carries a customer's *name* and an
-- internal id; `shipment_line_list` references its order by uuid. Both are
-- right for a screen, where the id never leaves the browser. In a file they are
-- close to useless: rebuild the database and every one of those uuids is gone,
-- so the lines no longer point at anything.
--
-- The masters file settled this convention on day one — natural keys, never
-- internal ids — and this is the same rule applied to the order book.
-- ---------------------------------------------------------------------------
create view public.order_list
with (security_invoker = true) as
  select o.erp_order_no,
         cu.code               as customer_code,
         cu.name               as customer_name,
         a.code                as article_code,
         o.total_qty::float8   as total_qty,
         o.order_date::text    as order_date,
         o.confidence::text    as confidence,
         o.status::text        as status,
         o.created_at::text    as created_at
    from public.orders o
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id;

comment on view public.order_list is
  'The order book by natural key, for copying out. order_book is the screen''s view and carries internal ids.';

grant select on public.order_list to authenticated;

-- Additive only: the column goes on the end, which `create or replace view`
-- permits. Existing readers see exactly what they saw before.
create or replace view public.shipment_line_list
with (security_invoker = true) as
  select sl.id,
         sl.order_id,
         sl.line_no,
         sl.qty::float8 as qty,
         sl.stuffing_date::text as stuffing_date,
         sl.delivery_date::text as delivery_date,
         sl.container_ref,
         sl.material_ready_date::text as material_ready_date,
         o.erp_order_no
    from public.shipment_lines sl
    join public.orders o on o.id = sl.order_id;
