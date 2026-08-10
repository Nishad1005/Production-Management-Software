-- Kram — identity, roles and the helper functions RLS policies are built on.
--
-- Spec §16 lists twelve roles. All twelve are declared now even though Phases
-- 0–2 only exercise admin, planner, merchandiser and md: adding a value to an
-- enum later is cheap, but rewriting every policy that assumed a smaller set is
-- not.
--
-- Spec §16: "Access is enforced at the database with row-level security rather
-- than in the client, so an HOD cannot read or write another department's WIP
-- regardless of how the request is made."

create type public.app_role as enum (
  'md',
  'planner',
  'merchandiser',
  'hod',
  'hr',
  'purchase',
  'store',
  'quality',
  'maintenance',
  'accounts',
  'admin',
  'kiosk'
);

-- One row per signed-in person. department_id gains its foreign key in the
-- departments migration, which necessarily runs after this one.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  department_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
select public.attach_audit('public.profiles');

-- A person may hold several roles: the PPC lead is commonly planner + admin.
create table public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  primary key (user_id, role)
);

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- Every one is SECURITY DEFINER so that a policy on table X can consult
-- user_roles without the read against user_roles itself triggering a policy
-- that consults user_roles — the classic recursive-RLS deadlock. search_path is
-- pinned on each so a caller cannot shadow `public` and redirect the lookup.
-- ---------------------------------------------------------------------------

create or replace function public.auth_has_role(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = p_role
  );
$$;

create or replace function public.auth_has_any_role(p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = any (p_roles)
  );
$$;

create or replace function public.auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_has_role('admin');
$$;

-- True for the roles that may read planning data across the whole factory.
create or replace function public.auth_can_read_planning()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_has_any_role(
    array['admin', 'planner', 'merchandiser', 'md']::public.app_role[]
  );
$$;

-- True for the roles that may create schedule runs, pins and masters.
create or replace function public.auth_can_plan()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_has_any_role(array['admin', 'planner']::public.app_role[]);
$$;

-- The department an HOD is scoped to. Null for everyone else.
create or replace function public.auth_department_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.department_id
  from public.profiles p
  where p.id = auth.uid() and p.is_active;
$$;

comment on function public.auth_department_id is
  'The caller''s own department. Used to scope HOD access in Phase 3 WIP policies.';

-- Every new auth user gets a profile row; roles are granted separately by an
-- admin, so a fresh account can sign in and see nothing until deliberately
-- given a role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
