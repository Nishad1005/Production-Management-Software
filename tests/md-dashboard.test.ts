// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Slide 6. Held back until the WIP ledger existed, because six of its nine
 * figures need actuals from the floor and there were none — six invented
 * numbers beside three real ones is worse than no dashboard, since a dashboard
 * is believed.
 *
 * What these mostly guard is the honesty of it: a figure that cannot be
 * computed has to say so rather than show a zero.
 */

type Kpi = {
  key: string
  target: number
  actual: number | null
  available: boolean
  unavailable_because: string | null
  status: string
}

const kpis = async (c: pg.Client) => {
  const { rows } = await c.query<Kpi>(
    `select key, target, actual, available, unavailable_because, status
       from md_dashboard order by sort_order`,
  )
  return Object.fromEntries(rows.map((r) => [r.key, r]))
}

async function seeded(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)
}

describe('the nine figures', () => {
  it('shows the deck’s nine, plus WIP in units, in order', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const { rows } = await c.query<{ key: string }>(
        `select key from md_dashboard order by sort_order`,
      )
      expect(rows.map((r) => r.key)).toEqual([
        'orders_running',
        'otif',
        'daily_production',
        // Added once the client deferred cost: the WIP figure that needs none.
        'wip_units',
        'wip_value',
        'efficiency',
        'rejections',
        'material_shortage',
        'delayed_orders',
        'containers_ready',
      ])
    })
  })

  it('reports WIP value as unavailable rather than as zero', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const k = await kpis(c)
      // The one figure with no data behind it. A rupee number invented here
      // would be the most quoted on the screen and the only fabricated one.
      expect(k.wip_value.available).toBe(false)
      expect(k.wip_value.actual).toBeNull()
      expect(k.wip_value.status).toBe('unavailable')
      expect(k.wip_value.unavailable_because).toMatch(/page 33/i)
    })
  })

  it('says why, for anything else it cannot compute yet', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const k = await kpis(c)
      // Nothing declared and nothing completed, so these have no denominator.
      expect(k.otif.available).toBe(false)
      expect(k.otif.unavailable_because).toMatch(/nothing to be on time about/i)
      expect(k.rejections.available).toBe(false)
      expect(k.rejections.unavailable_because).toMatch(/nothing has been declared/i)
    })
  })

  it('counts what it can without any production at all', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const k = await kpis(c)
      expect(k.orders_running.actual).toBe(1)
      expect(k.orders_running.available).toBe(true)
      expect(k.delayed_orders.available).toBe(true)
      expect(k.containers_ready.actual).toBe(0)
    })
  })
})

describe('reading a figure the right way round', () => {
  it('treats a low rejection rate as good and a low OTIF as bad', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const line = (
        await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
      ).rows[0].id

      // 98 good, 2 rejected — 2% against a 2% target, and lower is better.
      await c.query(
        `select declare_production($1, 'STITCH', 'COVER', current_date, 'GEN', 98, 2)`,
        [line],
      )

      const k = await kpis(c)
      expect(k.rejections.actual).toBeCloseTo(2, 2)
      expect(k.rejections.status).toBe('good')
    })
  })

  it('treats a target of zero as no target rather than as a failure', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const k = await kpis(c)
      // Containers ready ships with no target. Reporting red against a number
      // nobody chose trains people to ignore the colour.
      expect(k.containers_ready.target).toBe(0)
      expect(k.containers_ready.status).toBe('none')
    })
  })

  it('takes a target the client sets', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      await c.query(`select set_kpi_target('containers_ready', 5)`)
      const k = await kpis(c)
      expect(k.containers_ready.target).toBe(5)
      // 0 of 5 — genuinely bad, and now says so.
      expect(k.containers_ready.status).toBe('bad')
    })
  })
})

describe('OTIF, measured rather than projected', () => {
  it('counts a line as on time only when every department made it in time', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)
      const line = (
        await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
      ).rows[0].id

      // Every department declares exactly what it owed, on its own due date.
      const { rows: tasks } = await c.query<{
        department_code: string
        component_code: string
        due_date: string
        qty_required: string
      }>(
        `select department_code, component_code, due_date, qty_required::text
           from schedule_gantt where run_id = $1`,
        [run],
      )
      for (const t of tasks) {
        await c.query(
          `select declare_production($1, $2, $3, $4::date, 'GEN', $5, 0)`,
          [line, t.department_code, t.component_code, t.due_date, Number(t.qty_required)],
        )
      }

      const k = await kpis(c)
      expect(k.containers_ready.actual).toBe(1)
      expect(k.otif.available).toBe(true)
      expect(k.otif.actual).toBe(100)
    })
  })

  it('counts a late finish as complete but not on time', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)
      const line = (
        await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
      ).rows[0].id

      const { rows: tasks } = await c.query<{
        department_code: string
        component_code: string
        due_date: string
        qty_required: string
      }>(
        `select department_code, component_code, due_date, qty_required::text
           from schedule_gantt where run_id = $1`,
        [run],
      )
      for (const [i, t] of tasks.entries()) {
        // One department finishes a week late. Everything got made, so the
        // line is complete — and it is not OTIF, which is the whole point of
        // measuring the two separately.
        const date = i === 0 ? '2026-12-15' : t.due_date
        await c.query(
          `select declare_production($1, $2, $3, $4::date, 'GEN', $5, 0)`,
          [line, t.department_code, t.component_code, date, Number(t.qty_required)],
        )
      }

      const k = await kpis(c)
      expect(k.containers_ready.actual).toBe(1)
      expect(k.otif.actual).toBe(0)
    })
  })
})
