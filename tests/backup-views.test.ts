// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The views a copy of the database is made from.
 *
 * Masters can be re-entered from a spreadsheet and the schedule can be re-run
 * from nothing. What a department declared it made on a Tuesday cannot be
 * reconstructed by anyone — and until these views existed it could not leave
 * the database at all, because every screen's view either aggregates it or
 * slices it by day.
 *
 * What these guard is that the rows come out whole, keyed by things that still
 * mean something in a different database.
 */

async function madeSomething(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)
  const line = (
    await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
  ).rows[0].id

  // The parity fixture works its article through named components, not the
  // stage components the capacity sheet writes, so the code is read from the
  // plan rather than assumed.
  const component = (
    await c.query<{ component_code: string }>(
      `select component_code from schedule_gantt
        where department_code = 'WOOD' limit 1`,
    )
  ).rows[0].component_code

  await c.query(
    `select declare_production($1, 'WOOD', $2, '2026-10-01', 'GEN', 90, 4,
       'ten short, two lengths out of tolerance')`,
    [line, component],
  )
  return { line, component }
}

describe('the ledger, as rows', () => {
  it('comes out whole, keyed by things a different database would recognise', async () => {
    await withRollback(async (c) => {
      await madeSomething(c)

      const { rows } = await c.query<{
        erp_order_no: string
        line_no: number
        department_code: string
        component_code: string
        production_date: string
        shift_code: string
        qty_good: number
        qty_rejected: number
        note: string
      }>(`select * from declaration_list`)

      expect(rows).toHaveLength(1)
      const r = rows[0]
      // Not one internal id among them. A uuid is meaningless the moment the
      // database it came from is gone, which is the only situation this file
      // is ever opened in.
      expect(r.erp_order_no).toBeTruthy()
      expect(r.department_code).toBe('WOOD')
      expect(r.component_code).toBeTruthy()
      expect(r.production_date).toBe('2026-10-01')
      expect(r.shift_code).toBe('GEN')
      expect(r.qty_good).toBe(90)
      expect(r.qty_rejected).toBe(4)
      expect(r.note).toMatch(/tolerance/)
    })
  })

  it('keeps the disagreement between two benches', async () => {
    await withRollback(async (c) => {
      await madeSomething(c)
      const decl = (
        await c.query<{ id: string }>(`select id from production_declarations`)
      ).rows[0].id
      await c.query(
        `select accept_production($1, 'FABCUT', 84, 'six damaged in transit')`,
        [decl],
      )

      const { rows } = await c.query<{
        from_department_code: string
        accepted_by_code: string
        qty_accepted: number
        note: string
      }>(`select * from acceptance_list`)

      expect(rows).toHaveLength(1)
      expect(rows[0].from_department_code).toBe('WOOD')
      expect(rows[0].accepted_by_code).toBe('FABCUT')
      // 90 declared, 84 counted in. A copy that carried only the declaration
      // would quietly settle an argument the ledger exists to hold open.
      expect(rows[0].qty_accepted).toBe(84)
      expect(rows[0].note).toMatch(/damaged/)
    })
  })

  it('carries attendance for somebody who has since left', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_employee('E-1', 'Ramesh', 'STITCH', 'GEN')`)
      await c.query(
        `select set_employee_attendance('E-1', '2026-02-10'::date, 'present', 2)`,
      )
      await c.query(`select set_employee_active('E-1', false)`)

      // The screen's view filters to active people, which is right for a screen
      // and wrong for a copy: somebody who left in March still worked in
      // February, and dropping them rewrites history.
      const { rows: screen } = await c.query(
        `select 1 from employee_day where emp_code = 'E-1'`,
      )
      expect(screen).toHaveLength(0)

      const { rows } = await c.query<{ emp_code: string; ot_hours: number }>(
        `select * from attendance_list where emp_code = 'E-1'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].ot_hours).toBe(2)
    })
  })

  it('gives the order book a key that survives the database', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const { rows } = await c.query<{
        erp_order_no: string
        customer_code: string
        article_code: string
        total_qty: number
      }>(`select * from order_list`)
      expect(rows[0].customer_code).toBeTruthy()
      expect(rows[0].article_code).toBe('AARA-LC')
      expect(rows[0].total_qty).toBe(100)

      // And a shipment line can be tied back to its order by that key rather
      // than by a uuid that will not exist after a rebuild.
      const { rows: lines } = await c.query<{ erp_order_no: string }>(
        `select erp_order_no from shipment_line_list`,
      )
      expect(lines[0].erp_order_no).toBe(rows[0].erp_order_no)
    })
  })

  it('leaves the existing shipment-line columns exactly where they were', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // The view was replaced to add a column. Replacing one is how a screen
      // silently loses a field, so the old shape is asserted rather than
      // assumed.
      const { rows } = await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'shipment_line_list' order by ordinal_position`,
      )
      expect(rows.map((r) => r.column_name)).toEqual([
        'id',
        'order_id',
        'line_no',
        'qty',
        'stuffing_date',
        'delivery_date',
        'container_ref',
        'material_ready_date',
        'erp_order_no',
      ])
    })
  })
})
