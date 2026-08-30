// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The attention screen must read the current plan, not every plan ever made.
 *
 * These are plan tests, which are usually a bad idea — they assert on how
 * Postgres chose to do something rather than on what came back. Here it is the
 * only instrument available. The defect was invisible to every other check:
 * output was correct, local timing was single-digit milliseconds, and the cost
 * only appeared on Supabase where row-level security is actually applied and
 * twenty runs of history had accumulated. What went wrong was the *shape* of
 * the read, so the shape is what has to be asserted.
 */

/** Four departments, one order, and five plans of it — one of them current. */
async function fiveRuns(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 400, stuffingDate: '2026-12-01' })
  for (let i = 0; i < 5; i++) await runSchedule(c)
  await c.query('analyze')
}

const planFor = async (c: pg.Client, view: string) =>
  (
    await c.query<{ 'QUERY PLAN': string }>(
      `explain (analyze) select * from ${view}`,
    )
  ).rows
    .map((r) => r['QUERY PLAN'])
    .join('\n')

/** Rows the plan actually read from a table, whatever the access method. */
function rowsRead(plan: string, table: string): number {
  const line = plan
    .split('\n')
    .find((l) => l.includes(` on ${table} `) || l.endsWith(` on ${table}`))
  expect(line, `no scan of ${table} in plan:\n${plan}`).toBeDefined()
  return Number(/actual .*rows=([\d.]+)/.exec(line!)?.[1] ?? NaN)
}

describe('the overload alert reads one plan', () => {
  it('touches only the current run’s rows, not the whole history', async () => {
    await withRollback(async (c) => {
      await fiveRuns(c)

      const all = Number(
        (await c.query<{ n: string }>(`select count(*) n from schedule_daily_capacity`))
          .rows[0].n,
      )
      const current = Number(
        (
          await c.query<{ n: string }>(
            `select count(*) n from schedule_daily_capacity
              where run_id = current_run_id()`,
          )
        ).rows[0].n,
      )
      // The fixture has to be able to tell the two apart, or this proves nothing.
      expect(all).toBeGreaterThan(current)

      const plan = await planFor(c, 'attention_overloaded')
      expect(plan).toContain('run_id = current_run_id()')
      expect(rowsRead(plan, 'schedule_daily_capacity')).toBeLessThanOrEqual(current)
    })
  })

  it('read the whole history when it joined schedule_runs instead', async () => {
    // The defect, reproduced, so the assertion above is known to be capable of
    // failing. A join cannot be pushed through a GROUP BY: the aggregate runs
    // over every run in the table and the join discards the rest afterwards.
    await withRollback(async (c) => {
      await fiveRuns(c)
      await c.query(`
        create or replace view public.attention_overloaded
        with (security_invoker = true) as
          select 'overloaded' as kind, 'warning' as severity,
                 t.department_code as title, t.load_date as detail,
                 '/heatmap' as route, t.department_code as key,
                 t.days_out as days_out
            from public.schedule_flag_triage t
            join public.schedule_runs r on r.id = t.run_id and r.is_current
           where t.days_out >= 0`)

      const all = Number(
        (await c.query<{ n: string }>(`select count(*) n from schedule_daily_capacity`))
          .rows[0].n,
      )
      const plan = await planFor(c, 'attention_overloaded')
      expect(plan).not.toContain('run_id = current_run_id()')
      expect(rowsRead(plan, 'schedule_daily_capacity')).toBe(all)
    })
  })

  it('reports the same findings either way', async () => {
    await withRollback(async (c) => {
      await fiveRuns(c)
      const fixed = await c.query(`select * from attention_overloaded order by key`)
      await c.query(`
        create or replace view public.attention_overloaded
        with (security_invoker = true) as
          select 'overloaded' as kind,
                 case when t.days_out < 15 then 'critical' else 'warning' end as severity,
                 t.department_code || ' is over capacity on ' || t.load_date as title,
                 'Asked for ' || round(100 * t.over_by)::text || '% more than it can make · ' ||
                   replace(t.still_possible, '_', ' ') as detail,
                 '/heatmap' as route,
                 'overloaded:' || t.department_code || ':' || t.load_date as key,
                 t.days_out as days_out
            from public.schedule_flag_triage t
            join public.schedule_runs r on r.id = t.run_id and r.is_current
           where t.days_out >= 0`)
      const joined = await c.query(`select * from attention_overloaded order by key`)

      // A factory with something wrong with it, or this compares two blanks.
      expect(fixed.rows.length).toBeGreaterThan(0)
      expect(fixed.rows).toEqual(joined.rows)
    })
  })
})

describe('schedule history stays bounded', () => {
  it('keeps the current run and the last twenty, and drops the rest', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 400, stuffingDate: '2026-12-01' })
      await runSchedule(c)

      // Inserted directly rather than planned twenty-five times: the trigger
      // fires on the insert, which is the thing under test.
      for (let i = 0; i < 25; i++) {
        await c.query(
          `insert into schedule_runs (run_at, status)
           values (now() - ($1 || ' hours')::interval, 'complete')`,
          [i],
        )
      }

      const { rows } = await c.query<{ total: string; current: string }>(
        `select count(*) as total,
                count(*) filter (where is_current) as current
           from schedule_runs`,
      )
      expect(Number(rows[0].current)).toBe(1)
      expect(Number(rows[0].total)).toBe(21)
    })
  })

  it('never drops the run the factory is working to', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 400, stuffingDate: '2026-12-01' })
      const live = await runSchedule(c)

      // Every one of these is more recent than the live plan.
      for (let i = 0; i < 30; i++) {
        await c.query(`insert into schedule_runs (status) values ('complete')`)
      }

      const { rows } = await c.query<{ id: string }>(
        `select id from schedule_runs where is_current`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(live)
    })
  })
})
