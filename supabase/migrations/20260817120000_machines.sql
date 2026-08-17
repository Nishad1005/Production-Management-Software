-- Kram Phase 7 — machines.
--
-- Row four of the client's scope of work: "MACHINERY SCHEDULING · PLANNING ·
-- PRODUCTION · FLOW CHART · CAPACITY PLAN · MAINTENANCE", and "Machine Status"
-- is one of the ten things slide 5 says the MD's dashboard should contain.
--
-- ---------------------------------------------------------------------------
-- How a machine changes a day, and why it works the way attendance does.
--
-- Kram already scales a department's capacity by who turned up, and it does so
-- on one condition: the rate has to carry the crew it was measured with. Thirty
-- covers with a crew of three means two people make twenty. Without the crew
-- size there is no ratio, and inventing one would move every number on screen.
--
-- Machines are the same shape of problem with a better-behaved answer, because
-- the denominator is not something anyone has to type: **it is how many
-- machines that department has**. Four machines, one under maintenance, and the
-- day runs at three quarters — provided somebody has recorded that the
-- department has four.
--
-- So a department with no machines recorded is not a department with none. It
-- is a department nobody has told us about, and its capacity is left exactly as
-- it was. Fourth time this project has had to keep "nobody has said" apart from
-- "zero", and the first time it has cost nothing to do.
--
-- The alternative — per-machine rates per component, a capacity ceiling rather
-- than a scaler — is more precise and needs a table of figures U&M do not have
-- and would have to measure. This needs one list of machines and the days they
-- are down, which a maintenance department already keeps.
-- ---------------------------------------------------------------------------

create type public.downtime_kind as enum ('maintenance', 'breakdown', 'changeover');

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,

  department_id uuid not null references public.departments (id) on delete cascade,

  -- Free text on purpose. "Juki DDL-8700" is what the floor calls it and what
  -- the maintenance log will say; an enum of machine types would be a
  -- classification nobody asked for.
  machine_type text,
  asset_no text,

  commissioned_on date,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.machines');

create index machines_department_idx on public.machines (department_id) where is_active;

comment on table public.machines is
  'What each department has. The count is the denominator that turns a machine being down into a smaller day.';

