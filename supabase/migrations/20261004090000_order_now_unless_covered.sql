-- Kram — "order now" unless the store is *known* to cover it.
--
-- ---------------------------------------------------------------------------
-- Yesterday's fix went one case too far.
--
-- 20261003120000 stopped `order_now` firing for a material the store already
-- holds enough of, which was right. It did it by requiring the stock to have
-- been counted *and* found short — which also silenced the alert for a
-- material **nobody has counted at all**. Past its ordering date, quantity in
-- the store unknown, and the system said nothing: no critical finding on
-- Attention, and on the Material screen the sentence *Every material on the
-- plan can still be ordered in time*, which was false.
--
-- That is the outcome this project exists to avoid — wrong in a way that looks
-- normal on screen — and it traded a false alarm for a false all-clear, which
-- is the worse of the two. It was also against the screen as designed: the
-- order card has always carried the line *Nobody has counted this one — it may
-- already be in the store*, which is only ever shown for exactly this case.
--
-- Not knowing is not the same as having enough. `order_now` is now: the date
-- has passed, and the store is not known to cover the need. Three cases:
--
--   counted, enough     → no alert          (yesterday's fix, kept)
--   counted, short      → alert
--   never counted       → alert             (restored)
--
-- Nothing on the hosted project was affected in the day between: it holds no
-- bill of materials, so `material_shortage` returns no rows there.
--
-- Regenerated from the text of 20261003120000 with that one expression
-- changed; the column list is identical.
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
         -- Past its ordering date, and the store is not known to hold enough.
         -- A count that covers the need is the only thing that clears it; no
         -- count at all is a reason to look, not a reason to stay quiet.
         (n.first_order_by < current_date::text
            and (st.material_id is null
                 or st.qty_on_hand < n.qty_required)) as order_now,
         n.jobs::integer
    from needed n
    join public.materials m on m.code = n.material_code
    left join public.material_stock st on st.material_id = m.id
    left join public.suppliers sup on sup.id = m.supplier_id;
