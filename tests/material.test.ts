// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Phase 5 — material.
 *
 * The arithmetic here is deliberately thin, because the hard part was done in
 * Phase 2: the engine already knows what each department must make on each day,
 * yield-inflated. Material rides on that. What these guard is that it really
 * does ride on it — that the compounding is inherited rather than re-derived —
 * and that a material nobody has counted is never reported as a material there
 * is none of.
 */

async function factory(c: pg.Client) {
  await applySeed(c)
  await c.query(`select set_supplier('SUP-1', 'Sharma Timber', 21)`)
  await c.query(
    `select set_material('WD-OAK', 'Oak, 25mm', 'Wood', 'CFT', 'SUP-1')`,
  )
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)
}

const requirement = async (c: pg.Client) =>
  (
    await c.query<{
      material_code: string
      department_code: string
      needed_on: string
      order_by: string
      lead_time_days: number
      qty_required: number
    }>(`select * from material_requirements`)
  ).rows

describe('what a plan consumes', () => {
  it('inherits the engine’s yield-inflated quantity rather than recomputing it', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 2)`)

      const rows = await requirement(c)
      // One row, not one per component. Wood makes three components of this
      // chair, and joining material to tasks used to order three times the oak.
      expect(rows).toHaveLength(1)

      // How many chairs' worth wood is making, recovered from the plan. Note
      // the aggregate rather than `limit 1`: an unordered limit returns a
      // different component depending on the plan, which is a test that passes
      // alone and fails in the suite.
      const articleQty = Number(
        (
          await c.query<{ art: string }>(
            `select max(sg.qty_required / b.qty_per_unit)::text as art
               from schedule_gantt sg
               join components c on c.code = sg.component_code
               join article_bom b on b.component_id = c.id
              where sg.department_code = 'WOOD'`,
          )
        ).rows[0].art,
      )

      // Wood must make more than the hundred ordered, so that a hundred survive
      // every loss after it — and the material follows that figure, not the
      // order's.
      expect(articleQty).toBeGreaterThan(100)
      expect(rows[0].qty_required).toBeCloseTo(articleQty * 2, 3)
      expect(rows[0].qty_required).toBeGreaterThan(200)
    })
  })

  it('is needed when its own department starts, not when the order ships', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)

      const rows = await requirement(c)
      const start = (
        await c.query<{ start_date: string }>(
          `select start_date::text from schedule_gantt
            where department_code = 'WOOD' limit 1`,
        )
      ).rows[0].start_date

      expect(rows[0].needed_on).toBe(start)
      // And nowhere near the container date, which is what a bill of materials
      // without a department would have had to assume.
      expect(rows[0].needed_on < '2026-12-01').toBe(true)
    })
  })

  it('counts back the supplier’s lead time to say when to order', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)

      const rows = await requirement(c)
      expect(rows[0].lead_time_days).toBe(21)

      const needed = new Date(rows[0].needed_on)
      const order = new Date(rows[0].order_by)
      const days = Math.round((+needed - +order) / 86_400_000)
      // Calendar days, deliberately: a supplier does not observe our factory
      // holidays, so working days would understate the wait.
      expect(days).toBe(21)
    })
  })

  it('lets one material override its supplier’s lead time', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(
        `select set_material('WD-OAK', 'Oak, 25mm', 'Wood', 'CFT', 'SUP-1', 45)`,
      )
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)
      expect((await requirement(c))[0].lead_time_days).toBe(45)
    })
  })

  it('says nothing about a material no article uses', async () => {
    await withRollback(async (c) => {
      await factory(c)
      // On the books, in no bill of materials. It cannot be short of anything.
      expect(await requirement(c)).toHaveLength(0)
      const { rows } = await c.query(`select * from material_shortage`)
      expect(rows).toHaveLength(0)
    })
  })
})

describe('shortages, and the third state', () => {
  const shortage = async (c: pg.Client) =>
    (
      await c.query<{
        material_code: string
        qty_required: number
        qty_on_hand: number | null
        shortfall: number | null
        status: string
        stock_known: boolean
      }>(`select * from material_shortage`)
    ).rows[0]

  it('reports a material nobody has counted as exactly that', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)

      const s = await shortage(c)
      // Not "short of everything". Nobody has been to the store. Calling that a
      // shortage would bury the real ones under a list of uncounted shelves.
      expect(s.status).toBe('not counted')
      expect(s.stock_known).toBe(false)
      expect(s.qty_on_hand).toBeNull()
      expect(s.shortfall).toBeNull()
      expect(s.qty_required).toBeGreaterThan(0)
    })
  })

  it('is covered when the store has enough', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)
      await c.query(`select set_material_stock('WD-OAK', 100000)`)

      const s = await shortage(c)
      expect(s.status).toBe('covered')
      expect(s.shortfall).toBe(0)
    })
  })

  it('is short by the difference, and only the difference', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)

      const needed = (await requirement(c))[0].qty_required
      await c.query(`select set_material_stock('WD-OAK', $1)`, [needed - 40])

      const s = await shortage(c)
      expect(s.status).toBe('short')
      expect(s.shortfall).toBeCloseTo(40, 3)
    })
  })

  it('tells zero on the shelf apart from nobody having looked', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)
      await c.query(`select set_material_stock('WD-OAK', 0, current_date, 'shelf empty')`)

      const s = await shortage(c)
      // Counted, and there is none. A real finding, and a different one from
      // the test above.
      expect(s.status).toBe('short')
      expect(s.stock_known).toBe(true)
      expect(s.qty_on_hand).toBe(0)
      expect(s.shortfall).toBe(s.qty_required)
    })
  })

  it('clears a count back to nobody-has-said', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 1)`)
      await c.query(`select set_material_stock('WD-OAK', 500)`)
      await c.query(`select set_material_stock('WD-OAK', null)`)
      expect((await shortage(c)).status).toBe('not counted')
    })
  })
})

describe('the bill of materials', () => {
  it('adds up several materials at several departments', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_material('FAB-01', 'Linen, natural', 'Fabric', 'MTR')`)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 2)`)
      await c.query(`select set_article_material('AARA-LC', 'FAB-01', 'FABCUT', 3)`)

      const rows = await requirement(c)
      expect(rows).toHaveLength(2)
      const byDept = Object.fromEntries(rows.map((r) => [r.material_code, r]))
      expect(byDept['WD-OAK'].department_code).toBe('WOOD')
      expect(byDept['FAB-01'].department_code).toBe('FABCUT')
      // Fabric cutting runs later than wood, so its material is needed later.
      expect(byDept['FAB-01'].needed_on > byDept['WD-OAK'].needed_on).toBe(true)
    })
  })

  it('removes a line when the quantity is cleared', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 2)`)
      expect(await requirement(c)).toHaveLength(1)
      await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', null)`)
      expect(await requirement(c)).toHaveLength(0)
    })
  })

  it('refuses a line against something that does not exist', async () => {
    await withRollback(async (c) => {
      await factory(c)
      await expect(
        c.query(`select set_article_material('AARA-LC', 'NOSUCH', 'WOOD', 1)`),
      ).rejects.toThrow(/unknown material/)
    })
  })
})