create table public.machine_downtime (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines (id) on delete cascade,

  from_date date not null,
  to_date date not null,
  kind public.downtime_kind not null default 'maintenance',

  -- Required, like a capacity override's reason. A machine down for no stated
  -- reason is a number nobody can argue with or learn from.
  reason text not null check (length(btrim(reason)) > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  constraint machine_downtime_dates check (to_date >= from_date),

  -- One machine cannot be down twice over the same day. Overlaps would
  -- double-count it out of the department and understate capacity.
  constraint machine_downtime_no_overlap
    exclude using gist (
      machine_id with =,
      daterange(from_date, to_date, '[]') with &&
    )
);
select public.attach_audit('public.machine_downtime');

comment on table public.machine_downtime is
  'Days a machine is not available, planned or otherwise. Overlaps are refused: a machine counted out twice understates the department.';

alter table public.machines enable row level security;
alter table public.machine_downtime enable row level security;

create policy machines_select_with_a_role on public.machines
  for select to authenticated using (public.auth_has_a_role());
create policy machines_write_with_a_role on public.machines
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy machine_downtime_select_with_a_role on public.machine_downtime
  for select to authenticated using (public.auth_has_a_role());
create policy machine_downtime_write_with_a_role on public.machine_downtime
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

-- ---------------------------------------------------------------------------
-- How much of a department is running on a given day.
--
-- Null — not 1 — where the department has no machines recorded, so that every
-- caller has to decide what to do about not knowing rather than being handed a
-- number that looks like knowing.
-- ---------------------------------------------------------------------------
create or replace function public.machine_availability(
  p_department_id uuid,
  p_date date
)
returns numeric
language sql
stable
as $$
  select case
           when count(*) = 0 then null
           else count(*) filter (
             where not exists (
               select 1 from public.machine_downtime dt
                where dt.machine_id = m.id
                  and p_date between dt.from_date and dt.to_date
             )
           )::numeric / count(*)
         end
    from public.machines m
   where m.department_id = p_department_id and m.is_active;
$$;

comment on function public.machine_availability(uuid, date) is
  'The fraction of a department''s machines available on a day, or null where none are recorded — which is not the same as none being available.';

-- ---------------------------------------------------------------------------
-- resolve_capacity, replaced to take machines into account.
--
-- The order is unchanged and deliberate: an explicit override always wins,
-- because it is somebody saying what the day actually is. Machines and
-- attendance both scale the standing rate underneath it, and they multiply —
-- half the crew on half the machines is a quarter of a day, which is the only
-- reading that does not double-count either.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_capacity(
  p_department_id uuid,
  p_shift_id uuid,
  p_component_id uuid,
  p_date date
)
returns numeric
language sql
stable
as $$
  select coalesce(
    -- 1. Someone typed a figure for this component on this day.
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is not distinct from p_component_id
      limit 1
    ),
    -- 2. Someone typed a figure for the whole department on this day.
    (
      select co.units_per_day
      from public.capacity_overrides co
      where co.department_id = p_department_id
        and co.shift_id = p_shift_id
        and p_date between co.from_date and co.to_date
        and co.component_id is null
      limit 1
    ),
    -- 3. The standing rate, scaled by who came in and what is running.
    --
    -- Both factors are optional and independent. Attendance applies only where
    -- the rate carries the crew it was measured with; machines apply only where
    -- the department has any recorded. Where neither is known this is the
    -- standing rate untouched, which is what it has always been.
    (
      select round(
               cr.units_per_day
               * coalesce(
                   (select att.present::numeric / cr.manpower
                      from public.department_attendance att
                     where att.department_id = cr.department_id
                       and att.shift_id = cr.shift_id
                       and att.attendance_date = p_date
                       and cr.manpower is not null
                       and cr.manpower > 0),
                   1
                 )
               * coalesce(
                   public.machine_availability(p_department_id, p_date),
                   1
                 ),
               3
             )
        from public.component_rates cr
       where cr.department_id = p_department_id
         and cr.shift_id = p_shift_id
         and cr.component_id = p_component_id
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Writing.
-- ---------------------------------------------------------------------------
create or replace function public.set_machine(
  p_code text,
  p_name text,
  p_department_code text,
  p_machine_type text default null,
  p_asset_no text default null
)
returns void
language plpgsql
as $$
declare
  v_department uuid;
  v_code text := nullif(btrim(p_code), '');
  v_name text := nullif(btrim(p_name), '');
begin
  if v_code is null then raise exception 'a machine needs a code'; end if;
  if v_name is null then raise exception 'a machine needs a name'; end if;

  select id into v_department from public.departments where code = p_department_code;
  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;

  insert into public.machines
    (code, name, department_id, machine_type, asset_no)
  values (v_code, v_name, v_department,
          nullif(btrim(p_machine_type), ''), nullif(btrim(p_asset_no), ''))
  on conflict (code) do update
    set name = excluded.name,
        department_id = excluded.department_id,
        machine_type = coalesce(excluded.machine_type, public.machines.machine_type),
        asset_no = coalesce(excluded.asset_no, public.machines.asset_no),
        is_active = true;
end;
$$;

revoke execute on function public.set_machine(text, text, text, text, text)
  from public, anon;
grant execute on function public.set_machine(text, text, text, text, text)
  to authenticated;

create or replace function public.set_machine_active(p_code text, p_is_active boolean)
returns void
language plpgsql
as $$
begin
  update public.machines set is_active = p_is_active where code = p_code;
  if not found then raise exception 'unknown machine %', p_code; end if;
end;
$$;

revoke execute on function public.set_machine_active(text, boolean) from public, anon;
grant execute on function public.set_machine_active(text, boolean) to authenticated;

create or replace function public.set_machine_downtime(
  p_machine_code text,
  p_from_date date,
  p_to_date date,
  p_reason text,
  p_kind public.downtime_kind default 'maintenance'
)
returns uuid
language plpgsql
as $$
declare
  v_machine uuid;
  v_id uuid;
begin
  select id into v_machine from public.machines where code = p_machine_code;
  if v_machine is null then
    raise exception 'unknown machine %', p_machine_code;
  end if;

  insert into public.machine_downtime
    (machine_id, from_date, to_date, kind, reason)
  values (v_machine, p_from_date, coalesce(p_to_date, p_from_date), p_kind, p_reason)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.set_machine_downtime(
  text, date, date, text, public.downtime_kind) from public, anon;
grant execute on function public.set_machine_downtime(
  text, date, date, text, public.downtime_kind) to authenticated;

create or replace function public.clear_machine_downtime(p_id uuid)
returns void
language plpgsql
as $$
begin
  delete from public.machine_downtime where id = p_id;
  if not found then raise exception 'no such downtime entry'; end if;
end;
$$;

revoke execute on function public.clear_machine_downtime(uuid) from public, anon;
grant execute on function public.clear_machine_downtime(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading.
-- ---------------------------------------------------------------------------
create view public.machine_master
with (security_invoker = true) as
  select m.code,
         m.name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         m.machine_type,
         m.asset_no,
         m.commissioned_on::text as commissioned_on,
         m.is_active,
         exists (
           select 1 from public.machine_downtime dt
            where dt.machine_id = m.id
              and current_date between dt.from_date and dt.to_date
         ) as down_today,
         (select dt.reason from public.machine_downtime dt
           where dt.machine_id = m.id
             and current_date between dt.from_date and dt.to_date
           limit 1) as down_reason,
         (select min(dt.from_date)::text from public.machine_downtime dt
           where dt.machine_id = m.id and dt.from_date > current_date) as next_down_on
    from public.machines m
    join public.departments d on d.id = m.department_id;

grant select on public.machine_master to authenticated;

-- What a department looks like today: how many machines it has, how many are
-- running, and what that does to its day.
create view public.machine_status
with (security_invoker = true) as
  select d.code                as department_code,
         d.name                as department_name,
         d.route_position,
         count(*)::integer     as machines,
         count(*) filter (
           where not exists (
             select 1 from public.machine_downtime dt
              where dt.machine_id = m.id
                and current_date between dt.from_date and dt.to_date
           )
         )::integer            as available,
         round(100 * public.machine_availability(d.id, current_date), 1)::float8
                               as available_pct
    from public.machines m
    join public.departments d on d.id = m.department_id and d.is_active
   where m.is_active
   group by d.id, d.code, d.name, d.route_position;

comment on view public.machine_status is
  'Per department today: machines, how many are running, and the fraction that scales the day.';

grant select on public.machine_status to authenticated;

create view public.machine_downtime_list
with (security_invoker = true) as
  select dt.id,
         m.code                 as machine_code,
         m.name                 as machine_name,
         d.code                 as department_code,
         dt.from_date::text     as from_date,
         dt.to_date::text       as to_date,
         dt.kind::text          as kind,
         dt.reason,
         (current_date between dt.from_date and dt.to_date) as active_today,
         (dt.from_date > current_date) as upcoming,
         (dt.to_date - dt.from_date + 1)::integer as days
    from public.machine_downtime dt
    join public.machines m on m.id = dt.machine_id
    join public.departments d on d.id = m.department_id;

grant select on public.machine_downtime_list to authenticated;

-- ---------------------------------------------------------------------------
-- Machines travel in the masters file.
--
-- The file is how PPC's real figures reach the hosted system, and how anybody
-- keeps a copy of an afternoon's data entry. A machine list is exactly that
-- kind of figure — typed once, by someone who had to walk the floor to get it —
-- so leaving it out would mean the one master that costs the most to collect is
-- the one the file cannot carry.
--
-- Downtime deliberately does not travel. It is an event, like a production
-- declaration: it belongs in the backup file, not in a masters file that gets
-- merged into another database.
-- ---------------------------------------------------------------------------
-- Rebuilt from the version this replaces rather than retyped.
--
-- The first attempt at this was hand-copied and drifted in two places: it
-- dropped `coalesce(sanctioned_headcount, 0)`, so importing a file with an
-- unstaffed department/shift pairing failed on a not-null constraint; and it
-- changed `coalesce(is_active, false)` to `true`, which would have switched on
-- every shift on every department and roughly doubled the factory's capacity
-- without a word. Only the machines block below is new; everything else is the
-- previous text unchanged.
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

  -- New in Phase 7: the machine list. After departments, because every machine
  -- belongs to one. Downtime deliberately does not travel — it is an event, and
  -- events belong in the backup file, not in a masters file merged on top of a
  -- live database.
  insert into public.machines
    (code, name, department_id, machine_type, asset_no, is_active)
  select x.code, x.name, d.id, x.machine_type, x.asset_no, coalesce(x.is_active, true)
    from jsonb_to_recordset(coalesce(v_tables -> 'machines', '[]'::jsonb))
      as x (code text, name text, department_code text, machine_type text,
            asset_no text, is_active boolean)
    join public.departments d on d.code = x.department_code
  on conflict (code) do update
    set name = excluded.name,
        department_id = excluded.department_id,
        machine_type = excluded.machine_type,
        asset_no = excluded.asset_no,
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
