-- Kram — article_master and attention, computed once instead of per row.
--
-- ---------------------------------------------------------------------------
-- Where the last of it was going.
--
-- Timed on the live project after the previous two fixes:
--
--     ok   article_master    931 ms ·  71 rows
--     ok   capacity_sheet   1011 ms · 994 rows
--     FAIL attention —
--
-- `attention` unions eight findings and the heaviest was `article_master`, so
-- the alert screen was still being cancelled at the API's eight seconds.
--
-- 931 ms for seventy-one rows is the shape of a **correlated** subquery: the
-- lateral ran once per article, and each run walked that article's bill of
-- materials and rates with every underlying table applying its row-level policy.
-- Seventy-one small scans cost far more than one pass over the same 994 rows.
--
-- ---------------------------------------------------------------------------
-- Two changes, both the same idea.
--
-- `article_master` now aggregates the whole bill of materials once in a CTE and
-- joins the result, rather than asking per article. `attention`'s breach branch
-- reads `schedule_tasks` and the four tables it needs, rather than
-- `schedule_gantt` — the widest view in the schema, joining six tables to give
-- twenty columns where this wanted four.
--
-- Behaviour is unchanged in both; the article-master and attention suites are
-- what say so, and every one of them was written before any of this.
-- ---------------------------------------------------------------------------

create or replace view public.article_master
with (security_invoker = true) as
  with routed as (
    -- One pass over every article's bill of materials, not one per article.
    select b.article_id,
           count(distinct cr.department_id) as departments,
           count(distinct cr.department_id) filter (
             where adm.is_complete is not true
           ) as missing_dminus
      from public.article_bom b
      join public.component_rates cr on cr.component_id = b.component_id
      join public.departments d on d.id = cr.department_id and d.is_active
      left join public.article_dept_dminus adm
        on adm.article_id = b.article_id
       and adm.department_id = cr.department_id
     group by b.article_id
  ),
  order_counts as (
    select article_id, count(*) as open_orders
      from public.orders
     group by article_id
  )
  select a.code,
         a.name,
         a.category,
         a.is_active,
         a.unit_cost::float8 as unit_cost,
         coalesce(r.departments, 0)::integer    as departments_routed,
         coalesce(r.missing_dminus, 0)::integer as missing_dminus,
         (coalesce(r.departments, 0) > 0 and coalesce(r.missing_dminus, 0) = 0)
                                                as can_schedule,
         coalesce(o.open_orders, 0)::integer    as open_orders
    from public.articles a
    left join routed r on r.article_id = a.id
    left join order_counts o on o.article_id = a.id;

comment on view public.article_master is
  'Every article with what is stopping it scheduling. Aggregated once across the whole bill of materials: asking per article cost 931 ms for seventy-one rows on the live project, because row-level security is paid on every scan.';

-- ---------------------------------------------------------------------------
-- The breach branch, off the widest view in the schema.
--
-- `attention` unions eight findings and is read on every screen through the
-- header count, so each branch has to be cheap. This one went through
-- `schedule_gantt`, which joins orders, lines, articles, customers, departments
-- and components to return twenty columns — where the finding needs four. Under
-- `security_invoker` every one of those joins is a policy evaluated per row.
-- ---------------------------------------------------------------------------

