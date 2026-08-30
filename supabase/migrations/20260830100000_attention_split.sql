-- Kram — the attention findings, one view each.
--
-- ---------------------------------------------------------------------------
-- The shape was the problem, not any one branch.
--
-- `attention` unioned eight findings, each of which is itself a multi-table
-- view. Under `security_invoker` every nested table re-applies its policy, so
-- the cost compounds: individually the sources measure 536 ms, 303, 231, 181 on
-- the live project and all are fine; composed into one query they passed the
-- API's eight-second cap and the alert screen would not load. Neither would the
-- red count in the header, on any screen, because `attention_count` reads the
-- same view.
--
-- Three rounds of making branches cheaper bought 931 ms down to 536 and did not
-- change the outcome, which is the point at which the shape is the thing to
-- change.
--
-- ---------------------------------------------------------------------------
-- Each finding gets its own view, and the client asks for them in parallel.
--
-- Every one is fast on its own. Fetched together, the wall clock is the slowest
-- of them rather than the sum, and nothing has to be made cleverer. `attention`
-- itself stays, unioning these, for anything that wants one list and can afford
-- it — the browser check reads it, and it is the honest definition of what the
-- screen shows.
--
-- The bodies below are the existing text, split at the `union all`s. Nothing is
-- retyped: the last two migrations to rebuild a view by hand both reverted
-- something silently, and three tests caught the second one only by luck.
-- ---------------------------------------------------------------------------



create view public.attention_breach
with (security_invoker = true) as
-- Work that cannot be made as planned at all. One row per order and
  -- department rather than per task: a department missing six components of one
  -- order is one conversation, not six alerts.
  select 'breach'                         as kind,
         case when min(g.days_out) < 15 then 'critical' else 'warning' end as severity,
         g.department_code || ' cannot make ' || g.erp_order_no || ' as planned'
                                          as title,
         max(g.breach_reason::text) || ' · ships ' || min(g.stuffing_date) as detail,
         '/gantt'                         as route,
         'breach:' || g.erp_order_no || ':' || g.department_code as key,
         min(g.days_out)                  as days_out
    from (
      -- The tables, not `schedule_gantt`. That view joins six tables to return
      -- twenty columns; this wants four, and every column it does not want is
      -- another table applying its row-level policy.
      select o.erp_order_no,
             d.code                as department_code,
             t.breach_reason,
             sl.stuffing_date::text as stuffing_date,
             (sl.stuffing_date - current_date)::integer as days_out
        from public.schedule_tasks t
        join public.schedule_runs r on r.id = t.run_id and r.is_current
        join public.shipment_lines sl on sl.id = t.shipment_line_id
        join public.orders o on o.id = sl.order_id
        join public.departments d on d.id = t.department_id
       where not t.is_feasible
    ) g
   group by g.erp_order_no, g.department_code;

grant select on public.attention_breach to authenticated;

create view public.attention_overloaded
with (security_invoker = true) as
-- A department asked for more than it can make. The triage already labels
  -- what is still possible at that lead time, and that label decides the
  -- severity: under a fortnight the answer stops being overtime and becomes a
  -- phone call to the customer.
  select 'overloaded' as kind,
         case when t.days_out < 15 then 'critical' else 'warning' end as severity,
         t.department_code || ' is over capacity on ' || t.load_date as title,
         'Asked for ' || round(100 * t.over_by)::text || '% more than it can make · ' ||
           replace(t.still_possible, '_', ' ') as detail,
         '/heatmap' as route,
         'overloaded:' || t.department_code || ':' || t.load_date as key,
         t.days_out as days_out
    from public.schedule_flag_triage t
    join public.schedule_runs r on r.id = t.run_id and r.is_current
   where t.days_out >= 0;

grant select on public.attention_overloaded to authenticated;

create view public.attention_material_late
with (security_invoker = true) as
-- Past the day it had to be ordered. The one finding here that cannot be
  -- fixed by working harder later.
  select 'material-late' as kind,
         'critical' as severity,
         'Order ' || m.material_name || ' now — the date has passed' as title,
         'Needed ' || m.first_needed_on || ' · ' ||
           coalesce(m.supplier_code, 'no supplier') || ' · ' ||
           m.lead_time_days || ' day lead' as detail,
         '/material' as route,
         'material-late:' || m.material_code as key,
         0 as days_out
    from public.material_shortage m
   where m.order_now;

grant select on public.attention_material_late to authenticated;

