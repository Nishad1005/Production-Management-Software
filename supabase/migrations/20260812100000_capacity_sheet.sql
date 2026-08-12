-- Kram — the capacity sheet, as a screen rather than a spreadsheet.
--
-- U&M maintain "Capacity Sheet Final.xlsx": one row per SKU, two columns per
-- department — Manpower and Units. Fourteen departments, seventy articles, and
-- every figure still blank. This is where those figures go instead.
--
-- The specification models component × department; the sheet is article ×
-- department. Both fit the same table, because nothing in the schema requires a
-- component to be a leg: a capacity cell creates a component standing for the
-- work that department does on that article. If wood is later broken down into
-- four legs and a seat frame, those components sit alongside these and the
-- engine treats them identically.

-- The crew size behind a rate. Distinct from department_shifts.sanctioned_
-- headcount, which is the establishment for a whole department on a shift —
-- this is how many of them it takes to hit this figure on this product.
alter table public.component_rates
  add column if not exists manpower integer check (manpower is null or manpower >= 0);

comment on column public.component_rates.manpower is
  'People needed to achieve units_per_day on this component. The Manpower column of U&M''s capacity sheet.';

-- ---------------------------------------------------------------------------
-- One cell of the sheet.
--
-- Passing null units clears the pairing entirely: the article does not pass
-- through that department. That is the common case across a 70 × 14 grid and
-- must be expressible, not merely left blank and ambiguous.
-- ---------------------------------------------------------------------------
create or replace function public.set_capacity_cell(
  p_article_code text,
  p_department_code text,
  p_units numeric default null,
  p_manpower integer default null
)
returns void
language plpgsql
as $$
declare
  v_article_id uuid;
  v_department_id uuid;
  v_component_code text;
  v_component_id uuid;
begin
  select id into v_article_id from public.articles where code = p_article_code;
  select id into v_department_id from public.departments where code = p_department_code;

  if v_article_id is null or v_department_id is null then
    raise exception 'No such article (%) or department (%)',
      p_article_code, p_department_code;
  end if;

  -- Deterministic from the pair, so re-running the sheet never duplicates.
  v_component_code := p_article_code || '::' || p_department_code;

  if p_units is null then
    -- Clearing the cell. The rate goes; the component and BOM row stay, because
    -- deleting them would take any WIP history recorded against them with it.
    delete from public.component_rates cr
     using public.components c
     where c.id = cr.component_id
       and c.code = v_component_code
       and cr.department_id = v_department_id;
    return;
  end if;

  insert into public.components (code, name, uom)
  values (v_component_code,
          p_department_code || ' work on ' || p_article_code,
          'NOS')
  on conflict (code) do nothing;

  select id into v_component_id from public.components where code = v_component_code;

  insert into public.article_bom (article_id, component_id, qty_per_unit)
  values (v_article_id, v_component_id, 1)
  on conflict (article_id, component_id) do nothing;

  -- Every shift the department actually works. A rate on a shift nobody works
  -- would be invisible; a shift with no rate contributes nothing while looking
  -- like it runs.
  insert into public.component_rates
    (component_id, department_id, shift_id, units_per_day, manpower)
  select v_component_id, v_department_id, ds.shift_id, p_units, p_manpower
    from public.department_shifts ds
    join public.shifts s on s.id = ds.shift_id and s.is_active
   where ds.department_id = v_department_id and ds.is_active
  on conflict (component_id, department_id, shift_id) do update
    set units_per_day = excluded.units_per_day,
        manpower = coalesce(excluded.manpower, component_rates.manpower);
end;
$$;

revoke execute on function public.set_capacity_cell(text, text, numeric, integer)
  from public, anon;
grant execute on function public.set_capacity_cell(text, text, numeric, integer)
  to authenticated;

-- create_department did not upsert, so loading a route twice failed on the
-- second run. Loading real data is inherently something you do more than once —
-- the sheet comes back corrected — so it now updates by code like every other
-- master. Same signature; only the conflict behaviour changes.
create or replace function public.create_department(
  p_code text,
  p_name text,
  p_route_position integer,
  p_yield_pct numeric default 98
)
returns uuid
language sql
as $$
  insert into public.departments (code, name, route_position, yield_pct)
  values (p_code, p_name, p_route_position, p_yield_pct)
  on conflict (code) do update
    set name = excluded.name,
        route_position = excluded.route_position,
        yield_pct = excluded.yield_pct,
        is_active = true
  returning id;
$$;

-- Articles had no creation path either — the same gap customers had, and for
-- the same reason: the offline seed ships one, so nothing ever needed to make
-- another. Seventy are about to arrive.
create or replace function public.create_article(
  p_code text,
  p_name text,
  p_category text default null
)
returns uuid
language sql
as $$
  insert into public.articles (code, name, category)
  values (p_code, p_name, p_category)
  on conflict (code) do update
    set name = excluded.name, category = coalesce(excluded.category, articles.category)
  returning id;
$$;

revoke execute on function public.create_article(text, text, text) from public, anon;
grant execute on function public.create_article(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The sheet itself: every article against every department, whether or not the
-- pairing exists. A blank cell is the answer "this article does not go through
-- here", and the grid has to be able to show that.
-- ---------------------------------------------------------------------------
create view public.capacity_sheet
with (security_invoker = true) as
  select a.code as article_code,
         a.name as article_name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         rate.units_per_day::float8 as units_per_day,
         rate.manpower,
         adm.dminus_days,
         coalesce(adm.is_complete, false) as dminus_complete
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

grant select on public.capacity_sheet to authenticated;

comment on view public.capacity_sheet is
  'U&M''s capacity sheet: article × department, with units, manpower and D-minus. A null unit figure means the article does not pass through that department.';
