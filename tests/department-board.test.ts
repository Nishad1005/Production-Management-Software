// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The department's own board, specified by U&M: "what are the pending remaining
 * for that day, work order or according to their shipping date, and from which
 * department a component has to come so as to I can start my work."
 */

async function seeded(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)
}

const declare = (
  c: pg.Client,
  department: string,
  component: string,
  good: number,
) =>
  c.query(
    `select declare_production(
       (select id from shipment_lines limit 1),
       $1, $2, '2026-10-01'::date, 'GEN', $3, 0)`,
    [department, component, good],
  )

describe('what is left to do', () => {
  it('reports required, done and remaining per job', async () => {
    await withRollback(async (c) => {
      await seeded(c)

      const { rows: before } = await c.query<{
        qty_required: number
        qty_done: number
        qty_remaining: number
        state: string
      }>(
        `select qty_required, qty_done, qty_remaining, state
           from department_queue
          where department_code = 'STITCH' and component_code = 'COVER'`,
      )
      expect(before[0].qty_done).toBe(0)
      expect(before[0].qty_remaining).toBe(before[0].qty_required)
      expect(before[0].state).toBe('not started')

      await declare(c, 'STITCH', 'COVER', 40)

      const { rows: after } = await c.query<{
        qty_remaining: number
        state: string
      }>(
        `select qty_remaining, state from department_queue
          where department_code = 'STITCH' and component_code = 'COVER'`,
      )
      expect(after[0].qty_remaining).toBeCloseTo(
        before[0].qty_required - 40,
        3,
      )
      expect(after[0].state).toBe('in progress')
    })
  })

  it('never reports a negative remainder', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      // Overproduction is normal — a department runs the batch out rather than
      // stopping mid-way. "Minus twelve to do" is not a thing to put on a board.
      await declare(c, 'STITCH', 'COVER', 5000)
      const { rows } = await c.query<{ qty_remaining: number; state: string }>(
        `select qty_remaining, state from department_queue
          where department_code = 'STITCH' and component_code = 'COVER'`,
      )
      expect(rows[0].qty_remaining).toBe(0)
      expect(rows[0].state).toBe('complete')
    })
  })

  it('orders by the container, not by the department’s own deadline', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, {
        erpOrderNo: 'SO-LATE',
        qty: 50,
        stuffingDate: '2027-03-01',
      })
      await createOrder(c, {
        erpOrderNo: 'SO-SOON',
        qty: 50,
        stuffingDate: '2026-11-02',
      })
      await runSchedule(c)

      const { rows } = await c.query<{ erp_order_no: string }>(
        `select erp_order_no from department_queue
          where department_code = 'STITCH'
          order by stuffing_date`,
      )
      expect(rows[0].erp_order_no).toBe('SO-SOON')
      expect(rows[rows.length - 1].erp_order_no).toBe('SO-LATE')
    })
  })

  it('counts the days left to the container, and lets them go negative', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // A container that has already sailed is the most urgent thing on a
      // board, and clamping it to zero would hide exactly that.
      await createOrder(c, { qty: 50, stuffingDate: '2026-01-05' })
      await runSchedule(c)
      const { rows } = await c.query<{ days_to_stuffing: number }>(
        `select days_to_stuffing from department_queue limit 1`,
      )
      expect(rows[0].days_to_stuffing).toBeLessThan(0)
    })
  })
})

describe('what I am waiting for', () => {
  it('names the department that feeds me, from the route graph', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const { rows } = await c.query<{
        from_department_code: string
        state: string
      }>(
        `select from_department_code, state from department_inbound
          where department_code = 'ASSY'`,
      )
      // Assembly is fed by stitching in the seeded line, and by nothing else.
      expect(rows).toHaveLength(1)
      expect(rows[0].from_department_code).toBe('STITCH')
      expect(rows[0].state).toBe('not started')
    })
  })

  it('turns ready once the feeder has made what it owes', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const { rows: owed } = await c.query<{ qty_required: number }>(
        `select qty_required from department_inbound
          where department_code = 'ASSY' and from_department_code = 'STITCH'`,
      )

      await declare(c, 'STITCH', 'COVER', owed[0].qty_required)

      const { rows } = await c.query<{ state: string; qty_made: number }>(
        `select state, qty_made from department_inbound
          where department_code = 'ASSY' and from_department_code = 'STITCH'`,
      )
      expect(rows[0].state).toBe('ready')
      expect(rows[0].qty_made).toBeCloseTo(owed[0].qty_required, 3)
    })
  })

  it('tells made apart from counted in', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      const { rows: made } = await declare(c, 'STITCH', 'COVER', 40) as never
      void made

      // Stitching has made 40. None of it has reached assembly's bench yet —
      // different problem, different person to talk to.
      const { rows: before } = await c.query<{
        qty_made: number
        qty_counted_in: number
      }>(
        `select qty_made, qty_counted_in from department_inbound
          where department_code = 'ASSY' and from_department_code = 'STITCH'`,
      )
      expect(before[0].qty_made).toBe(40)
      expect(before[0].qty_counted_in).toBe(0)

      const { rows: decl } = await c.query<{ id: string }>(
        `select id from production_declarations`,
      )
      await c.query(`select accept_production($1, 'ASSY', 38)`, [decl[0].id])

      const { rows: after } = await c.query<{ qty_counted_in: number }>(
        `select qty_counted_in from department_inbound
          where department_code = 'ASSY' and from_department_code = 'STITCH'`,
      )
      expect(after[0].qty_counted_in).toBe(38)
    })
  })

  it('says nothing for a department nothing feeds', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      // Wood is the head of the seeded line. It waits for no one, and a board
      // inventing a feeder for it would send someone chasing a phantom.
      const { rows } = await c.query(
        `select * from department_inbound where department_code = 'WOOD'`,
      )
      expect(rows).toEqual([])
    })
  })

  it('follows the graph when it changes, rather than the route order', async () => {
    await withRollback(async (c) => {
      await seeded(c)
      // Say wood feeds assembly directly. Assembly's board should now name
      // wood, because the board reads the same edges the engine does.
      await c.query(`select set_department_dependency('ASSY', 'STITCH', false)`)
      await c.query(`select set_department_dependency('ASSY', 'WOOD', true)`)
      await runSchedule(c)

      const { rows } = await c.query<{ from_department_code: string }>(
        `select from_department_code from department_inbound
          where department_code = 'ASSY' order by from_department_code`,
      )
      expect(rows.map((r) => r.from_department_code)).toEqual(['WOOD'])
    })
  })
})
