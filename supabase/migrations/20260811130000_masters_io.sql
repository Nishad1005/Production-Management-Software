-- Kram — masters as a portable file, on either backend.
--
-- Export was reading tables with ad-hoc SQL, which works against PGlite and not
-- at all against PostgREST, so the feature was offline-only. Reading through
-- views and writing through one function fixes that, and the file stays keyed
-- by code rather than internal id — so a file exported from the browser demo
-- applies cleanly to the hosted database, which is how PPC's real figures will
-- arrive.

-- The one master with no view of its own yet.
create view public.component_list
with (security_invoker = true) as
  select id, code, name, uom, is_active from public.components;

grant select on public.component_list to authenticated;

-- ---------------------------------------------------------------------------
-- Apply a masters file.
--
-- Upsert by natural key rather than replace: predictable, non-destructive, and
-- a partly filled file can be applied without wiping what is already there.
-- Order matters — departments and shifts before the pairings that reference
-- them, articles and components before the BOM.
--
-- Runs as the caller, so row-level security decides whether any of it lands. A
-- planner can import; anyone else gets nothing, silently as far as SQL is
-- concerned, which is why the row count comes back.
-- ---------------------------------------------------------------------------
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
    set units_per_day = excluded.units_per_day;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  return v_applied;
end;
$$;

revoke execute on function public.import_masters(jsonb) from public, anon;
grant execute on function public.import_masters(jsonb) to authenticated;
