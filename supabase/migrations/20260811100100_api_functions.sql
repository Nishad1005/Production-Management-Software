-- Kram — the write API.
--
-- Same reason as the views: PostgREST calls functions, not SQL strings. Keeping
-- each write as a database function also keeps its rules next to the data — the
-- D-minus completeness rule, the rate copying when a shift is switched on —
-- rather than scattered through a client that will eventually be replaced.
--
-- All of these run as the caller, so row-level security applies exactly as it
-- does to a direct table write.

-- ---------------------------------------------------------------------------
-- Masters
-- ---------------------------------------------------------------------------

-- Spec §5: is_complete is false until a value is entered, and a blank cell
-- blocks scheduling rather than defaulting to zero. Clearing the field has to
-- put the row back to incomplete, or a deleted value silently becomes a
-- zero-day offset.
create or replace function public.set_dminus(
  p_article_code text,
  p_department_code text,
  p_days integer
)
returns void
language sql
as $$
  update public.article_dept_dminus adm
     set dminus_days = p_days,
         is_complete = (p_days is not null)
    from public.articles a, public.departments d
   where a.id = adm.article_id and d.id = adm.department_id
     and a.code = p_article_code and d.code = p_department_code;
$$;

create or replace function public.set_component_rate(
  p_component_code text,
  p_department_code text,
  p_shift_code text,
  p_units_per_day numeric
)
returns void
language sql
as $$
  update public.component_rates cr
     set units_per_day = p_units_per_day
    from public.components c, public.departments d, public.shifts s
   where c.id = cr.component_id and d.id = cr.department_id and s.id = cr.shift_id
     and c.code = p_component_code and d.code = p_department_code
     and s.code = p_shift_code;
$$;

create or replace function public.update_department(
  p_id uuid,
  p_name text default null,
  p_yield_pct numeric default null,
  p_route_position integer default null
)
returns void
language sql
as $$
  update public.departments
     set name = coalesce(p_name, name),
         yield_pct = coalesce(p_yield_pct, yield_pct),
         route_position = coalesce(p_route_position, route_position)
   where id = p_id;
$$;

create or replace function public.set_department_active(
  p_id uuid,
  p_is_active boolean
)
returns void
language sql
as $$
  -- Soft delete only. A department with history is never removed.
  update public.departments set is_active = p_is_active where id = p_id;
$$;

create or replace function public.create_department(
  p_code text,
  p_name text,
  p_route_position integer,
  p_yield_pct numeric default 98
)
returns uuid
language sql
as $$
  insert into public.departments (code, name, route_position, yield_pct)
  values (p_code, p_name, p_route_position, p_yield_pct)
  returning id;
$$;

create or replace function public.update_shift(
  p_id uuid,
  p_name text default null,
  p_net_production_hours numeric default null,
  p_max_ot_hours numeric default null
)
returns void
language sql
as $$
  update public.shifts
     set name = coalesce(p_name, name),
         net_production_hours = coalesce(p_net_production_hours, net_production_hours),
         max_ot_hours = coalesce(p_max_ot_hours, max_ot_hours)
   where id = p_id;
$$;

create or replace function public.set_shift_active(
  p_id uuid,
  p_is_active boolean
)
returns void
language sql
as $$
  update public.shifts set is_active = p_is_active where id = p_id;
$$;

/*
 * Turns a shift on or off for one department.
 *
 * Switching one on copies the department's component rates and establishment
 * across from a shift it already works: a department_shift with no rates
 * contributes exactly nothing, so the pairing would appear to be running while
 * adding no capacity at all. The copies are a starting point and stay flagged
 * estimated — they are wrong whenever the staffing differs.
 */
create or replace function public.set_department_shift(
  p_department_code text,
  p_shift_code text,
  p_is_active boolean,
  p_headcount integer default null
)
returns void
language plpgsql
as $$
declare
  v_department_id uuid;
  v_shift_id uuid;
begin
  select id into v_department_id from public.departments where code = p_department_code;
  select id into v_shift_id from public.shifts where code = p_shift_code;

  if v_department_id is null or v_shift_id is null then
    raise exception 'No such department (%) or shift (%)', p_department_code, p_shift_code;
  end if;

  insert into public.department_shifts
    (department_id, shift_id, sanctioned_headcount, is_active)
  values (v_department_id, v_shift_id,
          coalesce(p_headcount,
                   (select max(ds.sanctioned_headcount)
                      from public.department_shifts ds
                     where ds.department_id = v_department_id),
                   0),
          p_is_active)
  on conflict (department_id, shift_id)
  do update set is_active = excluded.is_active,
                sanctioned_headcount =
                  coalesce(p_headcount, department_shifts.sanctioned_headcount);

  if not p_is_active then return; end if;

  insert into public.component_rates
    (component_id, department_id, shift_id, units_per_day)
  select cr.component_id, cr.department_id, v_shift_id, cr.units_per_day
    from public.component_rates cr
   where cr.department_id = v_department_id
     and cr.shift_id = (
       select cr2.shift_id from public.component_rates cr2
        where cr2.department_id = v_department_id and cr2.shift_id <> v_shift_id
        group by cr2.shift_id limit 1
     )
  on conflict (component_id, department_id, shift_id) do nothing;
