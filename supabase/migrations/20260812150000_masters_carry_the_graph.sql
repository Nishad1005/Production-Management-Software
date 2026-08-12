-- Kram — the masters file was losing the route graph.
--
-- import_masters and the export beside it were written before
-- department_dependencies existed, and nobody went back. So the file carries
-- departments with their positions and yields, and not a single edge between
-- them. Export, apply to a fresh database, and every department becomes an
-- entry point: no runway checks at all, and yield collapsing to each
-- department's own because nothing is downstream of anything.
--
-- Which is the failure this project treats as the worst available — the plan
-- comes back looking entirely normal, with every date slightly wrong and every
-- quantity understated. Nothing errors.
--
-- It is on a path people have been sent down: docs/GUIDE.md tells them to save
-- the masters to a file after a session with PPC, precisely so that session's
-- work is not trapped in one browser. That file would have been missing the
-- structure PPC had just confirmed.
--
-- The round-trip browser check passed throughout, because it exports, changes
-- one number, re-imports and asserts that number came back. A check that only
-- proves one field survives says nothing about the ones that did not.

-- Edges as codes, which is what the file speaks. route_dependency_grid is every
-- ordered pair with a flag — right for a grid on screen, 182 rows of mostly
-- false for a file.
create view public.department_dependency_list
with (security_invoker = true) as
  select d.code    as department_code,
         f.code    as depends_on_code,
         d.route_position
    from public.department_dependencies dd
    join public.departments d on d.id = dd.department_id
    join public.departments f on f.id = dd.depends_on_department_id;

comment on view public.department_dependency_list is
  'The route graph as department codes, one row per edge — the form the masters file carries.';

grant select on public.department_dependency_list to authenticated;

create or replace function public.import_masters(p_file jsonb)
returns integer
language plpgsql
as $$
declare
  v_tables jsonb := p_file -> 'tables';
  v_applied integer := 0;
  v_n integer;
