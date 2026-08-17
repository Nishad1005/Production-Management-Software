// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

/**
 * Phase 4, the per-person half. The department-level arithmetic is proved
 * against the client's own prototype in engine-parity.test.ts; what needs
 * guarding here is that marking individuals keeps the one number capacity
 * actually reads — department_attendance.present — honest.
 */

const DAY = '2026-11-04'

async function crew(c: pg.Client) {
  await applySeed(c)
  for (const [code, name, skill] of [
    ['E-1', 'Ramesh', 'skilled'],
    ['E-2', 'Sunil', 'semi_skilled'],
    ['E-3', 'Anjali', 'skilled'],
  ] as const) {
    await c.query(`select set_employee($1, $2, 'STITCH', 'GEN', $3::skill_level)`, [
      code,
      name,
      skill,
    ])
  }
}

const present = async (c: pg.Client) =>
  (
    await c.query<{ present: number | null }>(
      `select present from department_day
        where department_code = 'STITCH' and shift_code = 'GEN'`,
    )
  ).rows[0]?.present ?? null

describe('the employee master', () => {
  it('takes people and lists them by department', async () => {
    await withRollback(async (c) => {
      await crew(c)
      const { rows } = await c.query<{ emp_code: string; skill_level: string }>(
        `select emp_code, skill_level from employee_list
          where department_code = 'STITCH' order by emp_code`,
      )
      expect(rows.map((r) => r.emp_code)).toEqual(['E-1', 'E-2', 'E-3'])
      expect(rows[0].skill_level).toBe('skilled')
    })
  })

  it('deactivates rather than deletes', async () => {
    await withRollback(async (c) => {
      await crew(c)
      await c.query(`select set_employee_active('E-2', false)`)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from employee_list where is_active`,
      )
      expect(Number(rows[0].n)).toBe(2)
      // Still there, history intact.
      const { rows: all } = await c.query<{ n: string }>(
        `select count(*) as n from employees`,
      )
      expect(Number(all[0].n)).toBe(3)
    })
  })
})

describe('marking individuals drives the department count', () => {
  it('derives the head count capacity reads', async () => {
    await withRollback(async (c) => {
      await crew(c)
      expect(await present(c)).toBeNull()

      await c.query(`select set_employee_attendance('E-1', $1::date, 'present')`, [DAY])
      await c.query(`select set_employee_attendance('E-2', $1::date, 'absent')`, [DAY])
      await c.query(`select set_employee_attendance('E-3', $1::date, 'present')`, [DAY])

      // Two in, and the number resolve_capacity reads says two — not three,
      // and not a second opinion sitting beside it.
      expect(await present(c)).toBe(2)
    })
  })

  it('counts leave as not in', async () => {
    await withRollback(async (c) => {
      await crew(c)
      await c.query(`select set_employee_attendance('E-1', $1::date, 'present')`, [DAY])
      await c.query(`select set_employee_attendance('E-2', $1::date, 'leave')`, [DAY])
      expect(await present(c)).toBe(1)
    })
  })

  it('follows a correction back down', async () => {
    await withRollback(async (c) => {
      await crew(c)
      for (const e of ['E-1', 'E-2', 'E-3']) {
        await c.query(`select set_employee_attendance($1, $2::date, 'present')`, [e, DAY])
      }
      expect(await present(c)).toBe(3)

      await c.query(`select set_employee_attendance('E-3', $1::date, 'absent')`, [DAY])
      expect(await present(c)).toBe(2)
    })
  })

  it('moves capacity, because the head count is what capacity reads', async () => {
    await withRollback(async (c) => {
      await crew(c)
      // Stitching makes 30 covers a day with a crew of 3.
      await c.query(
        `update component_rates set manpower = 3
          where department_id = (select id from departments where code = 'STITCH')`,
      )

      const capacity = async () =>
        Number(
          (
            await c.query<{ units: string }>(
              `select resolve_capacity(
                 (select id from departments where code = 'STITCH'),
                 (select id from shifts where code = 'GEN'),
                 (select id from components where code = 'COVER'),
                 $1::date)::text as units`,
              [DAY],
            )
          ).rows[0].units,
        )

      expect(await capacity()).toBe(30)

      await c.query(`select set_employee_attendance('E-1', $1::date, 'present')`, [DAY])
      await c.query(`select set_employee_attendance('E-2', $1::date, 'present')`, [DAY])
      await c.query(`select set_employee_attendance('E-3', $1::date, 'absent')`, [DAY])

      // Two of three in: two thirds of thirty.
      expect(await capacity()).toBe(20)
    })
  })

  it('refuses somebody with nowhere to be counted', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_employee('E-9', 'Nowhere', null, null)`)
      await expect(
        c.query(`select set_employee_attendance('E-9', $1::date, 'present')`, [DAY]),
      ).rejects.toThrow(/no department or shift/)
    })
  })
})

describe('overtime worked', () => {
  it('is recorded per person and stays beside the day', async () => {
    await withRollback(async (c) => {
      await crew(c)
      await c.query(
        `select set_employee_attendance('E-1', $1::date, 'present', 2.5, 'finishing the Harper run')`,
        [DAY],
      )
      const { rows } = await c.query<{ ot_hours: number; note: string; status: string }>(
        `select ot_hours, note, status from employee_day
          where emp_code = 'E-1' and attendance_date = $1`,
        [DAY],
      )
      expect(rows[0].ot_hours).toBe(2.5)
      expect(rows[0].status).toBe('present')
      expect(rows[0].note).toMatch(/Harper/)
    })
  })

  it('shows somebody nobody has marked, rather than hiding them', async () => {
    await withRollback(async (c) => {
      await crew(c)
      await c.query(`select set_employee_attendance('E-1', $1::date, 'present')`, [DAY])

      // An unrecorded person is the one a supervisor needs to chase; an inner
      // join would drop exactly them.
      const { rows } = await c.query<{ emp_code: string; status: string }>(
        `select emp_code, status from employee_day
          where department_code = 'STITCH'
            and (attendance_date = $1 or attendance_date is null)
          order by emp_code`,
        [DAY],
      )
      expect(rows.map((r) => r.status)).toEqual([
        'present',
        'unrecorded',
        'unrecorded',
      ])
    })
  })
})
