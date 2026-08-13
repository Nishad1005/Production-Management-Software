// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * "Day rate is variable, can we give an option to put it in by the end user."
 *
 * Three things vary, and U&M named all three: the article (already editable),
 * the day (a typed override), and how many people turned up. The last is what
 * scales the standing rate, and the order the three resolve in is the part
 * worth pinning down — a figure someone looked at the day and typed has to beat
 * one worked out from a headcount.
 */

const capacity = async (
  c: pg.Client,
  department: string,
  component: string,
  date: string,
) =>
  Number(
    (
      await c.query<{ units: string }>(
        `select resolve_capacity(
             (select id from departments where code = $1),
             (select id from shifts where code = 'GEN'),
             (select id from components where code = $2),
             $3::date
           )::text as units`,
        [department, component, date],
      )
    ).rows[0].units,
  )

const DAY = '2026-11-04'

describe('capacity follows who turned up', () => {
  it('leaves the standing rate alone when nobody has said', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(30)
    })
  })

  it('scales in proportion to the crew the rate was measured with', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Stitching makes 30 covers a day with 12 people. Six came in.
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(15)
    })
  })

  it('applies only to the day it was entered for', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      expect(await capacity(c, 'STITCH', 'COVER', '2026-11-05')).toBe(30)
    })
  })

  it('takes nobody in as nobody in, not as no entry', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 0)`, [DAY])
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(0)
    })
  })

  it('leaves a rate with no crew size against it alone', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // The seed enters rates without manpower. There is no ratio to apply —
      // we do not know what the rate was measured with — and assuming the
      // sanctioned headcount would move every number on screen silently.
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(30)
    })
  })

  it('clears back to the standing rate, which is not the same as zero', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 0)`, [DAY])
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(0)

      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, null)`, [
        DAY,
      ])
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(30)
    })
  })

  it('corrects rather than fails when entered twice', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 9)`, [DAY])
      const { rows } = await c.query<{ n: string; present: number }>(
        `select count(*) as n, max(present) as present from department_attendance`,
      )
      expect(Number(rows[0].n)).toBe(1)
      expect(rows[0].present).toBe(9)
    })
  })
})

describe('a figure someone typed for the day', () => {
  it('beats the headcount calculation', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      // Six of twelve in — which would say 15 — but the supervisor looked at
      // the day and said 20. A person who saw it beats an arithmetic ratio.
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, 20, 'New operators, running slow')`,
        [DAY],
      )
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(20)
    })
  })

  it('will not be entered without a reason', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_day_capacity('STITCH', 'GEN', $1::date, 20, '  ')`, [
          DAY,
        ]),
      ).rejects.toThrow(/needs a reason/)
    })
  })

  it('corrects rather than colliding with itself', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // The table refuses overlapping overrides, so a second entry for the same
      // day has to replace the first rather than be refused as a clash.
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, 20, 'first look')`,
        [DAY],
      )
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, 24, 'recount')`,
        [DAY],
      )
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(24)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from capacity_overrides`,
      )
      expect(Number(rows[0].n)).toBe(1)
    })
  })

  it('clears back to the headcount calculation', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, 20, 'slow start')`,
        [DAY],
      )
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, null, null)`,
        [DAY],
      )
      expect(await capacity(c, 'STITCH', 'COVER', DAY)).toBe(15)
    })
  })
})

describe('what it does to the plan', () => {
  it('moves the schedule, because capacity is what the engine reads', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `update component_rates set manpower = 12
          where department_id = (select id from departments where code = 'STITCH')`,
      )
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const before = await runSchedule(c)
      const { rows: full } = await c.query<{ capacity: string }>(
        `select capacity::text from schedule_daily_capacity dc
           join departments d on d.id = dc.department_id
          where dc.run_id = $1 and d.code = 'STITCH'
          order by dc.load_date limit 1`,
        [before],
      )

      // Half the line out for one day.
      await c.query(
        `select set_attendance('STITCH', 'GEN', $1::date, 6)`,
        [
          (
            await c.query<{ d: string }>(
              `select load_date::text as d from schedule_daily_capacity dc
                 join departments d on d.id = dc.department_id
                where dc.run_id = $1 and d.code = 'STITCH'
                order by dc.load_date limit 1`,
              [before],
            )
          ).rows[0].d,
        ],
      )

      const after = await runSchedule(c)
      const { rows: reduced } = await c.query<{ capacity: string }>(
        `select capacity::text from schedule_daily_capacity dc
           join departments d on d.id = dc.department_id
          where dc.run_id = $1 and d.code = 'STITCH'
          order by dc.load_date limit 1`,
        [after],
      )

      expect(Number(reduced[0].capacity)).toBeLessThan(Number(full[0].capacity))
    })
  })

  it('shows the day on department_day, including who has said nothing', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 6)`, [DAY])

      const { rows } = await c.query<{
        department_code: string
        sanctioned: number
        present: number | null
        attendance_fraction: number | null
      }>(
        `select department_code, sanctioned, present, attendance_fraction
           from department_day where department_code in ('STITCH', 'WOOD')
          order by department_code`,
      )

      const stitch = rows.find((r) => r.department_code === 'STITCH')!
      expect(stitch.present).toBe(6)
      expect(stitch.sanctioned).toBe(12)
      expect(stitch.attendance_fraction).toBeCloseTo(0.5, 4)

      // Wood said nothing, and still appears — an inner join would hide
      // exactly the department someone needs to chase.
      const wood = rows.find((r) => r.department_code === 'WOOD')!
      expect(wood.present).toBeNull()
      expect(wood.attendance_fraction).toBeNull()
    })
  })
})
