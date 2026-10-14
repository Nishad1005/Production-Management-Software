// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Who is in counts the department (15 Oct).
 *
 * A head count and overtime typed on Production as a total are the same fact
 * as a roster marked person by person, the guide says — and until this view
 * was rebuilt, a day entered as a total was blank on Manpower's "Who is in".
 * The demo week found it on its third day.
 */
const DAY = '2026-10-14'

describe('who is in', () => {
  it('shows a day the department entered as a number', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 11, null, 12)`, [DAY])
      const { rows } = await c.query<{
        present: number
        ot_person_hours: number
        man_hours: number
        unrecorded: number
      }>(
        `select present, ot_person_hours, man_hours, unrecorded
           from department_manpower_day
          where department_code = 'STITCH' and shift_code = 'GEN' and attendance_date = $1`,
        [DAY],
      )
      expect(rows.length).toBe(1)
      expect(rows[0].present).toBe(11)
      expect(rows[0].ot_person_hours).toBe(12)
      expect(rows[0].man_hours).toBe(100) // 11 × 8 + 12
      // The department said who came in; nobody is individually unmarked.
      expect(rows[0].unrecorded).toBe(0)
    })
  })

  it('still reads the roster, with the department total as the head count', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into employees (emp_code, name, department_id, default_shift_id)
         select v.code, v.name,
                (select id from departments where code = 'STITCH'),
                (select id from shifts where code = 'GEN')
           from (values ('E-W-1', 'Asha'), ('E-W-2', 'Bilal')) as v (code, name)`,
      )
      await c.query(`select set_employee_attendance('E-W-1', $1, 'present', 2)`, [DAY])
      await c.query(`select set_employee_attendance('E-W-2', $1, 'absent', 0)`, [DAY])
      const { rows } = await c.query<{
        present: number
        absent: number
        ot_hours: number
        people_on_ot: number
        ot_person_hours: number
        unrecorded: number
      }>(
        `select present, absent, ot_hours, people_on_ot, ot_person_hours, unrecorded
           from department_manpower_day
          where department_code = 'STITCH' and shift_code = 'GEN' and attendance_date = $1`,
        [DAY],
      )
      expect(rows.length).toBe(1)
      expect(rows[0].present).toBe(1)
      expect(rows[0].absent).toBe(1)
      expect(rows[0].ot_hours).toBe(2)
      expect(rows[0].people_on_ot).toBe(1)
      expect(rows[0].ot_person_hours).toBe(2)
      // Two on the roster marked, of however many are on the books.
      const { rows: books } = await c.query<{ n: number }>(
        `select sanctioned_headcount as n from department_shifts ds
           join departments d on d.id = ds.department_id
           join shifts s on s.id = ds.shift_id
          where d.code = 'STITCH' and s.code = 'GEN'`,
      )
      expect(rows[0].unrecorded).toBe(books[0].n - 2)
    })
  })

  it('lists nothing for a day nobody entered', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query(
        `select 1 from department_manpower_day where attendance_date = '2026-10-15'`,
      )
      expect(rows).toEqual([])
    })
  })
})

describe('the behind card', () => {
  it('keys each shipment line of an order separately', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // One order, two containers, both late at the same departments.
      const first = await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      await c.query(
        `insert into shipment_lines (order_id, line_no, qty, stuffing_date)
         select order_id, 2, 250, '2026-11-23' from shipment_lines where id = $1`,
        [first],
      )
      await runSchedule(c, { today: '2026-10-10' })
      const { rows } = await c.query<{ key: string; n: string }>(
        `select key, count(*)::text as n from attention_behind group by key`,
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => Number(r.n) === 1)).toBe(true)
      expect(rows.some((r) => /:2:/.test(r.key))).toBe(true)
    })
  })
})
