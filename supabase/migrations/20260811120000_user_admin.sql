-- Kram — who you are, and who may change it.
--
-- Spec §16 lists twelve roles and requires access enforced at the database
-- "regardless of how the request is made". The policies for that have existed
-- since Phase 0; this is the surface the client needs to work with them.
--
-- Accounts themselves are created in the Supabase dashboard. Creating a user
-- needs the service role key, which must never reach a browser, so in-app
-- account creation would mean an edge function holding that key. Roles are
-- assigned here, which is the part that actually decides what anyone can see.

-- ---------------------------------------------------------------------------
-- Who am I? Readable by everyone, about themselves only — the profiles policy
-- already restricts it to auth.uid().
-- ---------------------------------------------------------------------------
create view public.my_access
with (security_invoker = true) as
  select p.id as user_id,
         p.full_name,
         p.is_active,
         p.department_id,
         d.code as department_code,
         d.name as department_name,
         coalesce(
           array_agg(ur.role::text order by ur.role)
             filter (where ur.role is not null),
           '{}'::text[]
         ) as roles
    from public.profiles p
    left join public.user_roles ur on ur.user_id = p.id
    left join public.departments d on d.id = p.department_id
   where p.id = auth.uid()
   group by p.id, p.full_name, p.is_active, p.department_id, d.code, d.name;

-- ---------------------------------------------------------------------------
-- User administration.
--
-- SECURITY DEFINER because it reads auth.users, which the authenticated role
-- cannot see directly — and rightly so. The admin check is therefore inside the
-- function rather than delegated to RLS, and is the only thing standing between
-- a signed-in user and everyone's email address.
-- ---------------------------------------------------------------------------
create or replace function public.list_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  is_active boolean,
  department_code text,
  roles text[],
  created_at text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.auth_is_admin() then
    raise exception 'Only an administrator may list users'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select p.id,
           u.email::text,
           p.full_name,
           p.is_active,
           d.code,
           coalesce(
             array_agg(ur.role::text order by ur.role)
               filter (where ur.role is not null),
             '{}'::text[]
           ),
           u.created_at::text
      from public.profiles p
      join auth.users u on u.id = p.id
      left join public.user_roles ur on ur.user_id = p.id
      left join public.departments d on d.id = p.department_id
     group by p.id, u.email, p.full_name, p.is_active, d.code, u.created_at
     order by u.email;
end;
$$;

create or replace function public.grant_role(
  p_user_id uuid,
  p_role public.app_role
)
returns void
language sql
as $$
  -- No admin check here on purpose: user_roles carries an RLS policy that
  -- already restricts writes to admins, and one enforcement point is easier to
  -- reason about than two that could disagree.
  insert into public.user_roles (user_id, role)
  values (p_user_id, p_role)
  on conflict (user_id, role) do nothing;
$$;

create or replace function public.revoke_role(
  p_user_id uuid,
  p_role public.app_role
)
returns void
language sql
as $$
  delete from public.user_roles
   where user_id = p_user_id and role = p_role;
$$;

create or replace function public.set_user_profile(
  p_user_id uuid,
  p_full_name text default null,
  p_department_code text default null,
  p_is_active boolean default null
)
returns void
language sql
as $$
  update public.profiles p
     set full_name = coalesce(p_full_name, p.full_name),
         is_active = coalesce(p_is_active, p.is_active),
         department_id = case
           when p_department_code is null then p.department_id
           else (select d.id from public.departments d where d.code = p_department_code)
         end
   where p.id = p_user_id;
$$;

-- The functions above are new, so the blanket revoke in the privileges
-- migration has not touched them. Grant deliberately.
revoke execute on function public.list_users() from public, anon;
revoke execute on function public.grant_role(uuid, public.app_role) from public, anon;
revoke execute on function public.revoke_role(uuid, public.app_role) from public, anon;
revoke execute on function public.set_user_profile(uuid, text, text, boolean) from public, anon;

grant execute on function public.list_users() to authenticated;
grant execute on function public.grant_role(uuid, public.app_role) to authenticated;
grant execute on function public.revoke_role(uuid, public.app_role) to authenticated;
grant execute on function public.set_user_profile(uuid, text, text, boolean) to authenticated;

grant select on public.my_access to authenticated;
