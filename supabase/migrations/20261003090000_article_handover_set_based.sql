-- Kram — article_handover, asked once instead of once per pair.
--
-- ---------------------------------------------------------------------------
-- Found by `verify:live`, an hour after the first real data went in.
--
--   FAIL attention_handover
--
-- U&M's sample planning sheet took the hosted project from fourteen departments
-- to twenty (six QC and ex-factory checkpoints) and the handover branch of the
-- Attention screen stopped returning inside the API's eight seconds. With it
-- went the screen: nine branches are fetched together and one failure fails
-- the lot.
--
-- Nothing was wrong with the data. `article_handover` works out, for every
-- article, which department hands work to which — the route graph restricted
-- to the departments that article passes through, reduced to nearest
-- neighbours. The reduction was a correlated `not exists` over a CTE: for each
-- reachable pair, scan the pairs again looking for a way round it. A CTE has
-- no index and no statistics, so that is a nested loop over the whole set, per
-- row — quadratic in the number of pairs, which itself grows with the square
-- of the route. It had been the slowest branch on the screen since it was
-- written (1.0–1.9 s on fourteen departments) and nobody had asked why.
--
-- And it pays that whether or not there is anything to hand over. The
-- recursive CTE is an optimisation fence, so the closure and its reduction are
-- computed for all seventy-two articles even when `production_declarations`
-- is empty — which, the moment the practice orders were purged, it was.
--
-- ---------------------------------------------------------------------------
-- The change is the last query only.
--
-- `bypassed` builds every pair that can be reached through an intermediate,
-- once, with a hash join; the result is `pairs` minus that set. Same rows —
-- `tests/article-handover.test.ts` holds the old text and the new side by side
-- on the twenty-department route and requires them to agree.
--
-- Regenerated from the text of 20260812140000, not retyped: the recursive
-- walk, `article_dept` and `pairs` are that migration's, unchanged.
-- ---------------------------------------------------------------------------

create or replace view public.article_handover
with (security_invoker = true) as
  with recursive down (root, node) as (
    select d.id, d.id from public.departments d where d.is_active
    union
    select r.root, dd.department_id
      from down r
      join public.department_dependencies dd
        on dd.depends_on_department_id = r.node
  ),
  article_dept as (
    select distinct b.article_id, cr.department_id
      from public.article_bom b
      join public.component_rates cr on cr.component_id = b.component_id
      join public.departments d on d.id = cr.department_id and d.is_active
  ),
  pairs as (
    select f.article_id, f.department_id as from_id, t.department_id as to_id
      from article_dept f
      join down on down.root = f.department_id
      join article_dept t
        on t.article_id = f.article_id
       and t.department_id = down.node
     where t.department_id <> f.department_id
  ),
  -- Every pair the same article can also reach by way of a department in
  -- between. Built once, as a set, rather than asked about once per pair.
  bypassed as (
    select distinct a.article_id, a.from_id, b.to_id
      from pairs a
      join pairs b
        on b.article_id = a.article_id
       and b.from_id = a.to_id
  )
  select p.article_id,
         p.from_id as from_department_id,
         p.to_id   as to_department_id
    from pairs p
    -- Transitive reduction: keep the pair only if nothing bypasses it.
    left join bypassed x
      on x.article_id = p.article_id
     and x.from_id = p.from_id
     and x.to_id = p.to_id
   where x.article_id is null;

comment on view public.article_handover is
  'For each article, which department hands work to which — the route graph restricted to the departments that article passes through, reduced to nearest neighbours.';
