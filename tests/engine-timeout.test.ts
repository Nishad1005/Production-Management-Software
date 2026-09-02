// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient } from './helpers/db'

/**
 * Anything that reaches the engine is allowed to take as long as the engine
 * does.
 *
 * Supabase gives the `authenticated` role eight seconds, which is right for a
 * web API and far too short for a schedule run — 72 seconds on U&M's live
 * project. So the engine and its callers carry their own ceiling.
 *
 * ---------------------------------------------------------------------------
 * This file used to name three functions and assert that nothing else carried
 * a raised timeout. Both halves were reasonable and together they were wrong:
 * `check_order_acceptance` inserts a hypothetical line, calls `run_schedule`
 * and reports what breaks, and it was never in the list — so the second
 * assertion was actively stating that its missing ceiling was correct. It
 * stayed green until the screen failed in front of the client.
 *
 * The list is now derived rather than written down. A function is *long by
 * nature* if it reaches the engine, however many hops away, and the set is
 * computed from the catalogue so a new caller is covered the day it is
 * written rather than the day somebody remembers.
 */

/**
 * Which functions call which, read out of the source text.
 *
 * `pg_proc.prosrc` is what there is: Postgres records no call graph for
 * plpgsql. Matching on `name(` will occasionally catch a mention in a comment,
 * which errs towards demanding a ceiling on a function that may not need one —
 * the safe direction, and one a person resolves by looking rather than by a
 * green test nobody reads.
 */
const REACHES_ENGINE = `
  with recursive fn as (
    select p.oid, p.proname, p.prosrc, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     where p.prokind = 'f'
  ),
  engine as (
    select oid, proname from fn where proname in ('run_schedule', 'run_what_if')
    union
    select f.oid, f.proname
      from fn f
      join engine e on f.prosrc ilike '%' || e.proname || '(%'
     where f.proname <> e.proname
  )
  select distinct e.proname,
         coalesce(array_to_string(f.proconfig, ' '), '') as config
    from engine e
    join fn f on f.oid = e.oid
   order by e.proname`

describe('the long operations are allowed to be long', () => {
  it('gives every function that reaches the engine a raised ceiling', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ proname: string; config: string }>(REACHES_ENGINE),
    )

    // The engine itself, plus everything that calls it. If this drops to two,
    // the reachability query has stopped working and the test with it.
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.map((r) => r.proname)).toContain('check_order_acceptance')

    const bare = rows.filter((r) => !r.config.includes('statement_timeout'))
    expect(
      bare.map((r) => r.proname),
      'these run the engine on the API default of eight seconds',
    ).toEqual([])
  })

  it('keeps the calendar rebuild long too, which nothing else reaches', async () => {
    // Not an engine caller: it is long because it writes a horizon of days.
    const { rows } = await withClient((c) =>
      c.query<{ config: string }>(
        `select array_to_string(proconfig, ' ') as config
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proname = 'rebuild_working_days'`,
      ),
    )
    expect(rows[0].config).toContain('statement_timeout=120s')
  })

  it('raises the ceiling nowhere else', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proconfig::text like '%statement_timeout%'
          order by p.proname`,
      ),
    )
    const { rows: reach } = await withClient((c) =>
      c.query<{ proname: string }>(REACHES_ENGINE),
    )
    const allowed = new Set([
      ...reach.map((r) => r.proname),
      'rebuild_working_days',
    ])
    // A raised ceiling is a protection removed. Something long by nature earns
    // one; anything else should have to justify itself in a diff.
    expect(rows.map((r) => r.proname).filter((n) => !allowed.has(n))).toEqual([])
  })
})
