-- Kram — article_handover again, in a form the planner cannot make quadratic.
--
-- ---------------------------------------------------------------------------
-- 20261003090000 was pushed an hour ago and was not enough.
--
-- It replaced a correlated `not exists` with a left join against a `bypassed`
-- set, on the theory that the correlation was the cost. On the hosted project
-- that took the view from *cancelled at eight seconds* to *7.9 seconds* —
-- returning, and useless.
--
-- The theory was half right, and the half that was wrong is the instructive
-- one. Run locally **as a signed-in user rather than as the table owner**, the
-- plan is a Nested Loop Anti Join with 7.8 million rows removed by the join
-- filter. As the owner the same query is a hash anti-join and takes five
-- milliseconds. The difference is row-level security: every scan carries a
-- policy filter the planner cannot see through, its row estimates collapse,
-- the CTEs look tiny, and a nested loop looks cheap. The rewrite kept the
-- anti-join, so it kept the trap.
--
-- `except` does not have one. It is planned as a hashed set operation
-- regardless of estimates — there is no nested-loop form of it to fall into.
--
-- The first attempt was pushed before it had been measured under row-level
-- security, because the local suite ran it as the owner and reported four
-- milliseconds for old and new alike. That is §5's oldest lesson, paid for
-- once more: the owner bypasses the thing being measured. The diagnosis that
-- finally worked — `becomeUser`, then `explain analyze` — has been available
-- in the test helpers since August.
--
-- Same rows as both predecessors; `tests/article-handover.test.ts` compares
-- against the original text.
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
  -- Transitive reduction, as a set difference: every pair, less the ones
  -- something bypasses. EXCEPT is planned as a hashed set operation whatever
  -- the row estimates say, which a join — anti or otherwise — is not.
  select article_id,
         from_id as from_department_id,
         to_id   as to_department_id
    from pairs
  except
  select article_id, from_id, to_id
    from bypassed;

comment on view public.article_handover is
  'For each article, which department hands work to which — the route graph restricted to the departments that article passes through, reduced to nearest neighbours.';
