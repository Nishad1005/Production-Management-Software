// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applyDemoSeed, applySeed, runSchedule } from './helpers/fixtures'

/**
 * The demonstration data is what the client is shown. It is not covered by
 * anything else here — the rest of the suite runs on seed.sql, which stays the
 * four-department parity fixture — so this is the only thing standing between a
 * broken demo and finding out in front of U&M.
 *
 * Every capacity figure in it is invented. What is checked here is that it is
 * coherent, not that it is true.
 */

const demo = async (c: pg.Client) => {
  await applySeed(c)
  await applyDemoSeed(c)
}

describe('the demonstration factory', () => {
  it('shows U&M’s fourteen departments and none of the placeholders', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const { rows } = await c.query<{ code: string }>(
        `select code from department_master where is_active order by route_position`,
      )
      expect(rows.map((r) => r.code)).toEqual([
        'PLYCUT', 'MACHINE', 'ASSY', 'SAND', 'WOODFIN', 'METALFIN', 'FOAM',
        'FIBER', 'CUT', 'STITCH', 'STAPLE', 'FIT', 'QC', 'PACK',
      ])
    })
  })

  it('keeps the parked placeholders rather than deleting them', async () => {
    await withRollback(async (c) => {
      await demo(c)
      // Soft delete throughout: a department with history keeps it, and the
      // parity fixture's four are history the moment this file runs.
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from departments
          where code in ('WOOD', 'FABCUT') and not is_active`,
      )
      expect(Number(rows[0].n)).toBe(2)
    })
  })

  it('wires the structure PPC confirmed — four entry points', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const { rows } = await c.query<{ code: string }>(
        `select d.code from departments d
          where d.is_active
            and not exists (
              select 1 from department_dependencies dd
               where dd.department_id = d.id)
          order by d.route_position`,
      )
      expect(rows.map((r) => r.code)).toEqual([
        'PLYCUT', 'MACHINE', 'FIBER', 'CUT',
      ])
    })
  })

  it('routes each article only through the departments it really uses', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const { rows } = await c.query<{ article_code: string; n: string }>(
        `select article_code, count(*) as n
           from capacity_sheet where is_routed
          group by article_code order by article_code`,
      )
      const byArticle = Object.fromEntries(
        rows.map((r) => [r.article_code, Number(r.n)]),
      )
      // A dining chair has no metalwork; an ottoman is fully upholstered, so
      // nothing in it is sanded or lacquered either.
      expect(byArticle['DL25107']).toBe(14)
      expect(byArticle['125034299']).toBe(12)
      expect(byArticle['UO265 DEN VBR']).toBe(10)
    })
  })

  it('holds the ottoman’s foam behind assembly, not the finishing it skips', async () => {
    await withRollback(async (c) => {
      await demo(c)
      // The case worth showing. Foam Pasting normally waits for Wood Finishing;
      // the ottoman never goes near it, so the engine walks further back.
      const { rows } = await c.query<{ from_code: string }>(
        `select f.code as from_code
           from article_handover h
           join articles a on a.id = h.article_id
           join departments t on t.id = h.to_department_id
           join departments f on f.id = h.from_department_id
          where a.code = 'UO265 DEN VBR' and t.code = 'FOAM'`,
      )
      expect(rows.map((r) => r.from_code)).toEqual(['ASSY'])
    })
  })

  it('has no D-minus contradicting what feeds what', async () => {
    await withRollback(async (c) => {
      await demo(c)
      // The demo must open clean. The script makes a contradiction on purpose,
      // live, which only works if there is not already one sitting there.
      const { rows } = await c.query(`select * from route_order_conflicts`)
      expect(rows).toEqual([])
    })
  })
})

describe('the demonstration order book', () => {
  it('gives every screen something to say', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const run = await runSchedule(c)

      const { rows } = await c.query<{
        lines: string
        tasks: string
        breaches: string
        flagged: string
      }>(
        `select (select count(*) from shipment_lines) as lines,
                (select count(*) from schedule_tasks where run_id = $1) as tasks,
                (select count(*) from schedule_tasks
                  where run_id = $1 and breach_reason is not null) as breaches,
                (select flagged_days from schedule_kpis where run_id = $1) as flagged`,
        [run],
      )
      expect(Number(rows[0].lines)).toBe(9)
      expect(Number(rows[0].tasks)).toBeGreaterThan(50)
      // Both have to be non-zero or the demo has nothing to demonstrate.
      expect(Number(rows[0].breaches)).toBeGreaterThan(0)
      expect(Number(rows[0].flagged)).toBeGreaterThan(0)
    })
  })

  it('makes stitching the constraint', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const run = await runSchedule(c)
      const { rows } = await c.query<{ department_code: string }>(
        `select department_code from schedule_bottleneck
          where run_id = $1 order by avg_utilisation desc limit 1`,
        [run],
      )
      expect(rows[0].department_code).toBe('STITCH')
    })
  })

  it('carries the material breach the late-fabric order exists for', async () => {
    await withRollback(async (c) => {
      await demo(c)
      const run = await runSchedule(c)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_gantt
          where run_id = $1 and erp_order_no = 'SO/26-27/0455'
            and breach_reason = 'material'`,
        [run],
      )
      expect(Number(rows[0].n)).toBeGreaterThan(0)
    })
  })

  it('opens with production history, so the newest screen is not empty', async () => {
    await withRollback(async (c) => {
      await demo(c)
      await runSchedule(c)

      const { rows: declared } = await c.query<{ n: string }>(
        `select count(*) as n from production_declarations`,
      )
      expect(Number(declared[0].n)).toBe(3)

      // And one handover already counted in, six short.
      const { rows: acc } = await c.query<{ qty_accepted: string }>(
        `select qty_accepted::text from production_acceptances`,
      )
      expect(acc).toHaveLength(1)
      expect(Number(acc[0].qty_accepted)).toBe(208)

      const { rows: yielded } = await c.query<{ measured_yield_pct: number }>(
        `select measured_yield_pct from measured_yield
          where department_code = 'MACHINE'`,
      )
      expect(yielded[0].measured_yield_pct).toBeCloseTo(
        (100 * 208) / (208 + 9),
        3,
      )
    })
  })
})
