-- Kram — lock the function surface down to signed-in users.
--
-- Postgres grants EXECUTE on every new function to PUBLIC. On a local database
-- that is invisible; on Supabase it means anyone holding the anon key — which
-- is published in the browser bundle, by design — can call anything in this
-- schema over the internet.
--
-- Row-level security still protected the *data*: an anonymous call to
-- set_dminus updated zero rows. But run_schedule and check_order_acceptance do
-- real work before RLS has anything to say about it, so an anonymous caller
-- could have made the database schedule the entire order book, repeatedly, for
-- free. Found by calling one as anon against the live project.
--
-- Revoking from PUBLIC is the only way to close it: a privilege granted to
-- PUBLIC cannot be revoked from an individual role.

alter default privileges in schema public revoke execute on functions from public;
revoke execute on all functions in schema public from public;

grant execute on all functions in schema public to authenticated, service_role;

-- The signup trigger fires as the auth service, not as the new user, so it
-- needs its own grant.
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- Views and tables were already governed by RLS with policies scoped `to
-- authenticated`, so anon reads returned nothing. Making that explicit rather
-- than incidental: anon has no business reading any of it.
revoke select on all tables in schema public from anon;
alter default privileges in schema public revoke select on tables from anon;
