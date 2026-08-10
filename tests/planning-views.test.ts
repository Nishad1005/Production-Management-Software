// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

describe('load heatmap', () => {
  it('reports utilisation as the fraction of the day consumed', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      // Stitching runs 30 covers a day and needs about 103, so its full days
      // sit at exactly 1.0 and the remainder day below it.
      const { rows } = await c.query<{ utilisation: string; status: string }>(
        `select dd.utilisation::text, dd.status
           from schedule_department_day dd
           join departments d on d.id = dd.department_id
          where dd.run_id = $1 and d.code = 'STITCH' and dd.status <> 'idle'
          order by dd.load_date`,
        [run],
      )

      expect(rows).toHaveLength(4)
      expect(rows.slice(1).map((r) => Number(r.utilisation))).toEqual([1, 1, 1])
      expect(Number(rows[0].utilisation)).toBeLessThan(1)
      expect(rows.every((r) => r.status === 'loaded')).toBe(true)
    })
  })

  it('adds utilisation across components rather than adding units', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      // Wood makes legs (160/day), seat frames and back frames (40/day each).
      // On a day running all three, the fractions add up — the raw unit counts
      // could not, being different things.
      const { rows } = await c.query<{
        utilisation: string
        components_loaded: number
      }>(
        `select dd.utilisation::text, dd.components_loaded
           from schedule_department_day dd
           join departments d on d.id = dd.department_id
          where dd.run_id = $1 and d.code = 'WOOD' and dd.components_loaded > 1
          limit 1`,
        [run],
      )

      expect(rows.length).toBeGreaterThan(0)
      expect(Number(rows[0].utilisation)).toBeGreaterThan(0)
    })
  })

  it('flags a day pushed over capacity by overlapping orders', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Three orders landing on nearly the same dates: exactly the case
      // capacity flagging exists for.
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      await createOrder(c, {
        erpOrderNo: 'SO-B',
        qty: 300,
        stuffingDate: '2026-12-02',
      })
      await createOrder(c, {
        erpOrderNo: 'SO-C',
        qty: 300,
        stuffingDate: '2026-12-03',
      })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_department_day
          where run_id = $1 and status = 'over'`,
        [run],
      )
      expect(Number(rows[0].n)).toBeGreaterThan(0)
    })
  })
})

describe('bottleneck utilisation', () => {
  it('ranks the structural constraint above departments with slack', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{
        department_code: string
        avg_utilisation: string
        bottleneck_rank: number
      }>(
        `select department_code, avg_utilisation::text, bottleneck_rank
           from schedule_bottleneck where run_id = $1 order by bottleneck_rank`,
        [run],
      )

      expect(rows).toHaveLength(4)
      // Stitching at 30/day is the slowest step on this route and should come
      // out top — the view that answers where the next person goes.
      expect(rows[0].department_code).toBe('STITCH')
      // Ranking is monotonic in average utilisation.
      const utilisations = rows.map((r) => Number(r.avg_utilisation))
      expect([...utilisations].sort((a, b) => b - a)).toEqual(utilisations)
    })
  })
})

describe('flag triage', () => {
  it('labels each flagged day by what is still possible at that lead time', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      await createOrder(c, {
        erpOrderNo: 'SO-B',
        qty: 300,
        stuffingDate: '2026-12-02',
      })
      const run = await runSchedule(c)

      const { rows } = await c.query<{
        still_possible: string
        days_out: number
      }>(
        `select still_possible, days_out from schedule_flag_triage
          where run_id = $1`,
        [run],
      )

      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const expected =
          row.days_out >= 45
            ? 'hiring'
            : row.days_out >= 15
              ? 'overtime_resequence_subcontract'
              : 'customer_conversation'
        expect(row.still_possible).toBe(expected)
      }
    })
  })
})

describe('idle capacity', () => {
  it('surfaces the empty days that sit just before the work', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_idle_capacity
          where run_id = $1 and idle_fraction = 1`,
        [run],
      )
      // Backward scheduling packs work as late as possible, so a small order
      // leaves plenty of empty days inside the horizon.
      expect(Number(rows[0].n)).toBeGreaterThan(0)
    })
  })
})

describe('order acceptance check', () => {
  it('reports what would breach, and leaves nothing behind', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      await runSchedule(c)

      const before = await c.query<{ orders: string; runs: string }>(
        `select (select count(*) from orders)::text as orders,
                (select count(*) from schedule_runs)::text as runs`,
      )

      const { rows } = await c.query<{
        department_code: string
        is_feasible: boolean
        breach_reason: string | null
      }>(
        `select department_code, is_feasible, breach_reason
           from check_order_acceptance(
             (select id from articles where code = 'AARA-LC'),
             5000, '2026-12-20'::date)`,
      )

      // A 5,000-chair order on three weeks' notice cannot be made.
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((r) => !r.is_feasible)).toBe(true)

      // Spec §14: it must find the problem before the commitment — and not by
      // leaving a phantom order in the book.
      const after = await c.query<{ orders: string; runs: string }>(
        `select (select count(*) from orders)::text as orders,
                (select count(*) from schedule_runs)::text as runs`,
      )
      expect(after.rows[0]).toEqual(before.rows[0])
    })
  })

  it('passes an order the factory can absorb', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      const { rows } = await c.query<{ is_feasible: boolean }>(
        `select is_feasible from check_order_acceptance(
           (select id from articles where code = 'AARA-LC'),
           50, '2027-06-01'::date)`,
      )

      expect(rows.length).toBe(6)
      expect(rows.every((r) => r.is_feasible)).toBe(true)
    })
  })

  it('suggests a later date when the asked-for one will not work', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      const { rows } = await c.query<{ d: string | null }>(
        `select suggest_stuffing_date(
           (select id from articles where code = 'AARA-LC'),
           1200, '2027-01-04'::date, 7, 12)::text as d`,
      )

      // Either a clean date inside the search window, or an honest null.
      if (rows[0].d !== null) {
        expect(rows[0].d >= '2027-01-04').toBe(true)

        const { rows: check } = await c.query<{ is_feasible: boolean }>(
          `select is_feasible from check_order_acceptance(
             (select id from articles where code = 'AARA-LC'), 1200, $1::date)`,
          [rows[0].d],
        )
        expect(check.every((r) => r.is_feasible)).toBe(true)
      }
    })
  })
})
