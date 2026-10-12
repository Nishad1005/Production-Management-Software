-- Kram — taking an order against the plan, on the record.
--
-- ---------------------------------------------------------------------------
-- Raised by Nishad on 12 Oct, reading the order journey (KRAM/12): "there are
-- times when U&M accepts an order even when it is not possible according to
-- plan". The software already allows it — the Order book takes any order,
-- the Schedule then shows which departments break, Attention lists them,
-- What if says what overtime would do — but nothing records that it was a
-- decision. Three weeks later the breach looks like a surprise, and the
-- merchandiser who just checked the order on Accept an order has to type it
-- again on the Order book.
--
-- Three columns on orders: whether it was taken against the plan, why, and
-- how many steps the check said could not be made at the time. create_order
-- takes them (a new parameter is a new signature, so the old one goes — a
-- second overload would leave PostgREST with two functions of one name), and
-- refuses an order taken against the plan with no reason: a decision with no
-- reason is indistinguishable from a mistake six weeks later, as a pin is.
-- order_book carries the three; attention_breach's detail says "taken against
-- the plan: <reason>" so the card is a reminder of a decision rather than a
-- new alarm. The breach is still listed — it is still real.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column accepted_against_plan boolean not null default false,
  add column acceptance_note text,
  add column breaches_at_acceptance integer;

comment on column public.orders.accepted_against_plan is
  'True when the order was entered knowing the plan could not make it as it stood.';
comment on column public.orders.acceptance_note is
  'Why it was taken anyway, in the merchandiser''s words. Required when accepted_against_plan.';
comment on column public.orders.breaches_at_acceptance is
  'How many steps the acceptance check said could not be made, at the time it was entered.';

drop function public.create_order(
  text, uuid, uuid, numeric, date, public.order_confidence, date, text, date);

create or replace function public.create_order(
  p_erp_order_no text,
  p_customer_id uuid,
  p_article_id uuid,
  p_qty numeric,
  p_stuffing_date date,
  p_confidence public.order_confidence default 'confirmed',
  p_delivery_date date default null,
  p_container_ref text default null,
  p_material_ready_date date default null,
  p_accepted_against_plan boolean default false,
  p_acceptance_note text default null,
  p_breaches_at_acceptance integer default null
)
returns uuid
language plpgsql
as $$
declare
  v_order_id uuid;
begin
  if coalesce(p_accepted_against_plan, false)
     and coalesce(btrim(p_acceptance_note), '') = '' then
    raise exception 'An order taken against the plan needs a reason';
  end if;

  insert into public.orders
    (erp_order_no, customer_id, article_id, total_qty, confidence, order_date,
     accepted_against_plan, acceptance_note, breaches_at_acceptance)
  values (p_erp_order_no, p_customer_id, p_article_id, p_qty, p_confidence, current_date,
          coalesce(p_accepted_against_plan, false),
          nullif(btrim(p_acceptance_note), ''),
          p_breaches_at_acceptance)
  returning id into v_order_id;

  insert into public.shipment_lines
    (order_id, line_no, qty, stuffing_date, delivery_date, container_ref,
     material_ready_date)
  values (v_order_id, 1, p_qty, p_stuffing_date, p_delivery_date, p_container_ref,
          p_material_ready_date);

  return v_order_id;
end;
$$;

comment on function public.create_order is
  'Creates an order with its first shipment line. Taken against the plan needs a reason, which is kept on the order.';

revoke execute on function public.create_order(
  text, uuid, uuid, numeric, date, public.order_confidence, date, text, date,
  boolean, text, integer) from public, anon;
grant execute on function public.create_order(
  text, uuid, uuid, numeric, date, public.order_confidence, date, text, date,
  boolean, text, integer) to authenticated;

-- The book carries the decision. Columns appended, so every reader of the
-- view is unchanged.
create or replace view public.order_book
with (security_invoker = true) as
  select o.id as order_id,
         o.erp_order_no,
         cu.name as customer_name,
         a.code as article_code,
         o.total_qty::float8 as total_qty,
         o.confidence::text as confidence,
         o.status::text as status,
         r.line_count::integer as line_count,
         r.unallocated_qty::float8 as unallocated_qty,
         (select min(sl.stuffing_date)::text from public.shipment_lines sl
           where sl.order_id = o.id) as next_stuffing,
         (select count(*)::integer
            from public.schedule_tasks t
            join public.shipment_lines sl on sl.id = t.shipment_line_id
            join public.schedule_runs run on run.id = t.run_id and run.is_current
           where sl.order_id = o.id and not t.is_feasible) as breaches,
         o.accepted_against_plan,
         o.acceptance_note,
         o.breaches_at_acceptance
    from public.orders o
    join public.customers cu on cu.id = o.customer_id
    join public.articles a on a.id = o.article_id
    join public.order_qty_reconciliation r on r.order_id = o.id
   where cu.code <> '__ACCEPTANCE_CHECK__';

grant select on public.order_book to authenticated;

-- The card says it was a decision. Same columns, so the attention union
-- needs no change.
create or replace view public.attention_breach
with (security_invoker = true) as
  select 'breach'                         as kind,
         case when min(g.days_out) < 15 then 'critical' else 'warning' end as severity,
         g.department_code || ' cannot make ' || g.erp_order_no || ' as planned'
                                          as title,
         max(g.breach_reason::text) || ' · ships ' || min(g.stuffing_date)
           || case when bool_or(g.accepted_against_plan)
                   then ' · taken against the plan: ' || coalesce(max(g.acceptance_note), '')
                   else '' end            as detail,
         '/gantt'                         as route,
         'breach:' || g.erp_order_no || ':' || g.department_code as key,
         min(g.days_out)                  as days_out
    from (
      select o.erp_order_no,
             d.code                as department_code,
             t.breach_reason,
             sl.stuffing_date::text as stuffing_date,
             (sl.stuffing_date - current_date)::integer as days_out,
             o.accepted_against_plan,
             o.acceptance_note
        from public.schedule_tasks t
        join public.shipment_lines sl on sl.id = t.shipment_line_id
        join public.orders o on o.id = sl.order_id
        join public.departments d on d.id = t.department_id
       where t.run_id = public.current_run_id()
         and not t.is_feasible
         and t.breach_reason is distinct from 'late'
    ) g
   group by g.erp_order_no, g.department_code;

grant select on public.attention_breach to authenticated;
