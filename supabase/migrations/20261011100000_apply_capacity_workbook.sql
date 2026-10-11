-- Kram — the capacity workbook, applied in one call.
--
-- ---------------------------------------------------------------------------
-- "Load a workbook" on the Capacity sheet, and scripts/import-capacity-sheet.mjs,
-- both hand the parsed file here. One call rather than a set_capacity_cell and
-- a set_dminus per cell: 1,440 cells is 2,880 round trips, each its own
-- transaction, so a file that fails on cell 700 leaves 699 applied and no way
-- to say which. This is one transaction. It raises before writing on anything
-- it does not recognise, so a masters change between the preview and Apply
-- writes nothing at all.
--
-- The semantics are set_capacity_cell's (20260812100000) and set_dminus's
-- (20260811100100), as sets:
--
--   a Units figure    the stage component ARTICLE::DEPT, its BOM row at qty 1,
--                     and a rate on every active shift the department works;
--                     manpower keeps the old crew where the file leaves it blank
--   a D-minus figure  written wherever given, and complete
--   a blank Units     simply absent from the payload. Nothing here deletes:
--                     removing a step is done on the sheet, one cell at a time
--
-- One deliberate difference from set_dminus: the D-minus row is upserted. The
-- seeding triggers create rows only for an active article × an active
-- department, and set_article_active does not go back for them, so a row can
-- be missing — and set_dminus on a missing row updates nothing and reports
-- success, which is the failure this project exists to avoid. import_masters
-- already upserts the same table.
--
-- No statement_timeout of its own: five set-based statements over 1,440 rows
-- finish in well under the API's eight seconds, and a raised ceiling on a
-- function that never plans is a protection removed (tests/engine-timeout).
-- ---------------------------------------------------------------------------

create or replace function public.apply_capacity_workbook(p_file jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_bad text;
  v_rates integer;
  v_dminus integer;
begin
  if (p_file ->> 'kram_capacity') is null then
    raise exception 'This is not a Kram capacity file';
  end if;
  if jsonb_typeof(p_file -> 'cells') is distinct from 'array' then
    raise exception 'The file carries no cells';
  end if;

  -- A guard, so two calls inside one transaction (the tests) do not collide:
  -- ON COMMIT DROP fires at commit, which may be a long way off.
  drop table if exists _cells;

  create temp table _cells on commit drop as
  select x.article_code,
         x.department_code,
         x.units,
         x.manpower,
         x.dminus,
         a.id as article_id,
         d.id as department_id,
         -- Deterministic from the pair, exactly as set_capacity_cell names it,
         -- so a sheet loaded twice never duplicates.
         x.article_code || '::' || x.department_code as component_code
    from jsonb_to_recordset(p_file -> 'cells')
      as x (article_code text, department_code text,
            units numeric, manpower numeric, dminus numeric)
    left join public.articles a on a.code = x.article_code and a.is_active
    left join public.departments d on d.code = x.department_code and d.is_active;

  -- Everything is checked before anything is written. The preview matched
  -- against the active masters; a code that is unknown or retired by now means
  -- the masters moved under the file, and the whole load stops.
  select string_agg(distinct c.article_code, ', ' order by c.article_code)
    into v_bad
    from _cells c
   where c.article_id is null;
  if v_bad is not null then
    raise exception 'Not an active article on Masters: %', v_bad;
  end if;

  select string_agg(distinct c.department_code, ', ' order by c.department_code)
    into v_bad
    from _cells c
   where c.department_id is null;
  if v_bad is not null then
    raise exception 'Not an active department on Masters: %', v_bad;
  end if;

  -- The table constraints would refuse these too, but "violates check
  -- constraint component_rates_units_per_day_check" is not a sentence for a
  -- banner read on a factory floor.
  if exists (select 1 from _cells c
              where c.units <= 0 or c.manpower < 0 or c.dminus < 0) then
    raise exception 'Units must be above zero; manpower and D-minus cannot be negative';
  end if;
  if exists (select 1 from _cells c
              where c.manpower <> trunc(c.manpower) or c.dminus <> trunc(c.dminus)) then
    raise exception 'Manpower and D-minus are whole numbers';
  end if;

  -- Two rows for one pair would make the upserts below fail with "cannot
  -- affect row a second time", which says nothing about the sheet.
  if exists (select 1 from _cells
              group by article_id, department_id having count(*) > 1) then
    raise exception 'The file gives the same article and department twice';
  end if;

  -- -------------------------------------------------------------------------
  -- Rates: set_capacity_cell, as sets.
  -- -------------------------------------------------------------------------
  insert into public.components (code, name, uom)
  select c.component_code,
         c.department_code || ' work on ' || c.article_code,
         'NOS'
    from _cells c
   where c.units is not null
  on conflict (code) do nothing;

  insert into public.article_bom (article_id, component_id, qty_per_unit)
  select c.article_id, cmp.id, 1
    from _cells c
    join public.components cmp on cmp.code = c.component_code
   where c.units is not null
  on conflict (article_id, component_id) do nothing;

  -- Every shift the department actually works, as the single-cell write does:
  -- a rate on a shift nobody works would be invisible; a shift with no rate
  -- contributes nothing while looking like it runs.
  insert into public.component_rates
    (component_id, department_id, shift_id, units_per_day, manpower)
  select cmp.id, c.department_id, ds.shift_id, c.units, c.manpower::integer
    from _cells c
    join public.components cmp on cmp.code = c.component_code
    join public.department_shifts ds
      on ds.department_id = c.department_id and ds.is_active
    join public.shifts s on s.id = ds.shift_id and s.is_active
   where c.units is not null
  on conflict (component_id, department_id, shift_id) do update
    set units_per_day = excluded.units_per_day,
        manpower = coalesce(excluded.manpower, component_rates.manpower);

  -- -------------------------------------------------------------------------
  -- D-minus: set_dminus, as a set, and upserted (see the header).
  -- -------------------------------------------------------------------------
  insert into public.article_dept_dminus
    (article_id, department_id, dminus_days, is_complete)
  select c.article_id, c.department_id, c.dminus::integer, true
    from _cells c
   where c.dminus is not null
  on conflict (article_id, department_id) do update
    set dminus_days = excluded.dminus_days,
        is_complete = excluded.is_complete;

  -- Cells, not rows: a department on two shifts writes two rate rows for one
  -- figure on the sheet, and the sentence on screen counts figures.
  select count(*) filter (where c.units is not null),
         count(*) filter (where c.dminus is not null)
    into v_rates, v_dminus
    from _cells c;

  return jsonb_build_object('rates', v_rates, 'dminus', v_dminus);
end;
$$;

revoke execute on function public.apply_capacity_workbook(jsonb) from public, anon;
grant execute on function public.apply_capacity_workbook(jsonb) to authenticated;

comment on function public.apply_capacity_workbook(jsonb) is
  'Applies a parsed capacity workbook in one transaction: rates as set_capacity_cell, D-minus as set_dminus but upserted. Raises on any article or department not active on Masters, so nothing is half-loaded. Returns {rates, dminus} as counts of cells.';
