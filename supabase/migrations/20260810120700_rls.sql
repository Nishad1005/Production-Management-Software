-- Kram — row-level security.
--
-- Spec §16: "Access is enforced at the database with row-level security rather
-- than in the client, so an HOD cannot read or write another department's WIP
-- regardless of how the request is made."
--
-- Enabling RLS with no policy denies everything, so each table below is opted
-- in deliberately. Phases 0–2 exercise admin, planner, merchandiser and md; the
-- department-scoped HOD policies arrive with the WIP ledger in Phase 3.

-- created_by should record who did it without every insert having to say so.
-- auth.uid() is null when seeding from the CLI, which is correct — nobody did.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'user_roles', 'departments', 'shifts', 'department_shifts',
    'articles', 'components', 'article_bom', 'article_dept_dminus',
    'component_rates', 'capacity_overrides', 'holidays', 'employees'
  ] loop
    execute format(
      'alter table public.%I alter column created_by set default auth.uid()', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity tables
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.auth_is_admin());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and department_id is not distinct from (
    select p.department_id from public.profiles p where p.id = auth.uid()
  ));

-- Only an admin may move someone between departments or deactivate them.
create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

alter table public.user_roles enable row level security;

create policy user_roles_select_self_or_admin on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.auth_is_admin());

-- Granting roles is an admin act, full stop. Without this restriction any
-- signed-in user could grant themselves 'admin'.
create policy user_roles_admin_all on public.user_roles
  for all to authenticated
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

-- ---------------------------------------------------------------------------
-- Masters
--
-- Readable by anyone signed in: the route, the BOM and the shift pattern are
-- reference data every screen needs, and none of it is department-sensitive.
-- Writable by admin and planner only — these tables set the arithmetic every
-- schedule run depends on.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'departments', 'shifts', 'department_shifts',
    'articles', 'components', 'article_bom',
    'article_dept_dminus', 'component_rates', 'capacity_overrides', 'holidays'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );

    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.auth_can_plan()) with check (public.auth_can_plan())',
      t || '_write_planner', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Employees — read by planning roles, written by HR and admin.
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;

create policy employees_select_authenticated on public.employees
  for select to authenticated
  using (true);

create policy employees_write_hr on public.employees
  for all to authenticated
  using (public.auth_has_any_role(array['admin', 'hr']::public.app_role[]))
  with check (public.auth_has_any_role(array['admin', 'hr']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Derived calendar — readable by all, written by nobody.
--
-- rebuild_working_days() is SECURITY DEFINER and so writes as the owner,
-- bypassing these policies. That is the only path that should ever touch it:
-- a hand-edited calendar row would silently shift every date in the system.
-- ---------------------------------------------------------------------------

alter table public.working_days enable row level security;

create policy working_days_select_authenticated on public.working_days
  for select to authenticated
  using (true);

-- RLS alone would make a stray write a silent no-op — an UPDATE with no
-- matching policy affects zero rows and reports success. Revoking the
-- privilege outright turns that into a permission error, which is what anyone
-- reaching for this table needs to see.
revoke insert, update, delete on public.working_days from authenticated, anon;
