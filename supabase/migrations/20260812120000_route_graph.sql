-- Kram — the route is a graph, not a line.
--
-- Until now route_position carried two jobs: the order departments are listed
-- in, and the claim that each one follows the one before it. The first is a
-- display concern. The second is a factual claim about the shop floor, and PPC
-- has now told us it is false — most operations run alongside each other. Metal
-- Finishing, Fibre Processing and fabric Cutting are entry points; nothing
-- upstream feeds them.
--
-- Two things in the engine rest on the false claim.
--
--   The runway check holds each department behind whichever sits at the previous
--   position, so a feeder waits on work its material never touches, and raises
--   breaches that are not real.
--
--   Cumulative yield compounds over "every department after this one", and after
--   is exactly what a line gets wrong. A wooden leg is charged the losses of
--   fabric cutting and stitching, which it never enters. In the four-department
--   demo that overstates the leg requirement by 5%; across fourteen departments
--   at 98% it reaches a third.
--
-- Both are the same mistake, so both are fixed by writing down what actually
-- feeds what. route_position keeps the display job and loses the other one.

create table public.department_dependencies (
  department_id uuid not null
    references public.departments (id) on delete cascade,

  -- The department that must finish first. Reads as "department_id depends on
  -- depends_on_department_id", which is the direction material flows.
  depends_on_department_id uuid not null
    references public.departments (id) on delete cascade,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  primary key (department_id, depends_on_department_id),

  constraint department_dependencies_no_self
    check (department_id <> depends_on_department_id)
);

comment on table public.department_dependencies is
  'What must finish before what. One row per edge; a department with no rows is an entry point, which is what a feeder is.';

-- ---------------------------------------------------------------------------
-- A cycle would make the engine's recursive walks run away, and the moment to
-- refuse one is when it is entered rather than when a schedule is next run.
--
-- Adding "P must finish before S" closes a loop exactly when P is already
-- downstream of S. So walk successors from S over the edges that exist and see
-- whether P turns up. union rather than union all, so the walk terminates even
-- if a cycle somehow already exists.
-- ---------------------------------------------------------------------------
create or replace function public.department_dependencies_no_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    with recursive downstream (id) as (
      select new.department_id
      union
      select dd.department_id
        from public.department_dependencies dd
        join downstream on dd.depends_on_department_id = downstream.id
    )
    select 1 from downstream where id = new.depends_on_department_id
  ) then
    raise exception
      'route dependency would create a cycle: % already runs after %',
      (select code from public.departments where id = new.depends_on_department_id),
      (select code from public.departments where id = new.department_id)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger department_dependencies_no_cycle
  before insert or update on public.department_dependencies
  for each row execute function public.department_dependencies_no_cycle();

-- ---------------------------------------------------------------------------
-- Seeded linear from route_position: one row per consecutive pair.
--
-- This is what makes the change safe rather than a rewrite. Under linear edges
-- the ancestors of a department are every department before it, and the latest
-- of their due dates is the immediately preceding one — precisely what the lag()
-- it replaces returned. The graph reduces to today's behaviour exactly, so every
-- existing test and the parity harness stay green on this migration alone.
-- Numbers move only when someone declares parallelism.
--
-- Written out as rows rather than inferred when absent. A mix of declared and
-- assumed edges cannot be read off a grid, and this grid is the whole point.
-- ---------------------------------------------------------------------------
insert into public.department_dependencies (department_id, depends_on_department_id)
select seq.id, seq.prev_id
  from (
    select id, lag(id) over (order by route_position) as prev_id
      from public.departments
     where is_active
  ) seq
 where seq.prev_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Access. Reading needs a role, as everything else does since the day a
-- role-less account could read the entire masters set. Writing is planning work.
-- ---------------------------------------------------------------------------
alter table public.department_dependencies enable row level security;

create policy department_dependencies_select_with_a_role
  on public.department_dependencies
  for select to authenticated
  using (public.auth_has_a_role());

create policy department_dependencies_write_planner
  on public.department_dependencies
  for all to authenticated
  using (public.auth_can_plan())
  with check (public.auth_can_plan());

-- ---------------------------------------------------------------------------
-- The grid the Masters screen edits: every ordered pair of active departments,
-- with whether the edge exists. 14 departments is 182 rows, so the cross join
-- costs nothing and the client gets a rectangle it can render directly.
-- ---------------------------------------------------------------------------
create view public.route_dependency_grid
with (security_invoker = true) as
  select d.code            as department_code,
         d.name            as department_name,
         d.route_position  as department_position,
         f.code            as feeder_code,
         f.name            as feeder_name,
         f.route_position  as feeder_position,
         exists (
           select 1
             from public.department_dependencies dd
            where dd.department_id = d.id
              and dd.depends_on_department_id = f.id
         ) as feeds
    from public.departments d
    cross join public.departments f
   where d.is_active and f.is_active and d.id <> f.id;

comment on view public.route_dependency_grid is
  'Every ordered pair of active departments and whether the first is fed by the second. One row per cell of the Masters dependency grid.';

grant select on public.route_dependency_grid to authenticated;

-- Plain function, no security definer: the write policy above is the
-- authorisation, exactly as it is for every other master edit. A planner may,
-- anyone else may not, and there is one place that says so.
create or replace function public.set_department_dependency(
  p_department_code text,
  p_depends_on_code text,
  p_enabled boolean
)
returns void
language plpgsql
as $$
declare
  v_department uuid;
  v_depends_on uuid;
begin
  select id into v_department
    from public.departments where code = p_department_code;
  select id into v_depends_on
    from public.departments where code = p_depends_on_code;

  if v_department is null then
    raise exception 'unknown department %', p_department_code;
  end if;
  if v_depends_on is null then
    raise exception 'unknown department %', p_depends_on_code;
  end if;

  if p_enabled then
    insert into public.department_dependencies
                (department_id, depends_on_department_id)
    values (v_department, v_depends_on)
    on conflict do nothing;
  else
    delete from public.department_dependencies
     where department_id = v_department
       and depends_on_department_id = v_depends_on;
  end if;
end;
$$;

revoke execute on function
  public.set_department_dependency(text, text, boolean) from public, anon;
grant execute on function
  public.set_department_dependency(text, text, boolean) to authenticated;

comment on column public.departments.route_position is
  'Integer ordering for display, and the order the capacity sheet lays out its columns. What must finish before what is department_dependencies, not this.';
