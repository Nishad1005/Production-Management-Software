-- Kram — the engine needs longer than a query.
--
-- ---------------------------------------------------------------------------
-- Found in production, which is the only place it could have been found.
--
-- Loading interim figures into the live project put 994 routed cells into the
-- masters — seventy-one articles through fourteen departments — and the next
-- `run_schedule` came back with:
--
--     canceling statement due to statement timeout
--
-- Supabase gives the `authenticated` role an eight-second statement timeout, and
-- rightly: it is a web API, and a query that runs for a minute over PostgREST is
-- almost always a mistake. The scale test has always said the engine takes about
-- 4.6 seconds for U&M's stated workload on a native Postgres, which sits close
-- enough to eight that a slower machine, a colder cache or a larger order book
-- crosses it.
--
-- So this is not a seeding problem that went away. **At U&M's real scale the
-- schedule run would have failed in production**, on the one operation the whole
-- system is built around, and the message a planner would have seen is the one
-- above.
--
-- ---------------------------------------------------------------------------
-- Raised on the functions, not on the role.
--
-- `alter role authenticated set statement_timeout` would fix this and would also
-- lift the ceiling on every other query anybody ever writes, which is exactly
-- the protection worth keeping. A per-function setting applies for the duration
-- of that call and nothing else — the three operations here are genuinely long
-- by nature, and every other read stays on the eight seconds that keeps the API
-- honest.
--
-- Two minutes rather than thirty seconds: the point is to remove a ceiling the
-- engine can hit, not to install a slightly higher one to be surprised by later.
-- If a run ever approaches this the answer is to make the engine faster, and the
-- run history records how long each one took.
-- ---------------------------------------------------------------------------

alter function public.run_schedule(
  public.order_confidence[], boolean, text
) set statement_timeout = '120s';

alter function public.run_what_if(
  text, public.order_confidence[], text, date, date, numeric
) set statement_timeout = '120s';

-- Rebuilding the calendar walks every day in the horizon and is the same shape
-- of operation: rare, long, and nothing to do with a screen waiting.
alter function public.rebuild_working_days(date, date)
  set statement_timeout = '120s';

comment on function public.run_schedule(public.order_confidence[], boolean, text) is
  'Runs the engine and writes a new immutable schedule version. Carries its own statement timeout: the API default of eight seconds is too short for a real order book, and production is where that was found.';
