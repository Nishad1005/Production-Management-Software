-- Kram — articles as a master.
--
-- Articles have been seeded since Phase 0 and there has never been a way to add
-- one without SQL. The capacity sheet's own empty state has been saying "add one
-- from Masters" for four days, pointing at a control that does not exist.
--
-- It matters more than it sounds. Everything downstream hangs off an article —
-- its route, its D-minus offsets, its rates, its orders — so the one thing
-- nobody could do without a developer was the first thing anybody entering real
-- data would need. In the finished system articles arrive from Panipuri, but
-- that import is blocked on a file U&M say will take time, and the PPC session
-- that fills in the real route cannot wait for it.

create or replace function public.set_article(
  p_code text,
  p_name text,
  p_category text default null
)
returns void
language plpgsql
as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_name text := nullif(btrim(p_name), '');
begin
  -- A blank code would insert as '' and then collide with the next blank one,
  -- reported as a unique-violation on a column the user cannot see.
  if v_code is null then
    raise exception 'an article needs a code';
  end if;
  if v_name is null then
    raise exception 'an article needs a name';
  end if;

  insert into public.articles (code, name, category)
  values (v_code, v_name, nullif(btrim(p_category), ''))
  on conflict (code) do update
    set name = excluded.name,
        category = coalesce(excluded.category, public.articles.category),
        -- Re-adding a code that was switched off brings it back. The
        -- alternative is a unique-violation on a row the sheet no longer
        -- shows, which reads as a bug rather than as a decision.
        is_active = true;

  -- The blank D-minus rows are created by the seed_dminus_for_article trigger,
  -- flagged incomplete: a new article stops scheduling until somebody enters
  -- the offsets, rather than scheduling on a silent zero.
end;
$$;

revoke execute on function public.set_article(text, text, text) from public, anon;
grant execute on function public.set_article(text, text, text) to authenticated;

comment on function public.set_article(text, text, text) is
  'Adds an article or corrects its name and category. Upserts by code, because loading real data is something you do more than once.';

create or replace function public.set_article_active(p_code text, p_is_active boolean)
returns void
language plpgsql
as $$
begin
  update public.articles set is_active = p_is_active where code = p_code;
  if not found then
    raise exception 'unknown article %', p_code;
  end if;
end;
$$;

revoke execute on function public.set_article_active(text, boolean) from public, anon;
grant execute on function public.set_article_active(text, boolean) to authenticated;

comment on function public.set_article_active(text, boolean) is
  'Switches an article off or back on. Soft delete only — orders already placed against it keep their plan, and their history.';

-- ---------------------------------------------------------------------------
-- What is stopping each article being scheduled.
--
-- The capacity sheet counts these across the whole grid; this says it per
-- article, which is what somebody entering a new one needs. An article is
-- schedulable when it has at least one department with a rate and every one of
-- those departments has a D-minus offset entered — the two conditions the
-- engine actually applies, rather than a third opinion about them.
-- ---------------------------------------------------------------------------
create view public.article_master
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
      select count(*) as departments,
             count(*) filter (
               where not coalesce(adm.is_complete, false)
             ) as missing_dminus
        from public.departments d
        join public.component_rates cr on cr.department_id = d.id
        join public.components c
          on c.id = cr.component_id and c.code = a.code || '::' || d.code
        left join public.article_dept_dminus adm
          on adm.article_id = a.id and adm.department_id = d.id
       where d.is_active
    ) routed
    cross join lateral (
      select count(*) as open_orders
        from public.orders o
       where o.article_id = a.id
    ) orders;

comment on view public.article_master is
  'Every article with what is stopping it scheduling: how many departments it is routed through, how many of those have no D-minus, and how many orders are already against it.';

grant select on public.article_master to authenticated;
