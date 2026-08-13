-- Kram — somewhere to type a cost, instead of a request for a spreadsheet.
--
-- WIP value was the one KPI with nothing behind it, and the ask attached to it
-- had grown into "flatten seventy-one costing workbooks into a twenty-five
-- column sheet". U&M said, reasonably, that they did not understand what was
-- wanted — for a feature they had already asked to defer.
--
-- The minimum was never that. One number per article — the total on the last
-- page of their own costing sheet, ~₹16,760 for the DF 24. The category split
-- would only say *where* along the route the value sits; for a headline figure,
-- the total multiplied by how far through the route the work has got is enough,
-- as long as the screen says that is what it is.
--
-- So this is a box, not a request. It sits on the capacity sheet beside the
-- D-minus and the rates, it is never required, and the figure covers whatever
-- has been filled in and says how much of the floor that is.

alter table public.articles
  add column if not exists unit_cost numeric(14, 2)
    check (unit_cost is null or unit_cost >= 0);

comment on column public.articles.unit_cost is
  'What one unit costs to make, all in. Null means nobody has said — which is not zero, and is why WIP value reports coverage rather than a total that quietly omits half the floor.';

-- Plain function: the planner write policy on articles is the authorisation,
-- exactly as it is for every other master edit.
create or replace function public.set_article_cost(
  p_article_code text,
  p_cost numeric
)
returns void
language plpgsql
as $$
declare
  v_article uuid;
begin
  select id into v_article from public.articles where code = p_article_code;
  if v_article is null then
    raise exception 'unknown article %', p_article_code;
  end if;

  -- Null clears it back to "nobody has said". Passing zero would be a claim
  -- that the thing is free, and the dashboard would believe it.
  update public.articles set unit_cost = p_cost where id = v_article;
end;
$$;

revoke execute on function public.set_article_cost(text, numeric) from public, anon;
grant execute on function public.set_article_cost(text, numeric) to authenticated;

-- Trailing column, so the replace stays compatible with everything already
-- selecting from this view — the same trick used when is_routed was added.
create or replace view public.capacity_sheet
with (security_invoker = true) as
  select a.code as article_code,
         a.name as article_name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         rate.units_per_day::float8 as units_per_day,
         rate.manpower,
         adm.dminus_days,
         coalesce(adm.is_complete, false) as dminus_complete,
         exists (
           select 1
             from public.article_bom b
             join public.component_rates cr on cr.component_id = b.component_id
            where b.article_id = a.id and cr.department_id = d.id
         ) as is_routed,
         a.unit_cost::float8 as unit_cost
    from public.articles a
    cross join public.departments d
    left join public.article_dept_dminus adm
      on adm.article_id = a.id and adm.department_id = d.id
    left join lateral (
      select cr.units_per_day, cr.manpower
        from public.component_rates cr
        join public.components c on c.id = cr.component_id
       where cr.department_id = d.id
         and c.code = a.code || '::' || d.code
       limit 1
    ) rate on true
   where a.is_active and d.is_active;

