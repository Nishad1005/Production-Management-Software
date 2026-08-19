// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Phase 8 — money.
 *
 * Two things are worth guarding. That an article's cost has **one** source
 * rather than a breakdown and a typed total quietly disagreeing; and that a
 * material nobody has priced is never dropped from a cash figure, because a
 * total that omits what it cannot price is smaller, tidier and wrong.
 */

async function costed(c: pg.Client) {
  await applySeed(c)
  await c.query(`select set_cost_line('WOOD', 'Wood', 'material', 10)`)
  await c.query(`select set_cost_line('FOAM', 'Foam', 'material', 20)`)
  await c.query(`select set_cost_line('LABOUR', 'Labour', 'labour', 90)`)
}

const unitCost = async (c: pg.Client) =>
  (
    await c.query<{ unit_cost: number | null }>(
      `select unit_cost from article_cost_summary where article_code = 'AARA-LC'`,
    )
  ).rows[0].unit_cost

describe('an article’s cost has one source', () => {
  it('is the sum of its lines, written where everything else reads it', async () => {
    await withRollback(async (c) => {
      await costed(c)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4745.05)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'FOAM', 2700.83)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'LABOUR', 950)`)

      expect(await unitCost(c)).toBeCloseTo(8395.88, 2)

      // The capacity sheet and the MD's WIP value both read articles.unit_cost.
      // They must see the same figure without knowing a breakdown exists.
      const { rows } = await c.query<{ unit_cost: number }>(
        `select unit_cost from capacity_sheet where article_code = 'AARA-LC' limit 1`,
      )
      expect(rows[0].unit_cost).toBeCloseTo(8395.88, 2)
    })
  })

  it('follows a correction down as well as up', async () => {
    await withRollback(async (c) => {
      await costed(c)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 5000)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4000)`)
      expect(await unitCost(c)).toBeCloseTo(4000, 2)
    })
  })

  it('goes back to nobody-has-said when the last line is removed', async () => {
    await withRollback(async (c) => {
      await costed(c)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4000)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', null)`)
      // Not zero. Zero is a claim that the chair is free, and the dashboard
      // would put it on screen as a rupee figure.
      expect(await unitCost(c)).toBeNull()
    })
  })

  it('keeps a zero line, because zero is a statement', async () => {
    await withRollback(async (c) => {
      await costed(c)
      await c.query(`select set_cost_line('METAL', 'Metal', 'material', 30)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4000)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'METAL', 0)`)

      // U&M's own sheet carries metal, piping and button at zero for a chair
      // that has none of them. That is different from not having costed it.
      const { rows } = await c.query<{ lines: number; has_breakdown: boolean }>(
        `select lines, has_breakdown from article_cost_summary
          where article_code = 'AARA-LC'`,
      )
      expect(rows[0].lines).toBe(2)
      expect(await unitCost(c)).toBeCloseTo(4000, 2)
    })
  })

  it('says whether a cost has anything behind it', async () => {
    await withRollback(async (c) => {
      await costed(c)
      // The old way: a typed total, still perfectly usable.
      await c.query(`select set_article_cost('AARA-LC', 16760)`)
      const { rows: typed } = await c.query<{ has_breakdown: boolean; unit_cost: number }>(
        `select has_breakdown, unit_cost from article_cost_summary
          where article_code = 'AARA-LC'`,
      )
      expect(typed[0].unit_cost).toBe(16760)
      expect(typed[0].has_breakdown).toBe(false)

      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4000)`)
      const { rows: broken } = await c.query<{ has_breakdown: boolean; unit_cost: number }>(
        `select has_breakdown, unit_cost from article_cost_summary
          where article_code = 'AARA-LC'`,
      )
      // Lines exist now, so they are the truth and the typed total is gone.
      expect(broken[0].has_breakdown).toBe(true)
      expect(broken[0].unit_cost).toBeCloseTo(4000, 2)
    })
  })

  it('groups the lines the way a cost is argued about', async () => {
    await withRollback(async (c) => {
      await costed(c)
      await c.query(`select set_article_cost_line('AARA-LC', 'WOOD', 4745.05)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'FOAM', 2700.83)`)
      await c.query(`select set_article_cost_line('AARA-LC', 'LABOUR', 950)`)

      const { rows } = await c.query<{
        material_cost: number
        labour_cost: number
      }>(`select * from article_cost_summary where article_code = 'AARA-LC'`)
      expect(rows[0].material_cost).toBeCloseTo(7445.88, 2)
      expect(rows[0].labour_cost).toBe(950)
    })
  })
})

describe('money out', () => {
  async function committed(c: pg.Client) {
    await applySeed(c)
    await c.query(`select set_supplier('SUP-1', 'Sharma Timber', 21)`)
    await c.query(`select set_supplier_terms('SUP-1', 45)`)
    await c.query(`select set_material('WD-OAK', 'Oak', 'Wood', 'CFT', 'SUP-1')`)
    await c.query(`select set_material('FAB-01', 'Linen', 'Fabric', 'MTR', 'SUP-1')`)
    await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
    await runSchedule(c)
    await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 2)`)
    await c.query(`select set_article_material('AARA-LC', 'FAB-01', 'FABCUT', 3)`)
  }

  const commitments = async (c: pg.Client) =>
    (
      await c.query<{
        material_code: string
        qty_required: number
        rate_per_uom: number | null
        amount: number | null
        payable_on: string
        needed_on: string
        priced: boolean
      }>(`select * from purchase_commitments order by material_code`)
    ).rows

  it('prices what the plan commits us to buying', async () => {
    await withRollback(async (c) => {
      await committed(c)
      await c.query(`select set_material_rate('WD-OAK', 250)`)

      const rows = await commitments(c)
      const oak = rows.find((r) => r.material_code === 'WD-OAK')!
      expect(oak.priced).toBe(true)
      expect(oak.amount).toBeCloseTo(oak.qty_required * 250, 2)
    })
  })

  it('falls due after the material is needed, by the supplier’s terms', async () => {
    await withRollback(async (c) => {
      await committed(c)
      await c.query(`select set_material_rate('WD-OAK', 250)`)

      const oak = (await commitments(c)).find((r) => r.material_code === 'WD-OAK')!
      const days = Math.round(
        (+new Date(oak.payable_on) - +new Date(oak.needed_on)) / 86_400_000,
      )
      // Counted from the day it is needed, not the day it is ordered: the
      // invoice follows the delivery, not the purchase order.
      expect(days).toBe(45)
    })
  })

  it('carries an unpriced material rather than dropping it', async () => {
    await withRollback(async (c) => {
      await committed(c)
      await c.query(`select set_material_rate('WD-OAK', 250)`)
      // Linen has no rate. Leaving it out would make the total smaller, tidier
      // and wrong, and nothing on screen would say so.
      const rows = await commitments(c)
      expect(rows).toHaveLength(2)

      const linen = rows.find((r) => r.material_code === 'FAB-01')!
      expect(linen.priced).toBe(false)
      expect(linen.amount).toBeNull()
      expect(linen.qty_required).toBeGreaterThan(0)
    })
  })

  it('counts the unpriced lines in every week it totals', async () => {
    await withRollback(async (c) => {
      await committed(c)
      await c.query(`select set_material_rate('WD-OAK', 250)`)

      const { rows } = await c.query<{
        week_starting: string
        amount: number | null
        priced_lines: number
        unpriced_lines: number
      }>(`select * from cash_out_weekly order by week_starting`)

      expect(rows.length).toBeGreaterThan(0)
      const totalUnpriced = rows.reduce((n, r) => n + r.unpriced_lines, 0)
      const totalPriced = rows.reduce((n, r) => n + r.priced_lines, 0)
      expect(totalPriced).toBe(1)
      expect(totalUnpriced).toBe(1)
    })
  })

  it('adds up what each supplier is owed', async () => {
    await withRollback(async (c) => {
      await committed(c)
      await c.query(`select set_material_rate('WD-OAK', 250)`)
      await c.query(`select set_material_rate('FAB-01', 400)`)

      const { rows } = await c.query<{
        supplier_code: string
        amount: number
        materials: number
        unpriced_lines: number
        payment_terms_days: number
      }>(`select * from supplier_commitments`)

      expect(rows).toHaveLength(1)
      expect(rows[0].supplier_code).toBe('SUP-1')
      expect(rows[0].materials).toBe(2)
      expect(rows[0].unpriced_lines).toBe(0)
      expect(rows[0].payment_terms_days).toBe(45)
      expect(rows[0].amount).toBeGreaterThan(0)
    })
  })

  it('says nothing at all when the plan needs nothing', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query(`select * from cash_out_weekly`)
      expect(rows).toHaveLength(0)
    })
  })
})
