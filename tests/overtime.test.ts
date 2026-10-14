// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Overtime feeds capacity (15 Oct).
 *
 * The day's rate becomes units_per_day × present/manpower × (1 + overtime) ×
 * machines, where overtime = person-hours × the shift's overtime efficiency ÷
 * (people × the shift's net production hours), person-hours capped at the
 * shift's maximum per person. The seed's general shift: 8 hours, 5 overtime
 * hours a person at most, 85% efficiency. Stitching makes 30 covers a day.
 */

const DAY = '2026-10-14'

const capacity = async (c: pg.Client, date = DAY) =>
  Number(
    (
      await c.query<{ units: string }>(
        `select resolve_capacity(
             (select id from departments where code = 'STITCH'),
             (select id from shifts where code = 'GEN'),
             (select id from components where code = 'COVER'),
             $1::date)::text as units`,
        [date],
      )
    ).rows[0].units,
  )

const crewOf12 = (c: pg.Client) =>
  c.query(
    `update component_rates set manpower = 12
      where department_id = (select id from departments where code = 'STITCH')`,
  )

const dayRow = async (c: pg.Client) =>
  (
    await c.query<{
      ot_person_hours: number | null
      ot_fraction: number | null
      ot_over_limit: boolean | null
      man_hours: number | null
    }>(
      `select ot_person_hours, ot_fraction, ot_over_limit, man_hours
         from department_day
        where department_code = 'STITCH' and shift_code = 'GEN' and attendance_date = $1`,
      [DAY],
    )
  ).rows[0]

describe('overtime feeds capacity', () => {
  it('adds person-hours at the overtime efficiency over the crew hours', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      // Twelve in, twelve overtime hours between them: 12 × 0.85 ÷ (12 × 8).
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 12, null, 12)`, [DAY])
      expect(await capacity(c)).toBe(33.188) // 30 × 1.10625
      const row = await dayRow(c)
      expect(row.ot_fraction).toBeCloseTo(0.1063, 3)
      expect(row.man_hours).toBe(108) // 12 × 8 + 12
      expect(row.ot_over_limit).toBe(false)
    })
  })

  it('is worked out on who came in, not on the crew size', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      // Six in, the same twelve hours: 12 × 0.85 ÷ (6 × 8) on half the rate.
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 6, null, 12)`, [DAY])
      expect(await capacity(c)).toBe(18.188) // 15 × 1.2125
    })
  })

  it('counts no more than the shift allows a person', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      // Forty hours by six people is more than five a head: thirty count.
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 6, null, 40)`, [DAY])
      expect(await capacity(c)).toBe(22.969) // 15 × (1 + 25.5 / 48)
      expect((await dayRow(c)).ot_over_limit).toBe(true)
    })
  })

  it('keeps the hours when only the head count is corrected', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 12, null, 12)`, [DAY])
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 11)`, [DAY])
      expect((await dayRow(c)).ot_person_hours).toBe(12)
      // And zero is zero, not "keep".
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 11, null, 0)`, [DAY])
      expect((await dayRow(c)).ot_person_hours).toBe(0)
    })
  })

  it('is summed from the roster when people are marked one by one', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      await c.query(
        `insert into employees (emp_code, name, department_id, default_shift_id)
         select v.code, v.name,
                (select id from departments where code = 'STITCH'),
                (select id from shifts where code = 'GEN')
           from (values ('E-OT-1', 'Asha'), ('E-OT-2', 'Bilal'), ('E-OT-3', 'Chitra')) as v (code, name)`,
      )
      await c.query(`select set_employee_attendance('E-OT-1', $1, 'present', 2)`, [DAY])
      await c.query(`select set_employee_attendance('E-OT-2', $1, 'present', 3)`, [DAY])
      // Hours against someone who did not come in do not count.
      await c.query(`select set_employee_attendance('E-OT-3', $1, 'absent', 4)`, [DAY])
      const { rows } = await c.query<{ present: number; ot: string }>(
        `select present, ot_person_hours::text as ot
           from department_attendance
          where department_id = (select id from departments where code = 'STITCH')
            and attendance_date = $1`,
        [DAY],
      )
      expect(rows[0].present).toBe(2)
      expect(Number(rows[0].ot)).toBe(5)
    })
  })

  it('reaches the plan: the engine writes the same cell as the referee', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      // 600 chairs on 1 Dec keep stitching busy through October.
      await createOrder(c, { qty: 600, stuffingDate: '2026-12-01' })
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 12, null, 12)`, [DAY])
      const run = await runSchedule(c)
      const { rows } = await c.query<{ cap: string }>(
        `select c.capacity::text as cap
           from schedule_daily_capacity c
           join departments d on d.id = c.department_id
           join components cmp on cmp.id = c.component_id
          where c.run_id = $1 and d.code = 'STITCH' and cmp.code = 'COVER'
            and c.load_date = $2::date`,
        [run, DAY],
      )
      expect(rows.length).toBe(1)
      expect(Number(rows[0].cap)).toBe(33.188)
      expect(Number(rows[0].cap)).toBe(await capacity(c))
    })
  })

  it('changes nothing where no overtime was entered', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await crewOf12(c)
      await c.query(`select set_attendance('STITCH', 'GEN', $1, 12)`, [DAY])
      expect(await capacity(c)).toBe(30)
      expect(await capacity(c, '2026-10-15')).toBe(30)
    })
  })
})
