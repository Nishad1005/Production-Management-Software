-- Kram Phase 3 — the WIP ledger's API surface.
--
-- Views to read, functions to write, as everywhere else: PostgREST exposes
-- tables, views and functions and never arbitrary SQL, so anything the client
-- needs has to exist here by name.

-- ---------------------------------------------------------------------------
-- What a department is meant to be doing today, and what it has said about it.
--
-- One row per planned job per shift, which is exactly the unique key of a
-- declaration — so the screen is a list of rows to fill in rather than a form
-- someone has to construct. A job with no declaration yet reads as zero rather
-- than as absent, because "nothing made" and "nobody has said" look identical
-- on a screen and are not the same thing; declaration_id is what tells them
-- apart.
-- ---------------------------------------------------------------------------
create view public.production_worklist
with (security_invoker = true) as
  select d.code                  as department_code,
         d.name                  as department_name,
         dl.load_date::text      as work_date,
         s.code                  as shift_code,
         sl.id                   as shipment_line_id,
         o.erp_order_no,
         a.code                  as article_code,
         c.code                  as component_code,
         c.name                  as component_name,
         dl.qty_planned::float8  as qty_planned,
         decl.id                 as declaration_id,
         coalesce(decl.qty_good, 0)::float8     as qty_good,
         coalesce(decl.qty_rejected, 0)::float8 as qty_rejected,
         decl.note               as declaration_note,
         t.due_date::text        as due_date,
         t.breach_reason
    from public.schedule_daily_load dl
    join public.schedule_runs r on r.id = dl.run_id and r.is_current
    join public.departments d on d.id = dl.department_id
    join public.components c on c.id = dl.component_id
    join public.shifts s on s.id = dl.shift_id
    join public.shipment_lines sl on sl.id = dl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
    left join public.schedule_tasks t
      on t.run_id = dl.run_id
     and t.shipment_line_id = dl.shipment_line_id
     and t.department_id = dl.department_id
     and t.component_id = dl.component_id
    left join public.production_declarations decl
      on decl.shipment_line_id = dl.shipment_line_id
     and decl.department_id = dl.department_id
     and decl.component_id = dl.component_id
     and decl.production_date = dl.load_date
     and decl.shift_id = dl.shift_id;

comment on view public.production_worklist is
  'Planned jobs for the current run, per department per day per shift, with whatever has been declared against them.';

grant select on public.production_worklist to authenticated;

-- ---------------------------------------------------------------------------
-- Work handed to a department that it has not yet counted.
--
-- Only where something was actually made: a declaration of zero good is a real
-- record — the department worked and produced nothing usable — but there is
-- nothing for the next bench to receive, and putting it in their queue would
-- ask them to confirm the absence of a delivery.
-- ---------------------------------------------------------------------------
create view public.wip_pending_acceptance
with (security_invoker = true) as
  select decl.id                 as declaration_id,
         accepting.code          as accepting_department_code,
         maker.code              as from_department_code,
         maker.name              as from_department_name,
         o.erp_order_no,
         a.code                  as article_code,
         c.code                  as component_code,
         c.name                  as component_name,
         decl.production_date::text as production_date,
         decl.qty_good::float8   as qty_declared,
         decl.qty_rejected::float8 as qty_rejected,
         decl.note               as declaration_note,
         sl.stuffing_date::text  as stuffing_date
    from public.production_declarations decl
    join public.shipment_lines sl on sl.id = decl.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
    join public.components c on c.id = decl.component_id
    join public.departments maker on maker.id = decl.department_id
    join public.article_handover h
      on h.article_id = o.article_id
     and h.from_department_id = decl.department_id
    join public.departments accepting on accepting.id = h.to_department_id
   where decl.qty_good > 0
     and not exists (
       select 1
         from public.production_acceptances acc
        where acc.declaration_id = decl.id
          and acc.department_id = h.to_department_id
     );

comment on view public.wip_pending_acceptance is
  'Declarations waiting to be counted in by the department they were handed to.';

grant select on public.wip_pending_acceptance to authenticated;

