// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { attempt, withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The plan learns from the floor.
 *
 * Three things a run does since 12 Oct 2026, each proved here on the
 * four-department seed: it subtracts what a department has declared good
 * from each job and places only what remains; told what day it is, it moves
 * work that is behind to start today and calls it late when it still misses
 * its date; and it keeps the days before today exactly as the previous run
 * planned them, so "planned against made" is a record and not a moving
 * target. Every fixture without declarations and without a day is untouched
 * — tests/engine-parity and the bench's dumps say so.
 *
 * Stitching makes COVER at 30 a day; a hundred chairs need 103.07 covers once
 * the losses downstream are allowed for (tests/engine.test.ts has the
 * baseline: four days, the remainder on the earliest).
 */

const COVER_FOR_100 = 100 / (0.98 * 0.99)

async function declare(
  c: pg.Client,
  line: string,
  date: string,
  good: number,
  rejected = 0,
) {
  await c.query(
    `select declare_production($1, 'STITCH', 'COVER', $2::date, 'GEN', $3, $4)`,
    [line, date, good, rejected],
  )
}

type Cover = {
  qty_required: number
  qty_done: number | null
  qty_remaining: number | null
  start_date: string | null
  end_date: string | null
  days_needed: number | null
  is_feasible: boolean
  breach_reason: string | null
  is_pinned: boolean
  load: number
  load_days: number
}

/** The COVER task of one line on one run, with its load summed. */
async function cover(c: pg.Client, run: string, line: string): Promise<Cover> {
  const { rows } = await c.query<Cover>(
    `select t.qty_required::float8 as qty_required,
            t.qty_done::float8 as qty_done,
            t.qty_remaining::float8 as qty_remaining,
            t.start_date::text as start_date,
            t.end_date::text as end_date,
            t.days_needed,
            t.is_feasible,
            t.breach_reason::text as breach_reason,
            t.is_pinned,
            coalesce(sum(l.qty_planned), 0)::float8 as load,
            count(distinct l.load_date)::int as load_days
       from schedule_tasks t
       join components cmp on cmp.id = t.component_id
       left join schedule_daily_load l
         on l.run_id = t.run_id
        and l.shipment_line_id = t.shipment_line_id
        and l.department_id = t.department_id
        and l.component_id = t.component_id
      where t.run_id = $1 and t.shipment_line_id = $2 and cmp.code = 'COVER'
      group by t.id`,
    [run, line],
  )
  return rows[0]
}

/** A run's load rows by natural key, optionally before or from a date. */
async function loads(c: pg.Client, run: string, where: 'all' | ['before' | 'from', string] = 'all') {
  const clause =
    where === 'all' ? '' : where[0] === 'before' ? 'and l.load_date < $2::date' : 'and l.load_date >= $2::date'
  const params = where === 'all' ? [run] : [run, where[1]]
  const { rows } = await c.query(
    `select d.code as dept, cmp.code as comp, s.code as shift,
            l.load_date::text as day, l.qty_planned::text as qty
       from schedule_daily_load l
       join departments d on d.id = l.department_id
       join components cmp on cmp.id = l.component_id
       join shifts s on s.id = l.shift_id
      where l.run_id = $1 ${clause}
      order by 1, 2, 3, 4`,
    params,
  )
  return rows
}

async function capacities(c: pg.Client, run: string, before: string) {
  const { rows } = await c.query(
    `select d.code as dept, cmp.code as comp, s.code as shift,
            g.load_date::text as day, g.capacity::text as capacity
       from schedule_daily_capacity g
       join departments d on d.id = g.department_id
       join components cmp on cmp.id = g.component_id
       join shifts s on s.id = g.shift_id
      where g.run_id = $1 and g.load_date < $2::date
      order by 1, 2, 3, 4`,
    [run, before],
  )
  return rows
}

