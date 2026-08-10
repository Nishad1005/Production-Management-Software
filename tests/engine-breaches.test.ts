// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'
import type pg from 'pg'

async function tasks(c: pg.Client, run: string) {
  const { rows } = await c.query<{
    dept: string
    component: string
    start_date: string | null
    end_date: string | null
    due_date: string | null
    is_feasible: boolean
    breach_reason: string | null
    is_pinned: boolean
  }>(
    `select d.code as dept, cmp.code as component,
            t.start_date::text, t.end_date::text, t.due_date::text,
            t.is_feasible, t.breach_reason, t.is_pinned
       from schedule_tasks t
       join departments d on d.id = t.department_id
       join components cmp on cmp.id = t.component_id
      where t.run_id = $1
      order by d.route_position, cmp.code`,
    [run],
  )
  return rows
}

describe('feasibility checks', () => {
  it('flags a window opening before material is available', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, {
        qty: 100,
        stuffingDate: '2026-12-01',
        // Wood is due D-60, around 2 October. Material a month later than that
        // is arithmetically fine and physically impossible.
        materialReadyDate: '2026-11-01',
      })
      const run = await runSchedule(c)

      const wood = (await tasks(c, run)).filter((t) => t.dept === 'WOOD')
      expect(wood.length).toBeGreaterThan(0)
      for (const t of wood) {
        expect(t.breach_reason).toBe('material')
        expect(t.is_feasible).toBe(false)
      }
    })
  })

  it('flags runway when a department cannot start early enough', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Stitching runs 30 covers a day and has ten calendar days of runway
      // between its own deadline and fabric cutting's. 600 chairs needs about
      // twenty days, so it has to start before the fabric exists — which is the
      // one breach overtime cannot fix.
      await createOrder(c, { qty: 600, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const all = await tasks(c, run)
      const stitching = all.find((t) => t.dept === 'STITCH')
      expect(stitching?.breach_reason).toBe('runway')

      // Wood is first in the route, so it has no upstream to be blocked by —
      // whatever else is wrong, it is not a runway breach.
      expect(all.find((t) => t.dept === 'WOOD')?.breach_reason).not.toBe(
        'runway',
      )
    })
  })

  it('flags an article whose D-minus has never been entered', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // A new article auto-seeds blank, incomplete D-minus rows by trigger.
      await c.query(
        `insert into articles (code, name) values ('ART-NEW', 'Untimed Article')`,
      )
      await c.query(
        `insert into article_bom (article_id, component_id, qty_per_unit)
         values ((select id from articles where code = 'ART-NEW'),
                 (select id from components where code = 'LEG'), 4)`,
      )
      await createOrder(c, {
        erpOrderNo: 'SO-NEW',
        articleCode: 'ART-NEW',
        qty: 50,
        stuffingDate: '2026-12-01',
      })
      const run = await runSchedule(c)

      const rows = await tasks(c, run)
      expect(rows).toHaveLength(1)
      expect(rows[0].breach_reason).toBe('dminus_incomplete')
      expect(rows[0].due_date).toBeNull()
      expect(rows[0].start_date).toBeNull()
    })
  })

  it('is clean when nothing is wrong', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const rows = await tasks(c, run)
      expect(rows.map((r) => r.breach_reason)).toEqual(rows.map(() => null))
      expect(rows.every((r) => r.is_feasible)).toBe(true)
    })
  })
})

