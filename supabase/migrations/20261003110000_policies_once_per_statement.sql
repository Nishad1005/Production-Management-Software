-- Kram — every access rule, asked once per statement instead of once per row.
--
-- ---------------------------------------------------------------------------
-- What was found, and how.
--
-- Every read policy in this schema is some combination of `auth_has_a_role()`,
-- `auth_can_plan()`, `auth_has_role(...)`, `auth_department_id()` and
-- `auth.uid()`. Written bare, as they all were, Postgres evaluates the call
-- for **every row a scan considers**: each one runs a query against
-- `user_roles`, and on Supabase `auth.uid()` parses the request's JWT claims
-- out of a setting each time it is asked.
--
-- That is the half-millisecond-a-row tax that has sat under every measurement
-- taken on the hosted project since August, and was misread each time as
-- something particular to the view in hand:
--
--   article_master       ~1,000 ms for 73 rows
--   capacity_sheet       ~1,000 ms for 1,440
--   resolve_capacity     ~2.6 ms a cell, "five policy-checked lookups"
--   run_schedule         ~70 s for twelve orders
--
-- It was finally seen directly on 3 Oct by doing what the local suite never
-- does — running a view as a signed-in user and reading the plan. As the table
-- owner `article_handover` took 5 ms; as a planner, 592 ms, with
-- `Filter: (auth_can_plan() OR auth_has_a_role())` on every scan. Worse than
-- the calls themselves: a filter the planner cannot see through collapses its
-- row estimates, and it chose a nested-loop anti-join that compared 7.8
-- million row pairs.
--
-- ---------------------------------------------------------------------------
-- The change.
--
-- Wrapping the call in a scalar subquery — `(select public.auth_has_a_role())`
-- — makes it an InitPlan: evaluated once, before the scan, and compared as a
-- constant. Same function, same answer, same access; these functions are
-- STABLE and depend only on who is asking, so "once per statement" is what
-- they already promised. It is the first item in Supabase's own guidance on
-- row-level-security performance and should have been how these were written
-- on the first day.
--
-- Done by rewriting what `pg_policies` reports rather than by listing eighty
-- policies by hand: a hand-written list is how `check_order_acceptance` came
-- to miss its timeout, and how this would come to miss a table. A policy
-- already wrapped is left alone, so the block can be run again.
--
-- `tests/rls.test.ts` runs as the `authenticated` role and holds the access
-- rules themselves in place; `tests/policies-once-per-statement.test.ts` reads
-- the catalogue and fails on any policy that calls one of these functions
-- bare, so the next table added cannot quietly bring the tax back.
-- ---------------------------------------------------------------------------

do $$
declare
  p record;
  v_using text;
  v_check text;
  v_sql text;
begin
  for p in
    select tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
  loop
    v_using := p.qual;
    v_check := p.with_check;

    -- Already wrapped: leave it. Makes the block safe to run twice.
    if coalesce(v_using, '') ~* 'select\s+(public\.)?auth'
       or coalesce(v_check, '') ~* 'select\s+(public\.)?auth' then
      continue;
    end if;

    if v_using is not null then
      v_using := regexp_replace(
        v_using, '(?:public\.)?(auth_[a-z_]+\([^()]*\))', '(select public.\1)', 'g');
      v_using := regexp_replace(
        v_using, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;
    if v_check is not null then
      v_check := regexp_replace(
        v_check, '(?:public\.)?(auth_[a-z_]+\([^()]*\))', '(select public.\1)', 'g');
      v_check := regexp_replace(
        v_check, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;

    if v_using is not distinct from p.qual
       and v_check is not distinct from p.with_check then
      continue;
    end if;

    v_sql := format('alter policy %I on public.%I', p.policyname, p.tablename);
    if v_using is not null then
      v_sql := v_sql || format(' using (%s)', v_using);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;
    execute v_sql;
  end loop;
end;
$$;
