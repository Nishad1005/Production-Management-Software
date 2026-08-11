-- Kram — views the client reads through.
--
-- Until now the client sent ad-hoc SQL strings, which works against PGlite in
-- the browser and not at all against Supabase: PostgREST exposes tables, views
-- and functions, never arbitrary SQL. Moving every screen's query into a view
-- makes the same code work against both, and keeps the logic in the database
-- where the rest of it lives.
--
-- security_invoker so row-level security applies to the calling user rather
-- than the view's owner.

-- ---------------------------------------------------------------------------
-- Command centre figures, one row per run.
-- ---------------------------------------------------------------------------
create view public.schedule_kpis
with (security_invoker = true) as
  select r.id as run_id,
         (select count(*)::integer from public.orders where status = 'open')
           as open_orders,
         (select count(*)::integer from public.shipment_lines)
           as shipment_lines,
         (select count(*)::integer from public.schedule_tasks t
           where t.run_id = r.id) as tasks,
         (select count(*)::integer from public.schedule_tasks t
           where t.run_id = r.id and not t.is_feasible) as breaches,
         (select count(*)::integer from public.schedule_department_day dd
           where dd.run_id = r.id and dd.status = 'over') as flagged_days,
         (select count(*)::integer from public.schedule_department_day dd
           where dd.run_id = r.id and dd.status = 'idle') as idle_days,
         (select count(*)::integer from public.schedule_tasks t
           where t.run_id = r.id and t.is_pinned) as pinned
    from public.schedule_runs r;

-- ---------------------------------------------------------------------------
-- Run history, with the what-if parameters lifted out of params.
-- ---------------------------------------------------------------------------
create view public.run_history
with (security_invoker = true) as
  select id,
         run_at,
         note,
         is_current,
         status,
         task_count,
         breach_count,
         duration_ms,
         horizon_from,
         horizon_to,
         params -> 'what_if' ->> 'department' as what_if_department,
         (params -> 'what_if' ->> 'factor')::numeric as what_if_factor,
         (params -> 'what_if' ->> 'from')::date as what_if_from,
         (params -> 'what_if' ->> 'to')::date as what_if_to,
         (params -> 'what_if' ->> 'applied')::integer as what_if_applied,
         (params -> 'what_if' ->> 'intended')::integer as what_if_intended
    from public.schedule_runs;

-- ---------------------------------------------------------------------------
-- Heatmap cells, with the department's code and position alongside.
-- ---------------------------------------------------------------------------
create view public.heatmap_cell
with (security_invoker = true) as
  select dd.run_id,
         dd.department_id,
         d.code as department_code,
         d.route_position,
         dd.load_date,
         dd.utilisation,
         dd.status,
         dd.components_loaded
    from public.schedule_department_day dd
    join public.departments d on d.id = dd.department_id;

-- What sits on one department-day: the heatmap's detail panel.
create view public.load_detail
with (security_invoker = true) as
  select l.run_id,
         l.department_id,
         l.load_date,
         o.erp_order_no,
         cu.name as customer_name,
         cmp.code as component_code,
         sum(l.qty_planned) as qty_planned,
         max(cap.capacity) as capacity
    from public.schedule_daily_load l
    join public.shipment_lines sl on sl.id = l.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.customers cu on cu.id = o.customer_id
    join public.components cmp on cmp.id = l.component_id
    left join (
      select run_id, department_id, component_id, load_date,
             sum(capacity) as capacity
        from public.schedule_daily_capacity
       group by run_id, department_id, component_id, load_date
    ) cap
      on cap.run_id = l.run_id
     and cap.department_id = l.department_id
     and cap.component_id = l.component_id
     and cap.load_date = l.load_date
   group by l.run_id, l.department_id, l.load_date,
            o.erp_order_no, cu.name, cmp.code;

