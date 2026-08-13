// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * "What if we don't use cost as of now, since the main thing we want to do is
 * WIP." Nothing built touches money, so WIP in units is the whole answer — and
 * these pin down what "in progress" means, which is the only part with any
 * judgement in it.
 */

const kpi = async (c: pg.Client, key: string) =>
  (
    await c.query<{
      actual: number | null
      available: boolean
      unavailable_because: string | null
    }>(
      `select actual, available, unavailable_because
         from md_dashboard where key = $1`,
      [key],
    )
  ).rows[0]

async function seeded(c: pg.Client, qty = 100) {
  await applySeed(c)
  await createOrder(c, { qty, stuffingDate: '2026-12-01' })
  const run = await runSchedule(c)
  const line = (
    await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
  ).rows[0].id
  return { run, line }
}

/** Declares exactly what every department owed, on its own due date. */
async function completeEverything(c: pg.Client, run: string, line: string) {
  const { rows } = await c.query<{
    department_code: string
    component_code: string
    due_date: string
    qty_required: string
  }>(
    `select department_code, component_code, due_date, qty_required::text
       from schedule_gantt where run_id = $1`,
    [run],
  )
  for (const t of rows) {
    await c.query(
      `select declare_production($1, $2, $3, $4::date, 'GEN', $5, 0)`,
      [line, t.department_code, t.component_code, t.due_date, Number(t.qty_required)],
    )
  }
}

describe('WIP measured in units', () => {
  it('is nothing before anyone has started', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const wip = await kpi(c, 'wip_units')
      expect(wip.available).toBe(true)
      expect(wip.actual).toBe(0)
    })
  })

  it('counts the whole line once any department has started it', async () => {
    await withRollback(async (c) => {
      const { line } = await seeded(c, 100)
      await c.query(
        `select declare_production($1, 'WOOD', 'LEG', current_date, 'GEN', 40, 0)`,
        [line],
      )
      // A hundred chairs part-made is a hundred chairs in progress, however
      // many legs that took. The line's own quantity, not the yield-inflated
      // component totals.
      expect((await kpi(c, 'wip_units')).actual).toBe(100)
    })
  })

  it('stops counting it once every department is done', async () => {
    await withRollback(async (c) => {
      const { run, line } = await seeded(c, 100)
      await completeEverything(c, run, line)
      expect((await kpi(c, 'wip_units')).actual).toBe(0)
      // And it has moved to the other end of the pipe.
      expect((await kpi(c, 'containers_ready')).actual).toBe(1)
    })
  })

  it('is not the same question as containers ready', async () => {
    await withRollback(async (c) => {
      const { line } = await seeded(c, 100)
      await c.query(
        `select declare_production($1, 'WOOD', 'LEG', current_date, 'GEN', 40, 0)`,
        [line],
      )
      // Started and not finished: in progress, and not ready to stuff.
      expect((await kpi(c, 'wip_units')).actual).toBe(100)
      expect((await kpi(c, 'containers_ready')).actual).toBe(0)
    })
  })
})

describe('WIP value, still refused', () => {
  it('says what it needs rather than showing a figure', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const value = await kpi(c, 'wip_value')
      expect(value.available).toBe(false)
      expect(value.actual).toBeNull()
      // Names the specific thing, so the ask does not grow back into "send us
      // your costing".
      expect(value.unavailable_because).toMatch(/page 33/i)
      expect(value.unavailable_because).toMatch(/one row per article/i)
    })
  })

  it('is the only one missing a master rather than merely missing activity', async () => {
    await withRollback(async (c) => {
      const { run, line } = await seeded(c)
      await completeEverything(c, run, line)

      const { rows } = await c.query<{ key: string; reason: string }>(
        `select key, unavailable_because as reason
           from md_dashboard where not available order by key`,
      )

      // Efficiency can also be unavailable here, and legitimately: the seeded
      // plan sits months ahead, so there is no load in the last thirty days to
      // measure against. That resolves itself the moment work is planned.
      // wip_value never will — it is waiting on data nobody has entered.
      expect(rows.map((r) => r.key)).toContain('wip_value')
      expect(rows.find((r) => r.key === 'wip_value')!.reason).toMatch(/page 33/i)
      for (const r of rows.filter((x) => x.key !== 'wip_value')) {
        expect(r.reason).toMatch(/nothing (has been|is)/i)
      }

      // And everything the ledger can answer, it does.
      const { rows: ok } = await c.query<{ key: string }>(
        `select key from md_dashboard where available and key in
           ('wip_units', 'otif', 'containers_ready', 'rejections')`,
      )
      expect(ok).toHaveLength(4)
    })
  })
})

describe('where each line has got to', () => {
  it('reports progress across the route, not weighted by quantity', async () => {
    await withRollback(async (c) => {
      const { line } = await seeded(c, 100)
      // Wood is one of four departments and makes three components. Finishing
      // it is a quarter of the route, not three sevenths of the parts.
      // wip_by_order groups by department; the component breakdown is on the
      // gantt, which is what declarations are keyed by.
      const { rows: owed } = await c.query<{
        component_code: string
        qty_required: string
      }>(
        `select component_code, qty_required::text from schedule_gantt
          where department_code = 'WOOD'`,
      )
      for (const t of owed) {
        await c.query(
          `select declare_production($1, 'WOOD', $2, current_date, 'GEN', $3, 0)`,
          [line, t.component_code, Number(t.qty_required)],
        )
      }

      const { rows } = await c.query<{
        departments: number
        departments_done: number
        fraction_done: number
        started: boolean
        complete: boolean
      }>(`select * from wip_lines`)

      expect(rows[0].departments).toBe(4)
      expect(rows[0].departments_done).toBe(1)
      expect(rows[0].fraction_done).toBeCloseTo(0.25, 4)
      expect(rows[0].started).toBe(true)
      expect(rows[0].complete).toBe(false)
    })
  })

  it('turns complete only when the whole route is', async () => {
    await withRollback(async (c) => {
      const { run, line } = await seeded(c)
      await completeEverything(c, run, line)
      const { rows } = await c.query<{
        complete: boolean
        fraction_done: number
      }>(`select complete, fraction_done from wip_lines`)
      expect(rows[0].complete).toBe(true)
      expect(rows[0].fraction_done).toBeCloseTo(1, 4)
    })
  })

  it('counts down to the container, and lets it go negative', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 50, stuffingDate: '2026-01-05' })
      await runSchedule(c)
      const { rows } = await c.query<{ days_to_stuffing: number }>(
        `select days_to_stuffing from wip_lines`,
      )
      expect(rows[0].days_to_stuffing).toBeLessThan(0)
    })
  })
})
