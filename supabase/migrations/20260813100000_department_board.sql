-- Kram — the department's own board.
--
-- U&M, asked what a per-department dashboard should hold: "what are the pending
-- remaining for that day, work order or according to their shipping date, and
-- from which department a component has to come so as to I can start my work."
--
-- Three questions, and the third is the one nothing here could answer yet:
--
--   What is left for me to do?          → department_queue
--   In what order?                      → by the container it ships in
--   What am I waiting for, and on whom?  → department_inbound
--
-- The first two are a different cut of data that already exists. The third is
-- new, and it is the mirror of the acceptance queue: that one says what has
-- arrived, this one says what has not.

-- ---------------------------------------------------------------------------
-- Everything this department still owes, soonest container first.
--
-- Ordering by the stuffing date rather than the department's own deadline is
-- deliberate. Its own deadline is derived — move a D-minus and it shifts — but
-- the container sails when it sails, and that is the thing a supervisor is
-- actually being held to.
-- ---------------------------------------------------------------------------
create view public.department_queue
with (security_invoker = true) as
  select d.code                     as department_code,
         d.name                     as department_name,
         o.erp_order_no,
         cu.code                    as customer_code,
         a.code                     as article_code,
         a.name                     as article_name,
         c.code                     as component_code,
         sl.id                      as shipment_line_id,
         sl.line_no,
         sl.stuffing_date::text     as stuffing_date,
         -- Negative once the container is behind us, which is a state worth
         -- seeing rather than clamping to zero.
         (sl.stuffing_date - current_date)::integer as days_to_stuffing,
         t.due_date::text           as due_date,
         (t.due_date - current_date)::integer       as days_to_due,
         t.qty_required::float8     as qty_required,
         coalesce(done.qty_good, 0)::float8         as qty_done,
         greatest(t.qty_required - coalesce(done.qty_good, 0), 0)::float8
                                    as qty_remaining,
         coalesce(done.qty_rejected, 0)::float8     as qty_rejected,
         done.last_declared::text   as last_declared,
         t.breach_reason,
         case
           when coalesce(done.qty_good, 0) >= t.qty_required then 'complete'
           when coalesce(done.qty_good, 0) > 0               then 'in progress'
           else 'not started'
         end                        as state
    from public.schedule_tasks t
    join public.schedule_runs r on r.id = t.run_id and r.is_current
    join public.departments d on d.id = t.department_id
    join public.components c on c.id = t.component_id
    join public.shipment_lines sl on sl.id = t.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id
    left join (
      select department_id, shipment_line_id, component_id,
             sum(qty_good) as qty_good,
             sum(qty_rejected) as qty_rejected,
             max(production_date) as last_declared
        from public.production_declarations
       group by department_id, shipment_line_id, component_id
    ) done
      on done.department_id = t.department_id
     and done.shipment_line_id = t.shipment_line_id
     and done.component_id = t.component_id;

comment on view public.department_queue is
  'What each department still owes, per shipment line and component, ordered by the container it ships in rather than by its own derived deadline.';

grant select on public.department_queue to authenticated;

-- ---------------------------------------------------------------------------
-- What this department is waiting for, and who owes it.
--
-- "From which department a component has to come so as to I can start my work."
--
-- Built from the route graph, not from guesswork: article_handover already says
-- who hands to whom for that article, reduced to nearest neighbours. For each
-- of my jobs it names the feeders, what they were asked for, what they have
-- actually made, and how much of it I have counted in.
--
-- The distinction between made and counted in matters on the floor. A feeder
-- can have finished while none of it has reached my bench, and those are
-- different problems with different people to talk to.
-- ---------------------------------------------------------------------------
create view public.department_inbound
with (security_invoker = true) as
  with mine as (
    select distinct
           t.department_id,
           t.shipment_line_id,
           o.article_id
      from public.schedule_tasks t
      join public.schedule_runs r on r.id = t.run_id and r.is_current
      join public.shipment_lines sl on sl.id = t.shipment_line_id
      join public.orders o on o.id = sl.order_id
  ),
  feeder_required as (
    select t.department_id, t.shipment_line_id, sum(t.qty_required) as qty_required,
           min(t.due_date) as due_date
      from public.schedule_tasks t
      join public.schedule_runs r on r.id = t.run_id and r.is_current
     group by t.department_id, t.shipment_line_id
  ),
  feeder_made as (
    select department_id, shipment_line_id,
           sum(qty_good) as qty_good,
           max(production_date) as last_declared
      from public.production_declarations
     group by department_id, shipment_line_id
  ),
  counted_in as (
    select acc.department_id, decl.shipment_line_id,
           sum(acc.qty_accepted) as qty_accepted
      from public.production_acceptances acc
      join public.production_declarations decl on decl.id = acc.declaration_id
     group by acc.department_id, decl.shipment_line_id
  )
  select d.code                    as department_code,
         f.code                    as from_department_code,
         f.name                    as from_department_name,
         f.route_position          as from_route_position,
         o.erp_order_no,
         a.code                    as article_code,
         sl.id                     as shipment_line_id,
         sl.stuffing_date::text    as stuffing_date,
         req.due_date::text        as their_due_date,
         -- Negative once they are late. This is what separates a feeder that
         -- is holding you up from one that simply is not due yet — without it
         -- every future job reads as "not started" and the board is a wall of
         -- things nobody can act on.
         (req.due_date - current_date)::integer as days_to_their_due,
         req.qty_required::float8  as qty_required,
         coalesce(made.qty_good, 0)::float8      as qty_made,
         coalesce(taken.qty_accepted, 0)::float8 as qty_counted_in,
         made.last_declared::text  as last_declared,
         case
           when coalesce(made.qty_good, 0) >= req.qty_required then 'ready'
           when coalesce(made.qty_good, 0) > 0                 then 'part made'
           else 'not started'
         end                       as state
    from mine
    join public.departments d on d.id = mine.department_id
    join public.article_handover h
      on h.article_id = mine.article_id
     and h.to_department_id = mine.department_id
    join public.departments f on f.id = h.from_department_id
    join feeder_required req
      on req.department_id = h.from_department_id
     and req.shipment_line_id = mine.shipment_line_id
    join public.shipment_lines sl on sl.id = mine.shipment_line_id
    join public.orders o on o.id = sl.order_id
    join public.articles a on a.id = o.article_id
    left join feeder_made made
      on made.department_id = h.from_department_id
     and made.shipment_line_id = mine.shipment_line_id
    left join counted_in taken
      on taken.department_id = mine.department_id
     and taken.shipment_line_id = mine.shipment_line_id;

comment on view public.department_inbound is
  'For each of a department''s jobs, which departments feed it, what they owe, what they have made, and how much has been counted in.';

grant select on public.department_inbound to authenticated;
