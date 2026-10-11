-- Kram — a seventh reason a task cannot be made as planned: it is behind.
--
-- This file holds one statement, on purpose. Postgres allows ALTER TYPE … ADD
-- VALUE inside a transaction since version 12, but the new value cannot be
-- *used* in the same transaction — and every migration file here is applied
-- as one transaction, by the test harness, by PGlite in the browser and by
-- `supabase db push`. A view in the next file names 'late'; it has to come
-- after the commit that created it.
--
-- What 'late' means is in 20261012090100: with the engine told what day it
-- is, work that remains on a job and should already have started is placed
-- forward from today, and reported as late when it still overruns its date.

alter type public.breach_reason add value if not exists 'late';
