// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient } from './helpers/db'

/**
 * The engine carries its own statement timeout.
 *
 * Supabase gives the `authenticated` role eight seconds, which is right for a
 * web API and too short for a schedule run: the scale test has always put the
 * engine at about 4.6 seconds for U&M's stated workload, close enough that a
 * larger order book crosses it. It did — `canceling statement due to statement
 * timeout`, on the live project, on the one operation the system is built
 * around.
 *
 * Asserted here rather than trusted, because it is invisible: nothing on any
 * screen says whether a function carries a setting, and the failure it prevents
 * only appears at a scale the local suite does not reach.
 */
describe('the long operations are allowed to be long', () => {
  it('set a statement timeout on the engine and the calendar', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ proname: string; proconfig: string[] | null }>(
        `select p.proname, p.proconfig
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('run_schedule', 'run_what_if', 'rebuild_working_days')
          order by p.proname`,
      ),
    )

    expect(rows.length).toBe(3)
    for (const r of rows) {
      const config = (r.proconfig ?? []).join(' ')
      expect(config, `${r.proname} has no statement_timeout`).toContain(
        'statement_timeout=120s',
      )
    }
  })

  it('leaves everything else on the API default', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proconfig::text like '%statement_timeout%'
          order by p.proname`,
      ),
    )
    // A raised ceiling is a protection removed. Three functions are genuinely
    // long by nature; anything else appearing here should have to justify
    // itself in a diff rather than arriving quietly.
    expect(rows.map((r) => r.proname)).toEqual([
      'rebuild_working_days',
      'run_schedule',
      'run_what_if',
    ])
  })
})