end;
$$;

create or replace function public.set_headcount(
  p_department_code text,
  p_shift_code text,
  p_headcount integer
)
returns void
language sql
as $$
  update public.department_shifts ds
     set sanctioned_headcount = p_headcount
    from public.departments d, public.shifts s
   where d.id = ds.department_id and s.id = ds.shift_id
     and d.code = p_department_code and s.code = p_shift_code;
$$;

create or replace function public.add_holiday(
  p_date date,
  p_description text
)
returns void
language sql
as $$
  insert into public.holidays (holiday_date, description)
  values (p_date, p_description)
  on conflict (holiday_date) do update set description = excluded.description;
$$;

create or replace function public.remove_holiday(p_id uuid)
returns void
language sql
as $$
  delete from public.holidays where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Order book
-- ---------------------------------------------------------------------------

create or replace function public.create_order(
  p_erp_order_no text,
  p_customer_id uuid,
  p_article_id uuid,
  p_qty numeric,
  p_stuffing_date date,
  p_confidence public.order_confidence default 'confirmed',
  p_delivery_date date default null,
  p_container_ref text default null,
  p_material_ready_date date default null
)
returns uuid
language plpgsql
as $$
declare
  v_order_id uuid;
begin
  insert into public.orders
    (erp_order_no, customer_id, article_id, total_qty, confidence, order_date)
  values (p_erp_order_no, p_customer_id, p_article_id, p_qty, p_confidence, current_date)
  returning id into v_order_id;

  insert into public.shipment_lines
    (order_id, line_no, qty, stuffing_date, delivery_date, container_ref,
     material_ready_date)
  values (v_order_id, 1, p_qty, p_stuffing_date, p_delivery_date, p_container_ref,
          p_material_ready_date);

  return v_order_id;
end;
$$;

create or replace function public.add_shipment_line(
  p_order_id uuid,
  p_qty numeric,
  p_stuffing_date date,
  p_delivery_date date default null,
  p_container_ref text default null,
  p_material_ready_date date default null
)
returns uuid
language sql
as $$
  insert into public.shipment_lines
    (order_id, line_no, qty, stuffing_date, delivery_date, container_ref,
     material_ready_date)
  values (p_order_id,
          (select coalesce(max(line_no), 0) + 1 from public.shipment_lines
            where order_id = p_order_id),
          p_qty, p_stuffing_date, p_delivery_date, p_container_ref,
          p_material_ready_date)
  returning id;
$$;

create or replace function public.delete_order(p_id uuid)
returns void
language sql
as $$
  delete from public.orders where id = p_id;
$$;

create or replace function public.delete_shipment_line(p_id uuid)
returns void
language sql
as $$
  delete from public.shipment_lines where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Pins
--
-- Spec §6: a pin is a decision about the factory and outlives the plan that
-- prompted it. Releasing deactivates rather than deletes — the record of who
-- moved what, and why, is the point of asking for a reason at all.
-- ---------------------------------------------------------------------------

create or replace function public.create_pin(
  p_shipment_line_id uuid,
  p_department_code text,
  p_component_code text,
  p_start_date date,
  p_reason text
)
returns void
language sql
as $$
  insert into public.schedule_pins
    (shipment_line_id, department_id, component_id, pinned_start_date, reason)
  select p_shipment_line_id, d.id, c.id, p_start_date, p_reason
    from public.departments d, public.components c
   where d.code = p_department_code and c.code = p_component_code
  on conflict (shipment_line_id, department_id, component_id) where is_active
  do update set pinned_start_date = excluded.pinned_start_date,
                reason = excluded.reason,
                pinned_at = now();
$$;

create or replace function public.release_pin(
  p_shipment_line_id uuid,
  p_department_code text,
  p_component_code text
)
returns void
language sql
as $$
  update public.schedule_pins p
     set is_active = false
    from public.departments d, public.components c
   where p.is_active
     and p.shipment_line_id = p_shipment_line_id
     and p.department_id = d.id and d.code = p_department_code
     and p.component_id = c.id and c.code = p_component_code;
$$;

create or replace function public.delete_schedule_run(p_id uuid)
returns void
language sql
as $$
  delete from public.schedule_runs where id = p_id and not is_current;
$$;