describe('what has been made is netted off', () => {
  it('plans only what remains after a partial declaration', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      await declare(c, line, '2026-10-01', 40)
      const run = await runSchedule(c)
      const t = await cover(c, run, line)
      // The requirement keeps its meaning; what is placed is what is left.
      expect(t.qty_required).toBeCloseTo(COVER_FOR_100, 1)
      expect(t.qty_done).toBe(40)
      expect(t.qty_remaining).toBeCloseTo(COVER_FOR_100 - 40, 1)
      expect(t.load).toBeCloseTo(COVER_FOR_100 - 40, 1)
      expect(t.load_days).toBe(3)
      expect(t.breach_reason).toBeNull()
    })
  })

  it('retires a job that has been fully declared, and says so without a breach', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      await declare(c, line, '2026-10-01', 110)
      const run = await runSchedule(c)
      const t = await cover(c, run, line)
      expect(t.qty_remaining).toBe(0)
      expect(t.load).toBe(0)
      expect(t.load_days).toBe(0)
      expect(t.start_date).toBeNull()
      expect(t.end_date).toBeNull()
      expect(t.days_needed).toBeNull()
      expect(t.is_feasible).toBe(true)
      expect(t.breach_reason).toBeNull()

      // Still a task of the run — a job that was made is not a job that
      // vanished — and nothing to breach.
      const { rows } = await c.query<{ task_count: number; breach_count: number }>(
        `select task_count, breach_count from schedule_runs where id = $1`,
        [run],
      )
      expect(rows[0].task_count).toBe(6)
      expect(rows[0].breach_count).toBe(0)

      // And the department's own queue agrees it owes nothing on it.
      const { rows: queue } = await c.query<{ qty_remaining: number }>(
        `select qty_remaining from department_queue
          where shipment_line_id = $1 and department_code = 'STITCH' and component_code = 'COVER'`,
        [line],
      )
      expect(queue.length === 0 || queue[0].qty_remaining === 0).toBe(true)
    })
  })

  it('leaves another line alone', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const first = await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const second = await createOrder(c, {
        erpOrderNo: 'SO-2',
        qty: 100,
        stuffingDate: '2026-12-20',
      })
      await declare(c, second, '2026-10-01', 50)
      const run = await runSchedule(c)
      expect((await cover(c, run, first)).load).toBeCloseTo(COVER_FOR_100, 1)
      expect((await cover(c, run, second)).load).toBeCloseTo(COVER_FOR_100 - 50, 1)
    })
  })

  it('counts good pieces only', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      await declare(c, line, '2026-10-01', 10, 50)
      const run = await runSchedule(c)
      expect((await cover(c, run, line)).qty_done).toBe(10)
    })
  })

  it('records no day when it was not told one', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)
      const { rows } = await c.query<{ today: string | null; planned_as_of: string | null }>(
        `select r.params ->> 'today' as today, h.planned_as_of
           from schedule_runs r join run_history h on h.id = r.id where r.id = $1`,
        [run],
      )
      expect(rows[0]).toEqual({ today: null, planned_as_of: null })
    })
  })
})

