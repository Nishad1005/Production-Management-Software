// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The engine's runway check holds a department behind the departments that feed
 * it. That makes "a feeder must be due earlier than what it feeds" a rule the
 * whole check depends on, and one nothing enforced.
 *
 * The seeded graph is a single line, so these read as though they were about
 * route order. They are not — see the block at the bottom, where two departments
 * contradict each other and it does not matter because neither feeds the other.
 */

const conflicts = (c: pg.Client) =>
  c.query<{
    article_code: string
    earlier_department_code: string
    later_department_code: string
    earlier_dminus: number
    later_dminus: number
    affects_scheduling: boolean
  }>(
    `select article_code, earlier_department_code, later_department_code,
            earlier_dminus, later_dminus, affects_scheduling
       from route_order_conflicts order by article_code, later_position`,
  )

describe('route order against D-minus', () => {
  it('says nothing when the seeded route is consistent', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await conflicts(c)
      expect(rows).toEqual([])
    })
  })

  it('flags a department that must finish before the one ahead of it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Fabric cutting sits at position 20 and is due D-50. Pushing it to D-70
      // means it must finish twenty days before wood, which is ahead of it.
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 70)`)

      const { rows } = await conflicts(c)
      expect(rows).toHaveLength(1)
      expect(rows[0].earlier_department_code).toBe('WOOD')
      expect(rows[0].later_department_code).toBe('FABCUT')
      expect(rows[0].earlier_dminus).toBe(60)
      expect(rows[0].later_dminus).toBe(70)
    })
  })

  it('compares consecutive departments, as the runway check does', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Assembly at position 40 pushed past wood at position 10 — but stitching
      // sits between them, so the pair the engine actually compares is
      // stitching against assembly.
      await c.query(`select set_dminus('AARA-LC', 'ASSY', 65)`)

      const { rows } = await conflicts(c)
      expect(rows).toHaveLength(1)
      expect(rows[0].earlier_department_code).toBe('STITCH')
      expect(rows[0].later_department_code).toBe('ASSY')
    })
  })

  it('ignores departments whose D-minus has not been entered', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', null)`)
      await c.query(`select set_dminus('AARA-LC', 'STITCH', 70)`)

      // With fabric cutting blank, the comparison runs wood → stitching.
      const { rows } = await conflicts(c)
      expect(rows).toHaveLength(1)
      expect(rows[0].earlier_department_code).toBe('WOOD')
      expect(rows[0].later_department_code).toBe('STITCH')
    })
  })

  it('raises nothing at all for an article with no D-minus yet', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('BLANK', 'Nothing entered')`,
      )
      const { rows } = await conflicts(c)
      // A blank article is not a contradiction — it is simply unfilled, and
      // saying otherwise would bury the real ones.
      expect(rows.filter((r) => r.article_code === 'BLANK')).toEqual([])
    })
  })

  it('separates a contradiction that bites from one that does not', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('PART', 'Partly routed')`,
      )
      // D-minus entered on both, but the article is only routed through one, so
      // the engine never compares them.
      await c.query(`select set_dminus('PART', 'WOOD', 60)`)
      await c.query(`select set_dminus('PART', 'FABCUT', 70)`)
      await c.query(`select set_capacity_cell('PART', 'WOOD', 25)`)

      const { rows } = await conflicts(c)
      const part = rows.find((r) => r.article_code === 'PART')
      expect(part?.affects_scheduling).toBe(false)
    })
  })
})

describe('what the graph changes about the guard', () => {
  it('says nothing about two departments that merely sit near each other', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Fabric cutting becomes an entry point, alongside wood rather than after
      // it. Its D-minus now contradicts wood's exactly as before — and no longer
      // matters, because neither one feeds the other. Under the old consecutive
      // comparison this was a flag, and the flag was noise.
      await c.query(`select set_department_dependency('FABCUT', 'WOOD', false)`)
      await c.query(`select set_department_dependency('STITCH', 'WOOD', true)`)
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 70)`)

      const { rows } = await conflicts(c)
      expect(rows).toEqual([])
    })
  })

  it('flags a feeder due on the same day as what it feeds', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Same due date means stitching starts before fabric cutting has finished,
      // and the engine raises a runway breach for it. The old view wanted
      // strictly earlier and stayed quiet here.
      await c.query(`select set_dminus('AARA-LC', 'STITCH', 50)`)

      const { rows } = await conflicts(c)
      expect(rows).toHaveLength(1)
      expect(rows[0].earlier_department_code).toBe('FABCUT')
      expect(rows[0].later_department_code).toBe('STITCH')
      expect(rows[0].earlier_dminus).toBe(50)
      expect(rows[0].later_dminus).toBe(50)
    })
  })

  it('names the binding feeder when several contradict', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Assembly pushed past all three upstream departments. The one that
      // actually holds it back is stitching, due latest of them.
      await c.query(`select set_dminus('AARA-LC', 'ASSY', 65)`)

      const { rows } = await conflicts(c)
      expect(rows).toHaveLength(1)
      expect(rows[0].earlier_department_code).toBe('STITCH')
    })
  })
})

describe('the contradiction the guard is about', () => {
  it('does produce a runway breach the order alone would not justify', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Fabric cutting must now finish ten days before wood, while sitting
      // after it — so the engine holds it back behind work that is not due yet.
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 70)`)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const run = await runSchedule(c)

      const { rows } = await c.query<{ breach_reason: string | null }>(
        `select breach_reason from schedule_gantt
          where run_id = $1 and department_code = 'FABCUT'`,
        [run],
      )
      expect(rows[0].breach_reason).toBe('runway')

      const { rows: flagged } = await conflicts(c)
      expect(flagged).toHaveLength(1)
      expect(flagged[0].affects_scheduling).toBe(true)
    })
  })
})
