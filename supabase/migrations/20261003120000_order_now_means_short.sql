-- Kram — "order now" has to mean there is something to order.
--
-- ---------------------------------------------------------------------------
-- Found by a test that had passed for six weeks and then stopped.
--
-- `order_now` was `first_order_by < current_date` and nothing else. A material
-- whose ordering date had passed was reported as *Order now — the date has
-- passed*, critical, on the Attention screen and at the top of the Material
-- screen — **whether or not the store already held enough of it**. A million
-- cubic feet of oak on hand against a need for two hundred raised the most
-- urgent alert the system has.
--
-- Nothing showed it in August because every fixture's ordering date was still
-- in the future. `tests/attention.test.ts` asserts that a material the stock
-- covers raises nothing; on 3 Oct the fixture's ordering date slid into the
-- past and the assertion started failing, correctly. Time found a bug that no
-- test written on one day could.
--
-- `order_now` is now: the date has passed, the stock has been counted, and the
-- count falls short. An uncounted material stays out, as it already does for
-- shortages — the screen says *not counted*, which is the true statement.
--
-- Regenerated from the text of 20260817100000 with that one expression
-- changed; the column list is identical, so every reader is undisturbed.
-- ---------------------------------------------------------------------------

create or replace view public.material_shortage
with (security_invoker = true) as
  with needed as (
    select material_code,
           sum(qty_required) as qty_required,
           min(needed_on) as first_needed_on,
           min(order_by) as first_order_by,
           count(*) as jobs
      from public.material_requirements
     group by material_code
  )
  select m.code                as material_code,
         m.name                as material_name,
         m.category,
         m.uom,
         sup.code              as supplier_code,
         coalesce(m.lead_time_days, sup.lead_time_days, 0) as lead_time_days,
         n.qty_required::float8,
         st.qty_on_hand::float8,
         st.counted_on::text,
         (st.material_id is not null) as stock_known,
         case when st.material_id is not null
              then greatest(n.qty_required - st.qty_on_hand, 0)::float8
         end as shortfall,
         case when st.material_id is null then 'not counted'
              when st.qty_on_hand >= n.qty_required then 'covered'
              else 'short'
         end as status,
         n.first_needed_on,
         n.first_order_by,
         -- Past its ordering date *and* not covered by what the store holds.
         -- The date alone is not a reason to order anything.
         (n.first_order_by < current_date::text
            and st.material_id is not null
            and st.qty_on_hand < n.qty_required) as order_now,
         n.jobs::integer
    from needed n
    join public.materials m on m.code = n.material_code
    left join public.material_stock st on st.material_id = m.id
    left join public.suppliers sup on sup.id = m.supplier_id;