-- ---------------------------------------------------------------------------
-- WIP value, computed from whatever has been filled in.
--
--   value = Σ over lines started-and-not-finished of
--             line quantity × the article's unit cost × how far through the
--             route that line has got
--
-- Two things make this honest rather than merely available.
--
-- It stays unavailable until at least one article actually in progress has a
-- cost. And when only some of them do, it carries a note saying so — a rupee
-- total that silently omits two thirds of the floor is worse than no total,
-- and this is the figure an MD quotes first.
-- ---------------------------------------------------------------------------
create or replace view public.md_dashboard
with (security_invoker = true) as
  with current_run as (
    select id from public.schedule_runs where is_current limit 1
  ),
  done as (
    select department_id, shipment_line_id, component_id,
           sum(qty_good) as qty_good,
           max(production_date) as finished
      from public.production_declarations
     group by department_id, shipment_line_id, component_id
  ),
  lines as (
    select sl.id,
           sl.qty,
           sl.stuffing_date,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as tasks,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id
               and t.breach_reason is not null) as breached,
           (select count(*) from public.schedule_tasks t
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id
               and t.breach_reason = 'material') as material_breached,
           (select bool_and(coalesce(d.qty_good, 0) >= t.qty_required)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as complete,
           (select bool_or(coalesce(d.qty_good, 0) > 0)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as started,
           (select bool_and(
                     coalesce(d.qty_good, 0) >= t.qty_required
                     and d.finished <= t.due_date)
              from public.schedule_tasks t
              left join done d
                on d.department_id = t.department_id
               and d.shipment_line_id = t.shipment_line_id
               and d.component_id = t.component_id
             where t.run_id = (select id from current_run)
               and t.shipment_line_id = sl.id) as on_time_in_full
      from public.shipment_lines sl
  ),
  -- Lines actually in progress, with the cost of what they are making.
  in_progress as (
    select w.line_qty,
           w.fraction_done,
           a.unit_cost
      from public.wip_lines w
      join public.articles a on a.code = w.article_code
     where w.started and not w.complete
  ),
  wip as (
    select count(*) as lines_running,
           count(unit_cost) as lines_costed,
           -- Cast before summing: wip_lines returns float8, and
           -- round(double precision, integer) is not a function that exists.
           sum((line_qty * unit_cost * fraction_done)::numeric) as value
      from in_progress
  ),
  recent as (
    select coalesce(sum(qty_good), 0) as good,
           coalesce(sum(qty_rejected), 0) as rejected
      from public.production_declarations
     where production_date >= current_date - 30
  ),
  today as (
    select coalesce(sum(qty_good), 0) as good
      from public.production_declarations
     where production_date = current_date
  ),
  planned_recent as (
    select coalesce(sum(dl.qty_planned), 0) as planned
      from public.schedule_daily_load dl
     where dl.run_id = (select id from current_run)
       and dl.load_date between current_date - 30 and current_date
  ),
  computed as (
    select 'orders_running' as key,
           (select count(*) from public.orders
             where status in ('open', 'in_production'))::numeric as actual,
           true as available, null::text as unavailable_because,
           null::text as note
    union all
    select 'otif',
           case when (select count(*) from lines where complete) > 0
                then round(100.0 * (select count(*) from lines where on_time_in_full)
                                 / (select count(*) from lines where complete), 1)
           end,
           (select count(*) from lines where complete) > 0,
           'No shipment line has been completed yet, so there is nothing to be on time about.',
           null
    union all
    select 'daily_production', (select good from today), true, null, null
    union all
    select 'wip_units',
           (select coalesce(sum(qty), 0) from lines
             where started and not complete)::numeric,
           true, null, null
    union all
    select 'wip_value',
           (select round(value, 0) from wip),
           (select lines_costed from wip) > 0,
           'No article in progress has a cost yet. Add one on the capacity sheet — one number per article is enough.',
           case
             when (select lines_costed from wip) = 0 then null
             when (select lines_costed from wip) < (select lines_running from wip)
               then 'covering ' || (select lines_costed from wip) || ' of '
                    || (select lines_running from wip) || ' lines in progress'
             else 'all ' || (select lines_running from wip) || ' lines in progress'
           end
    union all
    select 'efficiency',
           case when (select planned from planned_recent) > 0
                then round(100.0 * (select good from recent)
                                 / (select planned from planned_recent), 1)
           end,
           (select planned from planned_recent) > 0,
           'Nothing has been planned in the last 30 days to measure against.',
           null
    union all
    select 'rejections',
           case when (select good + rejected from recent) > 0
                then round(100.0 * (select rejected from recent)
                                 / (select good + rejected from recent), 2)
           end,
           (select good + rejected from recent) > 0,
           'Nothing has been declared in the last 30 days.',
           null
    union all
    select 'material_shortage',
           case when (select count(*) from lines where tasks > 0) > 0
                then round(100.0 * (select count(*) from lines where material_breached > 0)
                                 / (select count(*) from lines where tasks > 0), 1)
           end,
           (select count(*) from lines where tasks > 0) > 0,
           'Nothing is scheduled.', null
    union all
    select 'delayed_orders',
           case when (select count(*) from lines where tasks > 0) > 0
                then round(100.0 * (select count(*) from lines where breached > 0)
                                 / (select count(*) from lines where tasks > 0), 1)
           end,
           (select count(*) from lines where tasks > 0) > 0,
           'Nothing is scheduled.', null
    union all
    select 'containers_ready',
           (select count(*) from lines where complete)::numeric, true, null, null
  )
  select t.key,
         t.label,
         t.target::float8,
         t.unit,
         t.higher_is_better,
         t.sort_order,
         c.actual::float8,
         (c.available and c.actual is not null) as available,
         case when c.available and c.actual is not null
              then null else c.unavailable_because end as unavailable_because,
         case
           when not (c.available and c.actual is not null) then 'unavailable'
           when t.target = 0 then 'none'
           when t.higher_is_better and c.actual >= t.target then 'good'
           when t.higher_is_better and c.actual >= t.target * 0.9 then 'warn'
           when t.higher_is_better then 'bad'
           when c.actual <= t.target then 'good'
           when c.actual <= t.target * 1.5 then 'warn'
           else 'bad'
         end as status,
         -- Appended, not inserted: create-or-replace can only add columns at
         -- the end, and putting this beside unavailable_because where it reads
         -- better costs a drop.
         case when c.available and c.actual is not null then c.note end as note
    from public.kpi_targets t
    join computed c on c.key = t.key;

comment on view public.md_dashboard is
  'Slide 6''s KPIs plus WIP in units. WIP value computes from whatever article costs have been entered, and says how much of the floor that covers.';

grant select on public.md_dashboard to authenticated;
