-- Kram — actually revoke EXECUTE from anon.
--
-- The previous migration revoked from PUBLIC, which was necessary and not
-- sufficient. Supabase ships its own default privileges:
--
--   alter default privileges in schema public
--     grant all on functions to postgres, anon, authenticated, service_role;
--
-- so `anon` holds an *explicit* grant as well as the PUBLIC one, and revoking
-- the latter leaves the former standing.
--
-- The difference showed up in the error. Calling run_schedule as anon failed
-- with "permission denied for table schedule_runs" rather than "permission
-- denied for function run_schedule" — meaning the function was entered and ran
-- until it touched a protected table. Blocked either way, but only by the
-- innermost check, and any function doing work before its first protected
-- statement would have done that work for a stranger.

revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- Same reasoning for reads, so the two cannot drift apart.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
