// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The engine's capacity grid against `resolve_capacity`, cell for cell.
 *
 * `resolve_capacity` is the function every date in the system rests on: an
 * override typed for the day, else one typed for the department, else the
 * standing rate scaled by who came in and which machines are running. The
 * engine used to call it once per grid cell — a million calls at U&M's scale,
 * each its own statement under row-level security — and the rewrite builds the
 * same grid as one statement instead. The function stays, untouched, as the
 * referee; this file is what makes it one.
 *
 * Written against the per-cell engine first and watched pass, so it was a real
 * oracle before anything changed. The fixture puts every branch of the function
 * on the board at least once, and the last test checks the specific cells, so
 * the two comparisons cannot pass vacuously on a grid where only the standing
 * rate ever applied.
 */

const STITCH_GEN_COVER = ['STITCH', 'GEN', 'COVER'] as const

async function everyBranch(c: pg.Client): Promise<string> {
  await applySeed(c)
  // A thousand chairs due 1 Dec: covers at thirty a day run from early
  // September, assembly at fifty a day from mid October, so the written window
  // spans every date below with room to spare.
  await createOrder(c, { qty: 1000, stuffingDate: '2026-12-01' })

  // Attendance scales the rate only where the rate carries its crew.
  await c.query(
    `update component_rates set manpower = 12
      where department_id = (select id from departments where code = 'STITCH')`,
  )
  await c.query(`select set_attendance('STITCH', 'GEN', '2026-10-14', 6)`) // 30 × 6/12
  await c.query(`select set_attendance('WOOD', 'GEN', '2026-10-01', 3)`) // manpower null: untouched

  // Four machines in Stitching, one of them down for two days; Assembly has
  // none recorded, which must read as "nobody has said", not as zero.
  for (let i = 1; i <= 4; i++) {
    await c.query(`select set_machine($1, $2, 'STITCH', 'Juki DDL-8700')`, [
      `STITCH-${i}`,
      `Lockstitch ${i}`,
    ])
  }
  await c.query(
    `select set_machine_downtime('STITCH-1', '2026-10-15', '2026-10-16', 'Timing belt')`,
  ) // 30 × 3/4 on the 15th; × 6/12 × 3/4 on the 16th
  await c.query(`select set_attendance('STITCH', 'GEN', '2026-10-16', 6)`)

  // Overrides: one for the component beside one for the whole department on
  // the same day (the component wins), a zero (the day leaves the grid), one
  // on a department with no machines, and one on a shift that has no rate at
  // all — where the function answers with the override and nothing else.
  await c.query(
    `insert into capacity_overrides
       (department_id, shift_id, component_id, from_date, to_date, units_per_day, reason)
     values ((select id from departments where code = 'STITCH'),
             (select id from shifts where code = 'GEN'),
             (select id from components where code = 'COVER'),
             '2026-10-13', '2026-10-13', 12, 'Sample run')`,
  )
  await c.query(`select set_day_capacity('STITCH', 'GEN', '2026-10-13', 18, 'Short day')`)
  await c.query(`select set_day_capacity('STITCH', 'GEN', '2026-10-08', 0, 'Shut')`)
  await c.query(`select set_day_capacity('ASSY', 'GEN', '2026-10-28', 20, 'Power cut')`)
  await c.query(`update shifts set is_active = true where code = 'A'`)
  await c.query(`select set_headcount('WOOD', 'A', 5)`)
  await c.query(`select set_day_capacity('WOOD', 'A', '2026-09-30', 100, 'Extra shift')`)

  return runSchedule(c)
}

/** One written cell's capacity as text, or null when the grid has no row. */
async function cell(
  c: pg.Client,
  runId: string,
  [department, shift, component]: readonly [string, string, string],
  date: string,
): Promise<string | null> {
  const { rows } = await c.query<{ capacity: string }>(
    `select capacity::text as capacity
       from schedule_daily_capacity
      where run_id = $1
        and department_id = (select id from departments where code = $2)
        and shift_id = (select id from shifts where code = $3)
        and component_id = (select id from components where code = $4)
        and load_date = $5::date`,
    [runId, department, shift, component, date],
  )
  return rows[0]?.capacity ?? null
}