-- ---------------------------------------------------------------------------
-- Where a shipment line has actually got to.
--
-- Required and declared are aggregated separately and then joined. Summing both
-- across one join would multiply each by the other's row count, which is the
-- classic way a progress figure ends up plausible and wrong.
-- ---------------------------------------------------------------------------
create view public.wip_by_order
with (security_invoker = true) as
  with required as (
    select t.shipment_line_id,
           t.department_id,
           sum(t.qty_required) as qty_required
      from public.schedule_tasks t
      join public.schedule_runs r on r.id = t.run_id and r.is_current
     group by t.shipment_line_id, t.department_id
  ),
  done as (
    select decl.shipment_line_id,
           decl.department_id,
           sum(decl.qty_good) as qty_good,
           sum(decl.qty_rejected) as qty_rejected,
           max(decl.production_date) as last_declared
      from public.production_declarations decl
     group by decl.shipment_line_id, decl.department_id
  )
  select o.erp_order_no,
         cu.code                as customer_code,
         a.code                 as article_code,
         sl.id                  as shipment_line_id,
         sl.line_no,
         sl.qty::float8         as line_qty,
         sl.stuffing_date::text as stuffing_date,
         d.code                 as department_code,
         d.name                 as department_name,
         d.route_position,
         req.qty_required::float8 as qty_required,
         coalesce(dn.qty_good, 0)::float8     as qty_good,
         coalesce(dn.qty_rejected, 0)::float8 as qty_rejected,
         dn.last_declared::text as last_declared,
         case
           when coalesce(dn.qty_good, 0) = 0 then 'not started'
           when dn.qty_good >= req.qty_required then 'complete'
           else 'in progress'
         end as state,
         -- Guarded rather than left to divide by zero: a department with a
         -- required quantity of zero is not 0% done, it is not asked for.
         case when req.qty_required > 0
              then least(1.0, coalesce(dn.qty_good, 0) / req.qty_required)::float8
         end as fraction_done
    from required req
    join public.shipment_lines sl on sl.id = req.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id
    join public.departments d on d.id = req.department_id
    left join done dn
      on dn.shipment_line_id = req.shipment_line_id
     and dn.department_id = req.department_id;

comment on view public.wip_by_order is
  'How far each department has got on each shipment line: required by the current plan against declared good.';

grant select on public.wip_by_order to authenticated;

-- ---------------------------------------------------------------------------
-- Planned against actual, by department and day — the deck's "Daily Production"
-- KPI, and the first thing that can contradict a capacity figure.
-- ---------------------------------------------------------------------------
create view public.production_vs_plan
with (security_invoker = true) as
  with planned as (
    select dl.department_id, dl.load_date, sum(dl.qty_planned) as qty_planned
      from public.schedule_daily_load dl
      join public.schedule_runs r on r.id = dl.run_id and r.is_current
     group by dl.department_id, dl.load_date
  ),
  actual as (
    select department_id,
           production_date,
           sum(qty_good) as qty_good,
           sum(qty_rejected) as qty_rejected
      from public.production_declarations
     group by department_id, production_date
  )
  select d.code                as department_code,
         d.name                as department_name,
         d.route_position,
         coalesce(p.load_date, act.production_date)::text as work_date,
         coalesce(p.qty_planned, 0)::float8   as qty_planned,
         coalesce(act.qty_good, 0)::float8    as qty_good,
         coalesce(act.qty_rejected, 0)::float8 as qty_rejected,
         (coalesce(act.qty_good, 0) - coalesce(p.qty_planned, 0))::float8 as variance
    from planned p
    full join actual act
      on act.department_id = p.department_id
     and act.production_date = p.load_date
    join public.departments d
      on d.id = coalesce(p.department_id, act.department_id);

comment on view public.production_vs_plan is
  'Planned against declared, per department per day. A full join: a day with output and no plan is as interesting as the reverse.';

grant select on public.production_vs_plan to authenticated;