begin
  if (p_file ->> 'kram_masters') is null then
    raise exception 'This is not a Kram masters file';
  end if;

  insert into public.departments (code, name, route_position, yield_pct, is_active)
  select x.code, x.name, x.route_position, x.yield_pct, coalesce(x.is_active, true)
    from jsonb_to_recordset(coalesce(v_tables -> 'departments', '[]'::jsonb))
      as x (code text, name text, route_position integer, yield_pct numeric, is_active boolean)
  on conflict (code) do update
    set name = excluded.name,
        route_position = excluded.route_position,
        yield_pct = excluded.yield_pct,
        is_active = excluded.is_active;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  -- Straight after departments, because every edge references two of them.
  --
  -- Replaced rather than upserted, unlike everything else in this function. The
  -- rest are additive by nature — a rate the file does not mention is a rate
  -- nobody was asserting anything about. An edge is different: its *absence* is
  -- the assertion. Merging would mean a file saying "these two run in parallel"
  -- could never actually remove the dependency, and the graph would only ever
  -- accumulate. Scoped to the departments the file carries, so a partial file
  -- cannot silently unwire departments it says nothing about.
  if v_tables ? 'department_dependencies' then
    delete from public.department_dependencies dd
     where dd.department_id in (
       select d.id
         from jsonb_to_recordset(v_tables -> 'departments')
           as x (code text)
         join public.departments d on d.code = x.code
     );

    insert into public.department_dependencies
      (department_id, depends_on_department_id)
    select d.id, f.id
      from jsonb_to_recordset(v_tables -> 'department_dependencies')
        as x (department_code text, depends_on_code text)
      join public.departments d on d.code = x.department_code
      join public.departments f on f.code = x.depends_on_code
    on conflict do nothing;
    get diagnostics v_n = row_count; v_applied := v_applied + v_n;
  end if;

  insert into public.shifts
    (code, name, start_time, end_time, net_production_hours, max_ot_hours, is_active)
  select x.code, x.name, x.start_time::time, x.end_time::time,
         x.net_production_hours, x.max_ot_hours, coalesce(x.is_active, true)
    from jsonb_to_recordset(coalesce(v_tables -> 'shifts', '[]'::jsonb))
      as x (code text, name text, start_time text, end_time text,
            net_production_hours numeric, max_ot_hours numeric, is_active boolean)
  on conflict (code) do update
    set name = excluded.name,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        net_production_hours = excluded.net_production_hours,
        max_ot_hours = excluded.max_ot_hours,
        is_active = excluded.is_active;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.articles (code, name, category, is_active)
  select x.code, x.name, x.category, coalesce(x.is_active, true)
    from jsonb_to_recordset(coalesce(v_tables -> 'articles', '[]'::jsonb))
      as x (code text, name text, category text, is_active boolean)
  on conflict (code) do update
    set name = excluded.name,
        category = excluded.category,
        is_active = excluded.is_active;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.components (code, name, uom, is_active)
  select x.code, x.name, coalesce(x.uom, 'NOS'), coalesce(x.is_active, true)
    from jsonb_to_recordset(coalesce(v_tables -> 'components', '[]'::jsonb))
      as x (code text, name text, uom text, is_active boolean)
  on conflict (code) do update
    set name = excluded.name,
        uom = excluded.uom,
        is_active = excluded.is_active;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.holidays (holiday_date, description)
  select x.holiday_date::date, x.description
    from jsonb_to_recordset(coalesce(v_tables -> 'holidays', '[]'::jsonb))
      as x (holiday_date text, description text)
  on conflict (holiday_date) do update set description = excluded.description;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.department_shifts
    (department_id, shift_id, sanctioned_headcount, is_active)
  select d.id, s.id, coalesce(x.sanctioned_headcount, 0), coalesce(x.is_active, false)
    from jsonb_to_recordset(coalesce(v_tables -> 'department_shifts', '[]'::jsonb))
      as x (department_code text, shift_code text, sanctioned_headcount integer, is_active boolean)
    join public.departments d on d.code = x.department_code
    join public.shifts s on s.code = x.shift_code
  on conflict (department_id, shift_id) do update
    set sanctioned_headcount = excluded.sanctioned_headcount,
        is_active = excluded.is_active;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.article_bom (article_id, component_id, qty_per_unit)
  select a.id, c.id, x.qty_per_unit
    from jsonb_to_recordset(coalesce(v_tables -> 'article_bom', '[]'::jsonb))
      as x (article_code text, component_code text, qty_per_unit numeric)
    join public.articles a on a.code = x.article_code
    join public.components c on c.code = x.component_code
  on conflict (article_id, component_id) do update
    set qty_per_unit = excluded.qty_per_unit;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  -- These rows already exist, blank, created by trigger when the article and
  -- department were inserted above. This fills them in.
  insert into public.article_dept_dminus
    (article_id, department_id, dminus_days, is_complete)
  select a.id, d.id, x.dminus_days, coalesce(x.is_complete, x.dminus_days is not null)
    from jsonb_to_recordset(coalesce(v_tables -> 'article_dept_dminus', '[]'::jsonb))
      as x (article_code text, department_code text, dminus_days integer, is_complete boolean)
    join public.articles a on a.code = x.article_code
    join public.departments d on d.code = x.department_code
  on conflict (article_id, department_id) do update
    set dminus_days = excluded.dminus_days,
        is_complete = excluded.is_complete;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  insert into public.component_rates
    (component_id, department_id, shift_id, units_per_day, is_measured)
  select c.id, d.id, s.id, x.units_per_day, coalesce(x.is_measured, false)
    from jsonb_to_recordset(coalesce(v_tables -> 'component_rates', '[]'::jsonb))
      as x (component_code text, department_code text, shift_code text,
            units_per_day numeric, is_measured boolean)
    join public.components c on c.code = x.component_code
    join public.departments d on d.code = x.department_code
    join public.shifts s on s.code = x.shift_code
  on conflict (component_id, department_id, shift_id) do update
    set units_per_day = excluded.units_per_day,
        is_measured = excluded.is_measured;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  return v_applied;
end;
$$;

revoke execute on function public.import_masters(jsonb) from public, anon;
grant execute on function public.import_masters(jsonb) to authenticated;
