-- Minimal stand-in for the parts of Supabase's platform schema that Kram's
-- migrations depend on, so the schema can be applied to a plain Postgres for
-- testing. Never applied to a real Supabase project — it already has all of
-- this, and better.
--
-- Kept deliberately small: if a migration needs something not shimmed here,
-- that is a signal the migration is reaching for platform behaviour it should
-- not depend on.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Supabase has moved between exposing the subject as `request.jwt.claim.sub`
-- and as a `sub` key inside `request.jwt.claims`. Accepting both means tests
-- can set whichever is convenient and neither form silently returns null.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