describe('the capacity grid is resolve_capacity, cell for cell', () => {
  it('writes every cell with the value the function gives', async () => {
    await withRollback(async (c) => {
      const run = await everyBranch(c)
      const { rows } = await c.query<{ total: string; mismatched: string }>(
        `select count(*)::text as total,
                count(*) filter (
                  where c.capacity <> public.resolve_capacity(
                    c.department_id, c.shift_id, c.component_id, c.load_date)
                )::text as mismatched
           from schedule_daily_capacity c
          where c.run_id = $1`,
        [run],
      )
      expect(Number(rows[0].total)).toBeGreaterThan(0)
      expect(Number(rows[0].mismatched)).toBe(0)
    })
  })

  it('writes exactly the cells the function would give a figure to', async () => {
    // The engine's own grid: the pairings the plan touches, every active shift
    // the department works, every working day of the run's window. Where the
    // function says more than zero there must be a row, and nowhere else —
    // both directions, because a missing day and an invented day are
    // different mistakes and either one moves a schedule.
    await withRollback(async (c) => {
      const run = await everyBranch(c)
      const { rows } = await c.query<{ missing: string; extra: string }>(
        `with r as (
           select horizon_from, horizon_to from schedule_runs where id = $1
         ),
         grid as (
           select distinct t.department_id, ds.shift_id, t.component_id, w.calendar_date
             from schedule_tasks t
             join department_shifts ds
               on ds.department_id = t.department_id and ds.is_active
             join shifts s on s.id = ds.shift_id and s.is_active
             cross join r
             join working_days w
               on w.is_working
              and w.calendar_date between r.horizon_from and r.horizon_to
            where t.run_id = $1
         ),
         expected as (
           select department_id, shift_id, component_id, calendar_date
             from grid
            where public.resolve_capacity(department_id, shift_id, component_id, calendar_date) > 0
         ),
         written as (
           select department_id, shift_id, component_id, load_date
             from schedule_daily_capacity
            where run_id = $1
         )
         select (select count(*) from (select * from expected except select * from written) x)::text
                  as missing,
                (select count(*) from (select * from written except select * from expected) x)::text
                  as extra`,
        [run],
      )
      expect(rows[0]).toEqual({ missing: '0', extra: '0' })
    })
  })

  it('put every branch of the function on the board', async () => {
    // Without this the two comparisons above would pass on a grid where only
    // the standing rate ever applied, which is most of the function untested.
    await withRollback(async (c) => {
      const run = await everyBranch(c)

      const { rows: horizon } = await c.query<{ from: string; to: string }>(
        `select horizon_from::text as "from", horizon_to::text as "to"
           from schedule_runs where id = $1`,
        [run],
      )
      // A fixture problem should report as one, not as a parity failure.
      expect(horizon[0].from <= '2026-09-30').toBe(true)
      expect(horizon[0].to >= '2026-10-28').toBe(true)

      const stitch = (date: string) => cell(c, run, STITCH_GEN_COVER, date)
      expect(Number(await stitch('2026-10-12'))).toBe(30) // the standing rate
      expect(Number(await stitch('2026-10-13'))).toBe(12) // component override beats the department's 18
      expect(Number(await stitch('2026-10-14'))).toBe(15) // six of a crew of twelve
      expect(Number(await stitch('2026-10-15'))).toBe(22.5) // three of four machines
      expect(Number(await stitch('2026-10-16'))).toBe(11.25) // both at once: they multiply
      expect(await stitch('2026-10-08')).toBeNull() // a zero override leaves the grid

      expect(Number(await cell(c, run, ['ASSY', 'GEN', 'CHAIR'], '2026-10-28'))).toBe(20)
      expect(Number(await cell(c, run, ['ASSY', 'GEN', 'CHAIR'], '2026-10-27'))).toBe(50)

      // Shift A has no rate for anything in Wood: an override gives it a day,
      // and the day after has nothing.
      expect(Number(await cell(c, run, ['WOOD', 'A', 'LEG'], '2026-09-30'))).toBe(100)
      expect(Number(await cell(c, run, ['WOOD', 'A', 'SEAT-FRAME'], '2026-09-30'))).toBe(100)
      expect(await cell(c, run, ['WOOD', 'A', 'LEG'], '2026-10-01')).toBeNull()
      // The General shift's rate has no crew against it, so attendance leaves it alone.
      expect(Number(await cell(c, run, ['WOOD', 'GEN', 'LEG'], '2026-10-01'))).toBe(480)
    })
  })
})
