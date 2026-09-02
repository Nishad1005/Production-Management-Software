-- Kram — the acceptance check runs the engine, and was never told it could.
--
-- ---------------------------------------------------------------------------
--   check_order_acceptance: canceling statement due to statement timeout
--
-- From the *Can we take this order?* screen on the live project.
--
-- `check_order_acceptance` inserts a hypothetical shipment line, calls
-- `run_schedule`, reports what breaks, and rolls the line away again. It is a
-- full re-plan of the factory — currently 72 seconds — running under the eight
-- seconds Supabase gives the `authenticated` role.
--
-- `20260823100000` raised the ceiling on `run_schedule`, `run_what_if` and
-- `rebuild_working_days`. It missed this one, because the list was written by
-- hand from the functions that were slow *that day*, and this one is slow by
-- virtue of what it calls rather than what it contains.
--
-- ---------------------------------------------------------------------------
-- The test made the omission permanent.
--
-- `tests/engine-timeout.test.ts` asserted those three names and then asserted
-- that **nothing else** carried a raised timeout — a rule written to stop a
-- ceiling being lifted quietly, which had the side effect of stating that this
-- function's missing ceiling was correct. It has been green over
-- `check_order_acceptance` since the day both existed.
--
-- It now derives the set from the catalogue: any function that reaches
-- `run_schedule` or `run_what_if`, directly or through another function, must
-- carry a raised timeout. That rule would have failed on the day this function
-- was written.
--
-- ---------------------------------------------------------------------------
-- 180 seconds, and one that will still not be enough.
--
-- The acceptance check is one run plus its scaffolding, so 180s is 72 with room.
--
-- `suggest_stuffing_date` calls the acceptance check up to twelve times, each a
-- full run: roughly fifteen minutes at today's engine cost. 180 seconds will
-- not cover it and it is not raised further, because no ceiling makes a
-- fifteen-minute API call reasonable. **It cannot work until the engine builds
-- its capacity grid set-based** (§8.1). It is wired to no screen, so nothing
-- regresses; the ceiling is there so that the day somebody wires it up it fails
-- after three minutes with a legible reason rather than at eight seconds with
-- a confusing one.
-- ---------------------------------------------------------------------------

alter function public.check_order_acceptance(
  uuid, numeric, date, date, public.order_confidence[]
) set statement_timeout = '180s';

comment on function public.check_order_acceptance is
  'Schedules a hypothetical shipment line against the live book and reports what breaches. Leaves no trace. A full schedule run, so it carries the engine''s raised statement timeout.';

alter function public.suggest_stuffing_date(
  uuid, numeric, date, integer, integer
) set statement_timeout = '180s';

comment on function public.suggest_stuffing_date is
  'Earliest stuffing date that breaches nothing. Up to twelve full schedule runs, so it exceeds even its raised ceiling at present engine cost and is wired to no screen.';
