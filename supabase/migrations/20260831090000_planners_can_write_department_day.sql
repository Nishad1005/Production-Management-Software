-- Kram — the engine could not write the table it had just been given.
--
-- ---------------------------------------------------------------------------
--   run_schedule: new row violates row-level security policy
--                 for table "schedule_daily_department"
--
-- Reported from the Run the schedule button, on the live project, the morning
-- after the table was added.
--
-- `20260830140000` created `schedule_daily_department`, enabled row-level
-- security on it, and gave it a SELECT policy. The other five schedule tables
-- have carried two policies since the day they were created — read for anyone
-- signed in, and `for all` for a planner — and the new one was given half of
-- that. `run_schedule` is plain plpgsql, not `security definer`, so it inserts
-- as whoever pressed the button, and there was no policy that let them.
--
-- ---------------------------------------------------------------------------
-- Why nothing caught it.
--
-- The full suite was green: 333 tests, including every engine test, run as the
-- table's owner. **A table owner bypasses row-level security**, so a missing
-- policy is invisible to all of them — the same blindness recorded in §5 twice
-- already, arriving on the write path this time instead of the read path.
--
-- `verify:live` would have caught it. It calls `run_schedule` as a signed-in
-- user precisely because reading a view proves only that the door is open. It
-- was run after this migration and its schedule result was not read.
--
-- `tests/rls.test.ts` now runs the engine as a planner rather than as the
-- owner, which makes this class of defect catchable locally for the first
-- time: any future table the engine writes to fails that test until it has a
-- policy, without anybody having to remember to add one.
-- ---------------------------------------------------------------------------

create policy schedule_daily_department_write_planner
  on public.schedule_daily_department for all to authenticated
  using (public.auth_can_plan())
  with check (public.auth_can_plan());