describe('capacity overrides', () => {
  it('push work earlier when a department goes down', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const before = await runSchedule(c)
      const stitchBefore = (await tasks(c, before)).find(
        (t) => t.component === 'COVER',
      )!

      // Spec §8: a breakdown writes a capacity override for its duration, so
      // downtime flows into the schedule rather than sitting on a dashboard.
      await c.query(
        `insert into capacity_overrides
           (department_id, shift_id, from_date, to_date, units_per_day, reason)
         values ((select id from departments where code = 'STITCH'),
                 (select id from shifts where code = 'GEN'),
                 $1::date - 3, $1::date, 0, 'Machine down')`,
        [stitchBefore.due_date],
      )

      const after = await runSchedule(c)
      const stitchAfter = (await tasks(c, after)).find(
        (t) => t.component === 'COVER',
      )!

      // Same deadline, same quantity, but four fewer usable days: the work has
      // to begin earlier.
      expect(stitchAfter.due_date).toBe(stitchBefore.due_date)
      expect(stitchAfter.start_date! < stitchBefore.start_date!).toBe(true)

      // And nothing is planned on the days it was down.
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n
           from schedule_daily_load l
           join components cmp on cmp.id = l.component_id
          where l.run_id = $1 and cmp.code = 'COVER'
            and l.load_date between $2::date - 3 and $2::date`,
        [after, stitchBefore.due_date],
      )
      expect(Number(rows[0].n)).toBe(0)
    })
  })
})

describe('manual pins', () => {
  async function pinCover(c: pg.Client, run: string, workingDaysBack: number) {
    const cover = (await tasks(c, run)).find((t) => t.component === 'COVER')!
    const { rows } = await c.query<{ d: string }>(
      `select subtract_working_days($1::date, $2)::text as d`,
      [cover.due_date, workingDaysBack],
    )
    await c.query(
      `insert into schedule_pins
         (shipment_line_id, department_id, component_id, pinned_start_date, reason)
       values ((select id from shipment_lines limit 1),
               (select id from departments where code = 'STITCH'),
               (select id from components where code = 'COVER'),
               $1, 'Customer asked us to start early')`,
      [rows[0].d],
    )
    return rows[0].d
  }

  it('are honoured, and survive later runs', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const first = await runSchedule(c)
      // Four working days back: enough runway for four days of work, and still
      // later than fabric cutting's own deadline. Pinning much earlier than
      // this legitimately trips the runway check instead.
      const pinnedDate = await pinCover(c, first, 4)

      // Spec §6: every subsequent run honours active pins.
      for (const _ of [1, 2]) {
        const run = await runSchedule(c)
        const cover = (await tasks(c, run)).find((t) => t.component === 'COVER')!
        expect(cover.is_pinned).toBe(true)
        expect(cover.start_date).toBe(pinnedDate)
        expect(cover.is_feasible).toBe(true)
      }
    })
  })

  it('are reported, not corrected, when they push past the due date', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const first = await runSchedule(c)
      // Starting on the due date itself leaves one day for four days of work.
      const pinnedDate = await pinCover(c, first, 0)

      const run = await runSchedule(c)
      const cover = (await tasks(c, run)).find((t) => t.component === 'COVER')!

      expect(cover.is_pinned).toBe(true)
      expect(cover.start_date).toBe(pinnedDate)
      expect(cover.breach_reason).toBe('pin')
      expect(cover.is_feasible).toBe(false)
      // Reported, not quietly undone: the work still runs past the deadline.
      expect(cover.end_date! > cover.due_date!).toBe(true)
    })
  })

  it('still plan the full quantity when pinned', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const first = await runSchedule(c)
      await pinCover(c, first, 4)
      const run = await runSchedule(c)

      const { rows } = await c.query<{ diff: string }>(
        `select (t.qty_required - coalesce(sum(l.qty_planned), 0))::text as diff
           from schedule_tasks t
           join components cmp on cmp.id = t.component_id
           left join schedule_daily_load l
             on l.run_id = t.run_id
            and l.shipment_line_id = t.shipment_line_id
            and l.department_id = t.department_id
            and l.component_id = t.component_id
          where t.run_id = $1 and cmp.code = 'COVER'
          group by t.qty_required`,
        [run],
      )
      expect(Math.abs(Number(rows[0].diff))).toBeLessThan(0.01)
    })
  })
})

describe('run versioning', () => {
  it('keeps a what-if run out of the current plan', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const live = await runSchedule(c, { makeCurrent: true })
      const whatIf = await runSchedule(c, {
        makeCurrent: false,
        note: 'What if we add 200 more?',
      })

      const { rows } = await c.query<{ id: string }>(
        `select id from schedule_runs where is_current`,
      )
      expect(rows.map((r) => r.id)).toEqual([live])
      expect(whatIf).not.toBe(live)

      // The old plan is still fully readable — that is the point of versioning.
      const { rows: old } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_tasks where run_id = $1`,
        [live],
      )
      expect(Number(old[0].n)).toBe(6)
    })
  })
})
