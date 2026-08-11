-- Applied *before* the migrations when testing against a plain Postgres.
--
-- Supabase grants the API roles access to objects as they are created, via
-- default privileges. Reproducing that ordering matters: a migration that
-- deliberately revokes a privilege (working_days, for instance) must be able to
-- do so and have it stick. Blanket grants applied afterwards would silently
-- undo exactly the restrictions worth testing.
--
-- RLS still governs which rows each role sees — a grant without a matching
-- policy returns nothing, which is the behaviour under test.

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;

-- Supabase grants anon explicitly, not only via PUBLIC. Reproducing that is
-- what makes the revoke migrations testable — without it they would pass
-- against a database that never had the privilege in the first place.
alter default privileges in schema public
  grant select on tables to anon;

alter default privileges in schema public
  grant execute on routines to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
