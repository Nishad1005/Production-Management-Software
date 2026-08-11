// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

async function whatIf(
  c: pg.Client,
  opts: {
    note: string
    department?: string
    from?: string
    to?: string
    factor?: number
  },
) {
  const { rows } = await c.query<{ id: string }>(
    `select run_what_if($1,
       array['confirmed','probable']::order_confidence[],
       $2, $3::date, $4::date, $5::numeric) as id`,
    [
      opts.note,
      opts.department ?? null,
      opts.from ?? null,
      opts.to ?? null,
      opts.factor ?? null,
    ],
  )
  return rows[0].id
}

const breachCount = async (c: pg.Client, run: string) =>
  c
    .query<{ n: string }>(
      `select count(*) as n from schedule_tasks
        where run_id = $1 and not is_feasible`,
      [run],
    )
    .then((r) => Number(r.rows[0].n))

describe('what-if scenarios', () => {
  it('shuts a department down and makes the plan worse', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const base = await runSchedule(c)

      const scenario = await whatIf(c, {
        note: 'Stitching down for a fortnight',
        department: 'STITCH',
        from: '2026-09-28',
        to: '2026-10-11',
        factor: 0,
      })

      expect(await breachCount(c, scenario)).toBeGreaterThan(
        await breachCount(c, base),
      )
    })
  })

  it('adds capacity and resolves breaches', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Enough to overload stitching, which runs 30 covers a day.
      await createOrder(c, { qty: 600, stuffingDate: '2026-12-01' })
      const base = await runSchedule(c)
      expect(await breachCount(c, base)).toBeGreaterThan(0)

      const scenario = await whatIf(c, {
        note: 'Second shift on stitching',
        department: 'STITCH',
        from: '2026-01-01',
        to: '2027-06-30',
        factor: 3,
      })

      expect(await breachCount(c, scenario)).toBeLessThan(
        await breachCount(c, base),
      )
    })
  })

  it('leaves no temporary capacity overrides behind', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })

      const before = await c.query<{ n: string }>(
        `select count(*) as n from capacity_overrides`,
      )
      await whatIf(c, {
        note: 'Wood at half rate',
        department: 'WOOD',
        from: '2026-09-01',
        to: '2026-10-31',
        factor: 0.5,
      })
      const after = await c.query<{ n: string }>(
        `select count(*) as n from capacity_overrides`,
      )

      // A scenario that left one behind would look like a capacity change
      // nobody remembers making.
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })
  })

  it('does not disturb the live plan', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const base = await runSchedule(c)

      await whatIf(c, {
        note: 'Stitching down',
        department: 'STITCH',
        from: '2026-09-28',
        to: '2026-10-11',
        factor: 0,
      })

      const { rows } = await c.query<{ id: string }>(
        `select id from schedule_runs where is_current`,
      )
      expect(rows.map((r) => r.id)).toEqual([base])
    })
  })

  it('records how much of the scenario actually applied', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })

      // A real override already occupying part of the window must win.
      await c.query(
        `insert into capacity_overrides
           (department_id, shift_id, component_id, from_date, to_date, units_per_day, reason)
         values ((select id from departments where code = 'WOOD'),
                 (select id from shifts where code = 'GEN'),
                 (select id from components where code = 'LEG'),
                 '2026-09-10', '2026-09-12', 0, 'Booked maintenance')`,
      )

      const scenario = await whatIf(c, {
        note: 'Wood overtime',
        department: 'WOOD',
        from: '2026-09-01',
        to: '2026-09-30',
        factor: 1.2,
      })

      const { rows } = await c.query<{ applied: number; intended: number }>(
        `select (params -> 'what_if' ->> 'applied')::int as applied,
                (params -> 'what_if' ->> 'intended')::int as intended
           from schedule_runs where id = $1`,
        [scenario],
      )
      // Wood works three components; the leg override blocks one of them.
      expect(rows[0].intended).toBe(3)
      expect(rows[0].applied).toBe(2)

      // And the booked maintenance is untouched.
      const { rows: kept } = await c.query<{ n: string }>(
        `select count(*) as n from capacity_overrides where reason = 'Booked maintenance'`,
      )
      expect(Number(kept[0].n)).toBe(1)
    })
  })

  it('insists on a label', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(whatIf(c, { note: '   ' })).rejects.toThrow(/needs a label/)
    })
  })
})

describe('comparing runs', () => {
  it('reports the utilisation change per department', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const base = await runSchedule(c)
      const scenario = await whatIf(c, {
        note: 'Stitching halved',
        department: 'STITCH',
        from: '2026-09-01',
        to: '2026-10-31',
        factor: 0.5,
      })

      const { rows } = await c.query<{
        department_code: string
        utilisation_delta: string
        base_breaches: number
        scenario_breaches: number
      }>(
        `select department_code, utilisation_delta::text,
                base_breaches, scenario_breaches
           from compare_schedule_runs($1, $2)`,
        [base, scenario],
      )

      expect(rows.length).toBe(4)
      const stitching = rows.find((r) => r.department_code === 'STITCH')!
      // Half the capacity for the same work: a higher share of each day.
      expect(Number(stitching.utilisation_delta)).toBeGreaterThan(0)
    })
  })

  it('lists only the tasks that changed', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const base = await runSchedule(c)
      const scenario = await whatIf(c, {
        note: 'Stitching down',
        department: 'STITCH',
        from: '2026-09-28',
        to: '2026-10-11',
        factor: 0,
      })

      const { rows } = await c.query<{
        change: string
        department_code: string
      }>(`select change, department_code from compare_run_tasks($1, $2)`, [
        base,
        scenario,
      ])

      expect(rows.length).toBeGreaterThan(0)
      // Only stitching's capacity moved, so only stitching's tasks should.
      expect([...new Set(rows.map((r) => r.department_code))]).toEqual([
        'STITCH',
      ])
      expect(rows.every((r) => ['moved', 'new_breach'].includes(r.change))).toBe(
        true,
      )
    })
  })

  it('finds nothing to report between a run and itself', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const run = await runSchedule(c)

      const { rows } = await c.query(
        `select * from compare_run_tasks($1, $1)`,
        [run],
      )
      expect(rows).toEqual([])
    })
  })
})

describe('promoting a run', () => {
  it('swaps which run is current, keeping exactly one', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const base = await runSchedule(c)
      const scenario = await whatIf(c, {
        note: 'Second shift on stitching',
        department: 'STITCH',
        from: '2026-09-01',
        to: '2026-12-31',
        factor: 2,
      })

      await c.query(`select promote_schedule_run($1)`, [scenario])

      const { rows } = await c.query<{ id: string }>(
        `select id from schedule_runs where is_current`,
      )
      expect(rows.map((r) => r.id)).toEqual([scenario])

      // The run it replaced is kept, as every run is.
      const { rows: old } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_tasks where run_id = $1`,
        [base],
      )
      expect(Number(old[0].n)).toBeGreaterThan(0)
    })
  })
})