create or replace view public.attention
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
   group by g.erp_order_no, g.department_code

  union all

  -- A department asked for more than it can make. The triage already labels
  -- what is still possible at that lead time, and that label decides the
  -- severity: under a fortnight the answer stops being overtime and becomes a
  -- phone call to the customer.
  select 'overloaded',
         case when t.days_out < 15 then 'critical' else 'warning' end,
         t.department_code || ' is over capacity on ' || t.load_date,
         'Asked for ' || round(100 * t.over_by)::text || '% more than it can make · ' ||
           replace(t.still_possible, '_', ' '),
         '/heatmap',
         'overloaded:' || t.department_code || ':' || t.load_date,
         t.days_out
    from public.schedule_flag_triage t
    join public.schedule_runs r on r.id = t.run_id and r.is_current
   where t.days_out >= 0

  union all

  -- Past the day it had to be ordered. The one finding here that cannot be
  -- fixed by working harder later.
  select 'material-late',
         'critical',
         'Order ' || m.material_name || ' now — the date has passed',
         'Needed ' || m.first_needed_on || ' · ' ||
           coalesce(m.supplier_code, 'no supplier') || ' · ' ||
           m.lead_time_days || ' day lead',
         '/material',
         'material-late:' || m.material_code,
         0
    from public.material_shortage m
   where m.order_now

  union all

  select 'material-short',
         'warning',
         m.material_name || ' is short by ' || round(m.shortfall)::text || ' ' || m.uom,
         'Needed ' || m.first_needed_on || ' · ' || round(m.qty_on_hand)::text ||
           ' on hand against ' || round(m.qty_required)::text,
         '/material',
         'material-short:' || m.material_code,
         (m.first_needed_on::date - current_date)
    from public.material_shortage m
   where m.status = 'short' and not m.order_now

  union all

  -- A D-minus that contradicts the route holds work behind something not yet
  -- due and raises breaches that are not real, which makes every other finding
  -- on this list less trustworthy. Critical for that reason rather than its own.
  select 'route-conflict',
         case when c.affects_scheduling then 'critical' else 'info' end,
         c.later_department_name || ' is due before ' || c.earlier_department_name ||
           ', which comes first',
         c.article_code || ' · D-' || c.later_dminus::text || ' against D-' ||
           c.earlier_dminus::text ||
           case when c.affects_scheduling
                then ' · this is raising breaches that are not real'
                else ' · not on this article''s route, so nothing is breaking yet'
           end,
         '/capacity',
         'route-conflict:' || c.article_code || ':' || c.later_department_code,
         0
    from public.route_order_conflicts c

  union all

  select 'machine-down',
         'warning',
         s.department_name || ' is running ' || s.available::text || ' of ' ||
           s.machines::text || ' machines',
         'The day is at ' || round(s.available_pct)::text || '% of its normal capacity',
         '/masters',
         'machine-down:' || s.department_code,
         0
    from public.machine_status s
   where s.available < s.machines

  union all

  -- An article nobody can plan is a silent hole in the order book: orders
  -- against it simply produce nothing, with no error anywhere.
  select 'article-unplannable',
         'warning',
         a.name || ' cannot be scheduled',
         case when a.departments_routed = 0
              then 'It has no route — no department makes it'
              else a.missing_dminus::text || ' of its departments have no D-minus'
         end,
         '/capacity',
         'article-unplannable:' || a.code,
         0
    from public.article_master a
   where a.is_active and not a.can_schedule and a.open_orders > 0

  union all

  -- Declared by one bench and never counted in by the next. Information rather
  -- than a warning: it is a conversation, not a crisis, but it is exactly the
  -- kind of thing nobody notices for a fortnight.
  select 'handover',
         'info',
         w.from_department_name || ' handed over ' || round(w.qty_declared)::text ||
           ' nobody has counted in',
         w.article_code || ' · ' || w.component_code || ' · declared ' || w.production_date,
         '/production',
         -- The accepting department belongs in the key. One declaration can be
         -- owed to two departments where the route forks, and keying on the
         -- declaration alone produced two findings with the same identity —
         -- which React noticed before any test did, because the parity fixture
         -- is a single line and cannot fork.
         'handover:' || w.declaration_id::text || ':' || w.accepting_department_code,
         (w.stuffing_date::date - current_date)
    from public.wip_pending_acceptance w;


comment on view public.attention is
  'Every finding the software already makes, in one list, ordered by severity and how soon it bites. Computes nothing of its own — each row is another view''s conclusion, read from the cheapest source that answers it.';