-- ---------------------------------------------------------------------------
-- Yield as measured, against yield as asserted.
--
-- The department master carries a planned yield that somebody typed. This is
-- the same number counted, and the gap between them is the point — it is what
-- turns the engine's quantities from an assumption into something with evidence
-- behind it. Nothing is corrected automatically: a rate that changes itself is
-- a rate nobody can explain.
-- ---------------------------------------------------------------------------
create view public.measured_yield
with (security_invoker = true) as
  select d.code as department_code,
         d.name as department_name,
         d.route_position,
         d.yield_pct::float8 as planned_yield_pct,
         sum(decl.qty_good)::float8 as qty_good,
         sum(decl.qty_rejected)::float8 as qty_rejected,
         case when sum(decl.qty_good + decl.qty_rejected) > 0
              then (100.0 * sum(decl.qty_good)
                    / sum(decl.qty_good + decl.qty_rejected))::float8
         end as measured_yield_pct,
         count(*) as declarations
    from public.production_declarations decl
    join public.departments d on d.id = decl.department_id
   group by d.code, d.name, d.route_position, d.yield_pct;

comment on view public.measured_yield is
  'Planned yield against yield as counted. Reported, never applied — a master that edits itself is one nobody can account for.';

grant select on public.measured_yield to authenticated;

-- ---------------------------------------------------------------------------
-- Writes.
-- ---------------------------------------------------------------------------

-- Upserts, so a correction to a day's figure replaces it rather than adding a
-- second row that silently doubles the day.
create or replace function public.declare_production(
  p_shipment_line_id uuid,
  p_department_code text,
  p_component_code text,
  p_date date,
  p_shift_code text,
  p_good numeric,
  p_rejected numeric default 0,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_department uuid;
  v_component uuid;
  v_shift uuid;
  v_id uuid;
begin
  select id into v_department from public.departments where code = p_department_code;
  select id into v_component from public.components where code = p_component_code;
  select id into v_shift from public.shifts where code = p_shift_code;

  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;
  if v_component is null then
    raise exception 'unknown component %', p_component_code;
  end if;
  if v_shift is null then
    raise exception 'unknown shift %', p_shift_code;
  end if;

  insert into public.production_declarations (
    shipment_line_id, department_id, component_id,
    production_date, shift_id, qty_good, qty_rejected, note
  )
  values (
    p_shipment_line_id, v_department, v_component,
    p_date, v_shift, p_good, coalesce(p_rejected, 0), p_note
  )
  on conflict (shipment_line_id, department_id, component_id, production_date, shift_id)
  do update set qty_good = excluded.qty_good,
                qty_rejected = excluded.qty_rejected,
                note = excluded.note
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.declare_production(
  uuid, text, text, date, text, numeric, numeric, text) from public, anon;
grant execute on function public.declare_production(
  uuid, text, text, date, text, numeric, numeric, text) to authenticated;

-- Refuses an acceptance from a department the work was never handed to. Without
-- it any department could count in anyone's output, and the ledger would record
-- handovers that never happened — which is worse than recording none, because
-- it looks like evidence.
create or replace function public.accept_production(
  p_declaration_id uuid,
  p_department_code text,
  p_qty numeric,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_department uuid;
  v_id uuid;
begin
  select id into v_department from public.departments where code = p_department_code;
  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;

  if not exists (
    select 1
      from public.production_declarations decl
      join public.shipment_lines sl on sl.id = decl.shipment_line_id
      join public.orders o on o.id = sl.order_id
      join public.article_handover h
        on h.article_id = o.article_id
       and h.from_department_id = decl.department_id
     where decl.id = p_declaration_id
       and h.to_department_id = v_department
  ) then
    raise exception
      'department % is not fed by the department that made this work',
      p_department_code;
  end if;

  insert into public.production_acceptances
    (declaration_id, department_id, qty_accepted, note)
  values (p_declaration_id, v_department, p_qty, p_note)
  on conflict (declaration_id, department_id)
  do update set qty_accepted = excluded.qty_accepted,
                note = excluded.note
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.accept_production(uuid, text, numeric, text)
  from public, anon;
grant execute on function public.accept_production(uuid, text, numeric, text)
  to authenticated;