-- ---------------------------------------------------------------------------
-- Order book. Breach counts are against the live plan, which is what the
-- screen always wants — a stale run's breaches beside a current order would
-- be worse than none.
-- ---------------------------------------------------------------------------
create view public.order_book
with (security_invoker = true) as
  select o.id as order_id,
         o.erp_order_no,
         cu.name as customer_name,
         a.code as article_code,
         o.total_qty,
         o.confidence,
         o.status,
         r.line_count,
         r.unallocated_qty,
         (select min(sl.stuffing_date) from public.shipment_lines sl
           where sl.order_id = o.id) as next_stuffing,
         (select count(*)::integer
            from public.schedule_tasks t
            join public.shipment_lines sl on sl.id = t.shipment_line_id
            join public.schedule_runs run on run.id = t.run_id and run.is_current
           where sl.order_id = o.id and not t.is_feasible) as breaches
    from public.orders o
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id
    join public.order_qty_reconciliation r on r.order_id = o.id
   where cu.code <> '__ACCEPTANCE_CHECK__';

-- ---------------------------------------------------------------------------
-- Masters, denormalised to codes so no screen has to resolve an id.
-- ---------------------------------------------------------------------------
create view public.department_master
with (security_invoker = true) as
  select d.id,
         d.code,
         d.name,
         d.route_position,
         d.yield_pct,
         d.is_active,
         string_agg(s.code, ', ' order by s.code) as shifts,
         sum(ds.sanctioned_headcount)::integer as headcount
    from public.departments d
    left join public.department_shifts ds
      on ds.department_id = d.id and ds.is_active
    left join public.shifts s on s.id = ds.shift_id and s.is_active
   group by d.id, d.code, d.name, d.route_position, d.yield_pct, d.is_active;

create view public.shift_master
with (security_invoker = true) as
  select s.id,
         s.code,
         s.name,
         s.start_time,
         s.end_time,
         to_char(s.start_time, 'HH24:MI') as start_label,
         to_char(s.end_time, 'HH24:MI') as end_label,
         s.net_production_hours,
         s.max_ot_hours,
         s.is_active,
         (select count(*)::integer
            from public.department_shifts ds
            join public.departments d on d.id = ds.department_id
           where ds.shift_id = s.id and ds.is_active and d.is_active
         ) as departments_running
    from public.shifts s;

-- Every active department against every shift, whether or not the pairing
-- exists. rate_count is what keeps it honest: a pairing switched on with no
-- rates adds no capacity at all.
create view public.department_shift_grid
with (security_invoker = true) as
  select d.id as department_id,
         d.code as department_code,
         d.route_position,
         s.id as shift_id,
         s.code as shift_code,
         s.start_time,
         s.is_active as shift_is_active,
         coalesce(ds.is_active, false) as is_active,
         ds.sanctioned_headcount,
         (select count(*)::integer from public.component_rates cr
           where cr.department_id = d.id and cr.shift_id = s.id) as rate_count
    from public.departments d
    cross join public.shifts s
    left join public.department_shifts ds
      on ds.department_id = d.id and ds.shift_id = s.id
   where d.is_active;

create view public.component_rate_master
with (security_invoker = true) as
  select cr.id,
         d.code as department_code,
         d.route_position,
         cmp.code as component_code,
         s.code as shift_code,
         cr.units_per_day,
         cr.is_measured
    from public.component_rates cr
    join public.departments d on d.id = cr.department_id
    join public.components cmp on cmp.id = cr.component_id
    join public.shifts s on s.id = cr.shift_id;

create view public.dminus_matrix
with (security_invoker = true) as
  select adm.id,
         a.code as article_code,
         d.code as department_code,
         d.route_position,
         adm.dminus_days,
         adm.is_complete
    from public.article_dept_dminus adm
    join public.articles a on a.id = adm.article_id
    join public.departments d on d.id = adm.department_id
   where a.is_active and d.is_active;

create view public.bom_master
with (security_invoker = true) as
  select b.id,
         a.code as article_code,
         c.code as component_code,
         c.name as component_name,
         b.qty_per_unit
    from public.article_bom b
    join public.articles a on a.id = b.article_id
    join public.components c on c.id = b.component_id;

-- Active pins with the order and department they belong to.
create view public.pin_list
with (security_invoker = true) as
  select p.id,
         p.shipment_line_id,
         o.erp_order_no,
         sl.line_no,
         d.code as department_code,
         c.code as component_code,
         p.pinned_start_date,
         p.reason,
         p.pinned_at
    from public.schedule_pins p
    join public.shipment_lines sl on sl.id = p.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.departments d on d.id = p.department_id
    join public.components c on c.id = p.component_id
   where p.is_active;