create view public.attention_material_short
with (security_invoker = true) as
select 'material-short' as kind,
         'warning' as severity,
         m.material_name || ' is short by ' || round(m.shortfall)::text || ' ' || m.uom as title,
         'Needed ' || m.first_needed_on || ' · ' || round(m.qty_on_hand)::text ||
           ' on hand against ' || round(m.qty_required)::text as detail,
         '/material' as route,
         'material-short:' || m.material_code as key,
         (m.first_needed_on::date - current_date) as days_out
    from public.material_shortage m
   where m.status = 'short' and not m.order_now;

grant select on public.attention_material_short to authenticated;

create view public.attention_route_conflict
with (security_invoker = true) as
-- A D-minus that contradicts the route holds work behind something not yet
  -- due and raises breaches that are not real, which makes every other finding
  -- on this list less trustworthy. Critical for that reason rather than its own.
  select 'route-conflict' as kind,
         case when c.affects_scheduling then 'critical' else 'info' end as severity,
         c.later_department_name || ' is due before ' || c.earlier_department_name ||
           ', which comes first' as title,
         c.article_code || ' · D-' || c.later_dminus::text || ' against D-' ||
           c.earlier_dminus::text ||
           case when c.affects_scheduling
                then ' · this is raising breaches that are not real'
                else ' · not on this article''s route, so nothing is breaking yet'
           end as detail,
         '/capacity' as route,
         'route-conflict:' || c.article_code || ':' || c.later_department_code as key,
         0 as days_out
    from public.route_order_conflicts c;

grant select on public.attention_route_conflict to authenticated;

create view public.attention_machine_down
with (security_invoker = true) as
select 'machine-down' as kind,
         'warning' as severity,
         s.department_name || ' is running ' || s.available::text || ' of ' ||
           s.machines::text || ' machines' as title,
         'The day is at ' || round(s.available_pct)::text || '% of its normal capacity' as detail,
         '/masters' as route,
         'machine-down:' || s.department_code as key,
         0 as days_out
    from public.machine_status s
   where s.available < s.machines;

grant select on public.attention_machine_down to authenticated;

create view public.attention_article_unplannable
with (security_invoker = true) as
-- An article nobody can plan is a silent hole in the order book: orders
  -- against it simply produce nothing, with no error anywhere.
  select 'article-unplannable' as kind,
         'warning' as severity,
         a.name || ' cannot be scheduled' as title,
         case when a.departments_routed = 0
              then 'It has no route — no department makes it'
              else a.missing_dminus::text || ' of its departments have no D-minus'
         end as detail,
         '/capacity' as route,
         'article-unplannable:' || a.code as key,
         0 as days_out
    from public.article_master a
   where a.is_active and not a.can_schedule and a.open_orders > 0;

grant select on public.attention_article_unplannable to authenticated;

create view public.attention_handover
with (security_invoker = true) as
-- Declared by one bench and never counted in by the next. Information rather
  -- than a warning: it is a conversation, not a crisis, but it is exactly the
  -- kind of thing nobody notices for a fortnight.
  select 'handover' as kind,
         'info' as severity,
         w.from_department_name || ' handed over ' || round(w.qty_declared)::text ||
           ' nobody has counted in' as title,
         w.article_code || ' · ' || w.component_code || ' · declared ' || w.production_date as detail,
         '/production' as route,
         -- The accepting department belongs in the key. One declaration can be
         -- owed to two departments where the route forks, and keying on the
         -- declaration alone produced two findings with the same identity —
         -- which React noticed before any test did, because the parity fixture
         -- is a single line and cannot fork.
         'handover:' || w.declaration_id::text || ':' || w.accepting_department_code as key,
         (w.stuffing_date::date - current_date) as days_out
    from public.wip_pending_acceptance w;

grant select on public.attention_handover to authenticated;


-- The whole list, as one thing. Kept because it is the honest definition of
-- what the screen shows, and because a caller that can afford one query should
-- be able to make one.
create or replace view public.attention
with (security_invoker = true) as
  select kind, severity, title, detail, route, key, days_out
    from public.attention_breach
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_overloaded
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_material_late
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_material_short
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_route_conflict
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_machine_down
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_article_unplannable
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_handover;

comment on view public.attention is
  'Every finding the software already makes, in one list. Each finding also has its own view — the union costs more than the API allows once row-level security is paid on eight nested views, so the screen asks for them in parallel.';