describe('told what day it is', () => {
  // Stuffing on 20 Oct puts every department's due date in September; from
  // 2 November all of it is behind.
  const BEHIND = { qty: 100, stuffingDate: '2026-10-20' }
  const MONDAY = '2026-11-02'

  it('moves work that is behind to the first working day from today, and calls it late', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, BEHIND)
      const run = await runSchedule(c, { today: MONDAY })
      const t = await cover(c, run, line)
      expect(t.start_date).toBe(MONDAY)
      expect(t.is_pinned).toBe(false)
      expect(t.end_date! > '2026-09-30').toBe(true)
      expect(t.breach_reason).toBe('late')
      expect(t.is_feasible).toBe(false)
      expect(t.load).toBeCloseTo(COVER_FOR_100, 1)

      const { rows } = await c.query<{ starts: string; today: string }>(
        `select min(start_date)::text as starts, params ->> 'today' as today
           from schedule_tasks t join schedule_runs r on r.id = t.run_id
          where t.run_id = $1 group by r.params`,
        [run],
      )
      expect(rows[0]).toEqual({ starts: MONDAY, today: MONDAY })
    })
  })

  it('starts on Monday when told it is Sunday', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, BEHIND)
      const run = await runSchedule(c, { today: '2026-11-01' })
      expect((await cover(c, run, line)).start_date).toBe(MONDAY)
    })
  })

  it('leaves work that is not behind exactly where the due date puts it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 10, stuffingDate: '2027-03-01' })
      const plain = await cover(c, await runSchedule(c), line)
      const told = await cover(c, await runSchedule(c, { today: MONDAY }), line)
      expect(told.start_date).toBe(plain.start_date)
      expect(told.end_date).toBe(plain.end_date)
      expect(told.breach_reason).toBeNull()
      expect(told.start_date! > MONDAY).toBe(true)
    })
  })

  it('refuses a day outside the working-day calendar', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, BEHIND)
      const message = await attempt(
        c,
        `select run_schedule(array['confirmed','probable']::order_confidence[], true, null, '2035-01-01')`,
      )
      expect(message).toMatch(/outside the working-day calendar/)
    })
  })

  it('raises one finding for each job that is behind, and nowhere else', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, BEHIND)
      await runSchedule(c, { today: MONDAY })
      const { rows } = await c.query<{ kind: string; title: string; detail: string; route: string; key: string }>(
        `select kind, title, detail, route, key from attention_behind order by key`,
      )
      expect(rows).toHaveLength(6)
      for (const r of rows) {
        expect(r.kind).toBe('behind')
        expect(r.title).toMatch(/ is behind on /)
        expect(r.detail).toMatch(/^0 of \d+ made · /)
        expect(r.detail).not.toMatch(/\blate\b/)
        expect(r.route).toBe('/gantt')
        expect(r.key).toMatch(/^behind:/)
      }
      const { rows: breach } = await c.query<{ n: string }>(
        `select count(*) as n from attention_breach where detail like 'late%'`,
      )
      expect(Number(breach[0].n)).toBe(0)
      const { rows: union } = await c.query<{ n: string }>(
        `select count(*) as n from attention where kind = 'behind'`,
      )
      expect(Number(union[0].n)).toBe(6)
    })
  })

  it('starts what remains of a pin in the past from today', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, BEHIND)
      await c.query(
        `insert into schedule_pins
           (shipment_line_id, department_id, component_id, pinned_start_date, reason)
         values ($1, (select id from departments where code = 'STITCH'),
                 (select id from components where code = 'COVER'),
                 '2026-09-01', 'Customer asked us to start early')`,
        [line],
      )
      const run = await runSchedule(c, { today: MONDAY })
      const t = await cover(c, run, line)
      expect(t.is_pinned).toBe(true)
      expect(t.start_date).toBe(MONDAY)
      expect(t.breach_reason).toBe('pin')
      const fresh = await loads(c, run, ['from', MONDAY])
      const coverFresh = fresh.filter((r) => r.comp === 'COVER')
      expect(coverFresh.reduce((n, r) => n + Number(r.qty), 0)).toBeCloseTo(COVER_FOR_100, 1)
    })
  })
})

describe('the past is frozen', () => {
  it('keeps the days before today exactly as the previous run planned them', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 100, stuffingDate: '2026-10-20' })

      // Run 0 knows no day: everything is placed back from the due dates, in
      // August and September.
      const run0 = await runSchedule(c)
      const all0 = await loads(c, run0)
      expect(all0.length).toBeGreaterThan(0)
      expect(all0.every((r) => r.day < '2026-11-02')).toBe(true)

      // Run A is told it is 2 November: the past is run 0's, the rest from
      // today.
      const runA = await runSchedule(c, { today: '2026-11-02' })
      expect(await loads(c, runA, ['before', '2026-11-02'])).toEqual(all0)
      expect((await loads(c, runA, ['from', '2026-11-02'])).length).toBeGreaterThan(0)

      // A week on, with a faster rate: the days before 9 November are run A's,
      // frozen and fresh alike; from the 9th the plan changes.
      await c.query(`select set_component_rate('COVER', 'STITCH', 'GEN', 60)`)
      const runB = await runSchedule(c, { today: '2026-11-09' })
      expect(await loads(c, runB, ['before', '2026-11-09'])).toEqual(
        await loads(c, runA, ['before', '2026-11-09']),
      )
      expect(await capacities(c, runB, '2026-11-09')).toEqual(
        await capacities(c, runA, '2026-11-09'),
      )
      const fromB = await loads(c, runB, ['from', '2026-11-09'])
      const fromA = await loads(c, runA, ['from', '2026-11-09'])
      expect(fromB).not.toEqual(fromA)

      const { rows } = await c.query<{ horizon_from: string; today: string }>(
        `select horizon_from::text, params ->> 'today' as today from schedule_runs where id = $1`,
        [runB],
      )
      const earliest = all0.map((r) => r.day).sort()[0]
      expect(rows[0].horizon_from).toBe(earliest)
      expect(rows[0].today).toBe('2026-11-09')

      // The order leaves the book: its past leaves with it.
      await c.query(`delete from orders where id = (select order_id from shipment_lines where id = $1)`, [line])
      const runC = await runSchedule(c, { today: '2026-11-10' })
      expect(await loads(c, runC)).toEqual([])
    })
  })
})
