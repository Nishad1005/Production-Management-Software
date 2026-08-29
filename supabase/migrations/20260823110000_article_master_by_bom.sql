-- Kram — article_master, joined through the bill of materials.
--
-- ---------------------------------------------------------------------------
-- What it was doing, and why only production could see the cost.
--
-- The view found an article's routed departments by *constructing* a component
-- code and matching on it:
--
--     join components c on c.id = cr.component_id
--                      and c.code = a.code || '::' || d.code
--
-- For every article, for every department, that walks `component_rates` and
-- `components` looking for a string. Locally, as the table owner, it measured
-- eight milliseconds across seventy-one articles and fourteen departments. On
-- Supabase, where `security_invoker` makes every one of those tables apply its
-- row-level policy, the same query passed the API's eight-second ceiling and was
-- cancelled — taking `attention` down with it, since that unions this view.
--
-- The Masters screen reads it. So this was not a scripting inconvenience: it was
-- a screen that would fail for U&M with a message nobody could act on.
--
-- Fourth time production has said something the local suite could not, and the
-- clearest yet about *why*: the tests run as the table owner and bypass RLS
-- entirely, so a policy's cost is invisible to every one of them.
--
-- ---------------------------------------------------------------------------
-- The fix is to ask the question the way the rest of the schema already does.
--
-- `capacity_sheet.is_routed` has never used the naming convention — it joins
-- `article_bom` to `component_rates`, both of which have real foreign keys and
-- indexes behind them. This view was the odd one out. Joining the same way is
-- faster, index-driven, and closer to what the sentence means: a department is
-- on an article's route when something in that article's bill of materials has
-- a rate there.
--
-- Behaviour is unchanged for every case that exists — the capacity sheet writes
-- exactly one stage component per article per department, so "the component
-- named ARTICLE::DEPT" and "a component of this article" pick out the same rows.
-- `tests/article-master.test.ts` is what says so.
-- ---------------------------------------------------------------------------

create or replace view public.article_master
with (security_invoker = true) as
  select a.code,
         a.name,
         a.category,
         a.is_active,
         a.unit_cost::float8 as unit_cost,
         routed.departments::integer as departments_routed,
         routed.missing_dminus::integer as missing_dminus,
         (routed.departments > 0 and routed.missing_dminus = 0) as can_schedule,
         orders.open_orders::integer as open_orders
    from public.articles a
    cross join lateral (
      -- Distinct departments, because a department running two shifts has two
      -- rates for the same component and is still one department.
      select count(distinct cr.department_id) as departments,
             count(distinct cr.department_id) filter (
               where not exists (
                 select 1
                   from public.article_dept_dminus adm
                  where adm.article_id = a.id
                    and adm.department_id = cr.department_id
                    and adm.is_complete
               )
             ) as missing_dminus
        from public.article_bom b
        join public.component_rates cr on cr.component_id = b.component_id
        join public.departments d on d.id = cr.department_id and d.is_active
       where b.article_id = a.id
    ) routed
    cross join lateral (
      select count(*) as open_orders
        from public.orders o
       where o.article_id = a.id
    ) orders;

comment on view public.article_master is
  'Every article with what is stopping it scheduling. Joined through article_bom rather than a constructed component code: the naming convention is not indexable, and under row-level security it cost more than the API allows.';
