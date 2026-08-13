// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * WIP value, from a box rather than a spreadsheet.
 *
 * The ask attached to this KPI had grown into "flatten seventy-one costing
 * workbooks", for a feature the client had asked to defer. The minimum was
 * always one number per article. What these guard is that a partly-filled
 * factory produces a partly-honest figure rather than a confidently wrong one.
 */

const wip = async (c: pg.Client) =>
  (
    await c.query<{
      actual: number | null
      available: boolean
      unavailable_because: string | null
      note: string | null
    }>(
      `select actual, available, unavailable_because, note
         from md_dashboard where key = 'wip_value'`,
    )
  ).rows[0]

/** Seed, one order, a run, and some work started. Returns the line id. */
async function started(c: pg.Client, qty = 100) {
  await applySeed(c)
  await createOrder(c, { qty, stuffingDate: '2026-12-01' })
  await runSchedule(c)
  const line = (
    await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
  ).rows[0].id

  // Wood makes three of the article's four departments' worth of components;
  // finishing it is a quarter of the route.
  const { rows } = await c.query<{
    component_code: string
    qty_required: string
  }>(
    `select component_code, qty_required::text from schedule_gantt
      where department_code = 'WOOD'`,
  )
  for (const t of rows) {
    await c.query(
      `select declare_production($1, 'WOOD', $2, current_date, 'GEN', $3, 0)`,
      [line, t.component_code, Number(t.qty_required)],
    )
  }
  return line
}

describe('the cost box', () => {
  it('starts empty, and empty is not zero', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ unit_cost: number | null }>(
        `select unit_cost from capacity_sheet where article_code = 'AARA-LC' limit 1`,
      )
      expect(rows[0].unit_cost).toBeNull()
    })
  })

  it('takes a number and gives it back', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article_cost('AARA-LC', 16760)`)
      const { rows } = await c.query<{ unit_cost: number }>(
        `select unit_cost from capacity_sheet where article_code = 'AARA-LC' limit 1`,
      )
      expect(rows[0].unit_cost).toBe(16760)
    })
  })

  it('clears back to nobody-has-said', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article_cost('AARA-LC', 16760)`)
      await c.query(`select set_article_cost('AARA-LC', null)`)
      const { rows } = await c.query<{ unit_cost: number | null }>(
        `select unit_cost from capacity_sheet where article_code = 'AARA-LC' limit 1`,
      )
      // Not zero. Zero would be a claim that the thing is free, and the
      // dashboard would believe it.
      expect(rows[0].unit_cost).toBeNull()
    })
  })

  // One failing statement per test: withRollback wraps each in a single
  // transaction, and the first error aborts it, so a second assertion only
  // ever sees "current transaction is aborted".
  it('refuses a negative cost', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_article_cost('AARA-LC', -5)`),
      ).rejects.toThrow()
    })
  })

  it('refuses an article that does not exist', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_article_cost('NOSUCH', 100)`),
      ).rejects.toThrow(/unknown article/)
    })
  })
})

describe('WIP value from whatever is filled in', () => {
  it('says what to do while no article in progress has a cost', async () => {
    await withRollback(async (c) => {
      await started(c)
      const v = await wip(c)
      expect(v.available).toBe(false)
      expect(v.actual).toBeNull()
      expect(v.unavailable_because).toMatch(/capacity sheet/i)
      // The old message pointed at a page of a spreadsheet nobody could parse.
      expect(v.unavailable_because).not.toMatch(/page 33/i)
    })
  })

  it('computes quantity times cost times progress', async () => {
    await withRollback(async (c) => {
      await started(c, 100)
      await c.query(`select set_article_cost('AARA-LC', 1000)`)

      // One of four departments done, so a quarter of the way through the
      // route: 100 units × ₹1,000 × 0.25.
      const v = await wip(c)
      expect(v.available).toBe(true)
      expect(v.actual).toBe(25000)
    })
  })

  it('moves as the work does', async () => {
    await withRollback(async (c) => {
      const line = await started(c, 100)
      await c.query(`select set_article_cost('AARA-LC', 1000)`)
      expect((await wip(c)).actual).toBe(25000)

      // Fabric cutting finishes too — half the route.
      const { rows } = await c.query<{
        component_code: string
        qty_required: string
      }>(
        `select component_code, qty_required::text from schedule_gantt
          where department_code = 'FABCUT'`,
      )
      for (const t of rows) {
        await c.query(
          `select declare_production($1, 'FABCUT', $2, current_date, 'GEN', $3, 0)`,
          [line, t.component_code, Number(t.qty_required)],
        )
      }
      expect((await wip(c)).actual).toBe(50000)
    })
  })

  it('says how much of the floor it covers', async () => {
    await withRollback(async (c) => {
      const line = await started(c, 100)
      await c.query(`select set_article_cost('AARA-LC', 1000)`)

      // Everything costed: no caveat needed, but say so plainly anyway.
      expect((await wip(c)).note).toMatch(/all 1 lines? in progress/i)

      // A second article in progress with no cost against it. The total is now
      // partial, and a rupee figure that silently omits half the floor is worse
      // than none.
      await c.query(
        `insert into articles (code, name) values ('SECOND', 'Another chair')`,
      )
      await c.query(`select set_capacity_cell('SECOND', 'WOOD', 25)`)
      await c.query(`select set_dminus('SECOND', 'WOOD', 60)`)
      await createOrder(c, {
        erpOrderNo: 'SO-SECOND',
        articleCode: 'SECOND',
        qty: 50,
        stuffingDate: '2026-12-10',
      })
      await runSchedule(c)
      const second = (
        await c.query<{ id: string }>(
          `select sl.id from shipment_lines sl join orders o on o.id = sl.order_id
            where o.erp_order_no = 'SO-SECOND'`,
        )
      ).rows[0].id
      await c.query(
        `select declare_production($1, 'WOOD', 'SECOND::WOOD', current_date, 'GEN', 5, 0)`,
        [second],
      )
      void line

      const v = await wip(c)
      expect(v.available).toBe(true)
      expect(v.note).toMatch(/covering 1 of 2 lines in progress/i)
    })
  })

  it('drops a line out once it is finished, not just started', async () => {
    await withRollback(async (c) => {
      const line = await started(c, 100)
      await c.query(`select set_article_cost('AARA-LC', 1000)`)
      expect((await wip(c)).actual).toBe(25000)

      const run = (
        await c.query<{ id: string }>(
          `select id from schedule_runs where is_current`,
        )
      ).rows[0].id
      const { rows } = await c.query<{
        department_code: string
        component_code: string
        qty_required: string
      }>(
        `select department_code, component_code, qty_required::text
           from schedule_gantt where run_id = $1`,
        [run],
      )
      for (const t of rows) {
        await c.query(
          `select declare_production($1, $2, $3, current_date, 'GEN', $4, 0)`,
          [line, t.department_code, t.component_code, Number(t.qty_required)],
        )
      }

      // Finished is not in progress. It has left the floor.
      const v = await wip(c)
      expect(v.available).toBe(false)
      expect(v.unavailable_because).toMatch(/capacity sheet/i)
    })
  })
})
