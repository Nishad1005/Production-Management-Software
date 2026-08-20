-- Kram Phase 9 — attention.
--
-- Slide 2 of the concept deck lists five objectives. The fifth is "create
-- alerts for timely response without getting into crisis points", and until now
-- nothing in Kram did it. Every finding the software makes has required
-- somebody to open the right screen and look — which is fine on the day
-- somebody thinks to look, and useless on the day they do not.
--
-- ---------------------------------------------------------------------------
-- This view computes nothing.
--
-- Every row below is a finding some existing view already makes: the flag
-- triage, the material shortage, the machine status, the route-order guard.
-- Recomputing any of them here would be a second implementation to be wrong,
-- and the two would disagree on screen without either being obviously at fault.
-- So this is a union and a severity, nothing else.
--
-- ---------------------------------------------------------------------------
-- There is deliberately no way to dismiss one.
--
-- An alert somebody can silence while it is still true becomes wallpaper, and
-- an acknowledgement that expires "when it changes" needs a definition of
-- change that is guesswork for most of these. The list is kept readable by
-- being short — severity first, soonest first — and every row names the screen
-- that fixes it.
--
-- If it turns out to be unreadable in use, that is evidence for building
-- acknowledgement, not a reason to have built it now.
-- ---------------------------------------------------------------------------

create view public.attention
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
      select gg.erp_order_no,
             gg.department_code,
             gg.breach_reason,
             gg.stuffing_date,
             (gg.stuffing_date::date - current_date)::integer as days_out
        from public.schedule_gantt gg
        join public.schedule_runs r on r.id = gg.run_id and r.is_current
       where not gg.is_feasible
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
  'Every finding the software already makes, in one list, ordered by severity and how soon it bites. Computes nothing of its own — each row is another view''s conclusion.';

grant select on public.attention to authenticated;

-- The count for the header. A separate view so a badge costs one small query
-- rather than fetching every finding on every screen.
create view public.attention_count
with (security_invoker = true) as
  select count(*) filter (where severity = 'critical')::integer as critical,
         count(*) filter (where severity = 'warning')::integer  as warning,
         count(*) filter (where severity = 'info')::integer     as info,
         count(*)::integer                                      as total
    from public.attention;

grant select on public.attention_count to authenticated;
