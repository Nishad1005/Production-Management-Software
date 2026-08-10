// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

// Route from the placeholder seed, with yields:
//   WOOD 98% (D-60) → FABCUT 97% (D-50) → STITCH 98% (D-40) → ASSY 99% (D-25)
// Cumulative downstream yield, per spec §4:
const CUM_YIELD = {
  ASSY: 0.99,
  STITCH: 0.98 * 0.99,
  FABCUT: 0.97 * 0.98 * 0.99,
  WOOD: 0.98 * 0.97 * 0.98 * 0.99,
}

describe('run_schedule', () => {
  it('produces one task per shipment line × department × component', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_tasks where run_id = $1`,
        [run],
      )
      // Six BOM components, each made by exactly one department.
      expect(Number(rows[0].n)).toBe(6)

      const { rows: status } = await c.query<{
        status: string
        task_count: number
        breach_count: number
      }>(`select status, task_count, breach_count from schedule_runs where id = $1`, [
        run,
      ])
      expect(status[0].status).toBe('complete')
      expect(status[0].task_count).toBe(6)
    })
  })

  it('inflates quantity by the yield of every downstream department', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ code: string; qty_required: string }>(
        `select cmp.code, t.qty_required
           from schedule_tasks t
           join components cmp on cmp.id = t.component_id
          where t.run_id = $1`,
        [run],
      )
      const qty = Object.fromEntries(
        rows.map((r) => [r.code, Number(r.qty_required)]),
      )

      // 4 legs a chair, and every downstream loss has to be made up front.
      expect(qty.LEG).toBeCloseTo((100 * 4) / CUM_YIELD.WOOD, 2)
      expect(qty['FAB-PANEL']).toBeCloseTo((100 * 6) / CUM_YIELD.FABCUT, 2)
      expect(qty.COVER).toBeCloseTo(100 / CUM_YIELD.STITCH, 2)
      // The last department only has to cover its own loss.
      expect(qty.CHAIR).toBeCloseTo(100 / CUM_YIELD.ASSY, 2)
    })
  })

  it('sets due dates back from the stuffing date, rolled to working days', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{
        code: string
        due_date: string
        is_working: boolean
      }>(
        `select d.code, t.due_date::text, w.is_working
           from schedule_tasks t
           join departments d on d.id = t.department_id
           join working_days w on w.calendar_date = t.due_date
          where t.run_id = $1
          group by d.code, t.due_date, w.is_working
          order by t.due_date`,
        [run],
      )

      // Route order, earliest first, and never on a closed day.
      expect(rows.map((r) => r.code)).toEqual([
        'WOOD',
        'FABCUT',
        'STITCH',
        'ASSY',
      ])
      expect(rows.every((r) => r.is_working)).toBe(true)

      // D-60 from 1 Dec, rolled back to a working day.
      expect(rows[0].due_date <= '2026-10-02').toBe(true)
    })
  })

  it('lays daily load out backwards, remainder on the earliest day', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      // Stitching: 30 covers/day, needs ceil(103.07 / 30) = 4 days.
      const { rows } = await c.query<{ load_date: string; qty: string }>(
        `select l.load_date::text, sum(l.qty_planned)::text as qty
           from schedule_daily_load l
           join components cmp on cmp.id = l.component_id
          where l.run_id = $1 and cmp.code = 'COVER'
          group by l.load_date
          order by l.load_date`,
        [run],
      )

      expect(rows).toHaveLength(4)
      const quantities = rows.map((r) => Number(r.qty))
      // Later days full to capacity; the earliest carries what is left.
      expect(quantities.slice(1)).toEqual([30, 30, 30])
      expect(quantities[0]).toBeCloseTo(100 / CUM_YIELD.STITCH - 90, 2)
    })
  })

  it('never plans a day above its capacity', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 400, stuffingDate: '2026-12-01' })
      await createOrder(c, {
        erpOrderNo: 'SO-2',
        qty: 250,
        stuffingDate: '2026-12-20',
      })
      const run = await runSchedule(c)

      // Per task the plan respects capacity; overlapping orders are exactly
      // what *should* push a day over, and that is a flag, not a bug.
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n
           from (
             select l.shipment_line_id, l.department_id, l.component_id, l.load_date,
                    sum(l.qty_planned) as planned,
                    max(cap.capacity) as capacity
               from schedule_daily_load l
               join (
                 select run_id, department_id, component_id, load_date,
                        sum(capacity) as capacity
                   from schedule_daily_capacity
                  group by run_id, department_id, component_id, load_date
               ) cap
                 on cap.run_id = l.run_id
                and cap.department_id = l.department_id
                and cap.component_id = l.component_id
                and cap.load_date = l.load_date
              where l.run_id = $1
              group by l.shipment_line_id, l.department_id, l.component_id, l.load_date
             having sum(l.qty_planned) > max(cap.capacity) + 0.01
           ) over_capacity`,
        [run],
      )
      expect(Number(rows[0].n)).toBe(0)
    })
  })

  it('plans exactly the required quantity, no more and no less', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 137, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ code: string; diff: string }>(
        `select cmp.code,
                (t.qty_required - coalesce(sum(l.qty_planned), 0))::text as diff
           from schedule_tasks t
           join components cmp on cmp.id = t.component_id
           left join schedule_daily_load l
             on l.run_id = t.run_id
            and l.shipment_line_id = t.shipment_line_id
            and l.department_id = t.department_id
            and l.component_id = t.component_id
          where t.run_id = $1
          group by cmp.code, t.qty_required`,
        [run],
      )

      expect(rows).toHaveLength(6)
      for (const row of rows) {
        // Tolerance covers the proportional split across shifts only.
        expect(Math.abs(Number(row.diff))).toBeLessThan(0.01)
      }
    })
  })
})
