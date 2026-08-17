// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Phase 6 — quality.
 *
 * The quantities have been in the ledger since Phase 3; this phase adds the
 * reason and reports on it. So most of what is worth guarding is about the
 * *gap*: rejects nobody has explained must stay visible, and attribution must
 * never be allowed to exceed what was actually rejected.
 */

async function madeAndRejected(c: pg.Client, good = 90, rejected = 10) {
  await applySeed(c)
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)

  const line = (
    await c.query<{ id: string }>(`select id from shipment_lines limit 1`)
  ).rows[0].id
  const component = (
    await c.query<{ component_code: string }>(
      `select component_code from schedule_gantt
        where department_code = 'WOOD' order by component_code limit 1`,
    )
  ).rows[0].component_code

  await c.query(
    `select declare_production($1, 'WOOD', $2, '2026-10-01', 'GEN', $3, $4)`,
    [line, component, good, rejected],
  )

  await c.query(`select set_defect_type('SPLIT', 'Split on the joint', 'workmanship')`)
  await c.query(`select set_defect_type('KNOT', 'Knot in the face', 'material')`)

  return { line, component }
}

const attribute = (
  c: pg.Client,
  line: string,
  component: string,
  code: string,
  qty: number | null,
) =>
  c.query(
    `select attribute_defect($1, 'WOOD', $2, '2026-10-01', 'GEN', $3, $4)`,
    [line, component, code, qty],
  )

describe('why things were rejected', () => {
  it('records a cause against the day it happened', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c)
      await attribute(c, line, component, 'SPLIT', 6)

      const { rows } = await c.query<{
        defect_code: string
        category: string
        qty: number
        department_code: string
      }>(`select * from defect_list`)
      expect(rows).toHaveLength(1)
      expect(rows[0].defect_code).toBe('SPLIT')
      expect(rows[0].category).toBe('workmanship')
      expect(rows[0].qty).toBe(6)
      expect(rows[0].department_code).toBe('WOOD')
    })
  })

  it('refuses to explain more rejects than there were', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c, 90, 10)
      await attribute(c, line, component, 'SPLIT', 7)
      // Seven and five is twelve, and only ten were rejected. Not a judgement
      // call — arithmetic that cannot be true.
      await expect(
        attribute(c, line, component, 'KNOT', 5),
      ).rejects.toThrow(/account for 12 of only 10/)
    })
  })

  it('allows a partial explanation rather than demanding one', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c, 90, 10)
      // Six of ten explained. A supervisor who can only account for six should
      // not be forced to invent four, which is what a hard constraint buys.
      await expect(attribute(c, line, component, 'SPLIT', 6)).resolves.toBeDefined()
    })
  })

  it('corrects an attribution rather than adding to it', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c)
      await attribute(c, line, component, 'SPLIT', 6)
      await attribute(c, line, component, 'SPLIT', 4)
      const { rows } = await c.query<{ qty: number }>(`select qty from defect_list`)
      expect(rows).toHaveLength(1)
      expect(rows[0].qty).toBe(4)
    })
  })

  it('refuses a cause against a day nothing was declared', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c)
      await expect(
        c.query(
          `select attribute_defect($1, 'WOOD', $2, '2026-10-09', 'GEN', 'SPLIT', 1)`,
          [line, component],
        ),
      ).rejects.toThrow(/nothing was declared/)
    })
  })
})

describe('the Pareto', () => {
  it('ranks causes and carries the unexplained balance as its own line', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c, 90, 10)
      await attribute(c, line, component, 'SPLIT', 5)
      await attribute(c, line, component, 'KNOT', 2)

      const { rows } = await c.query<{
        code: string
        qty: number
        share_pct: number
        running_pct: number
      }>(`select * from defect_pareto order by qty desc, code`)

      // Five split, three unexplained, two knots — and the three nobody has
      // explained are a line rather than quietly missing from the denominator.
      expect(rows.map((r) => r.code)).toEqual(['SPLIT', 'UNATTRIBUTED', 'KNOT'])
      expect(rows[0].qty).toBe(5)
      expect(rows[1].qty).toBe(3)
      expect(rows[2].qty).toBe(2)

      expect(rows[0].share_pct).toBe(50)
      // The running share is the point of a Pareto: two causes, 80%.
      expect(rows[1].running_pct).toBe(80)
      expect(rows[2].running_pct).toBe(100)
    })
  })

  it('drops the unexplained line once everything is accounted for', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c, 90, 10)
      await attribute(c, line, component, 'SPLIT', 6)
      await attribute(c, line, component, 'KNOT', 4)

      const { rows } = await c.query<{ code: string }>(`select code from defect_pareto`)
      expect(rows.map((r) => r.code).sort()).toEqual(['KNOT', 'SPLIT'])
    })
  })
})

describe('per department, against what the master claims', () => {
  const dept = async (c: pg.Client) =>
    (
      await c.query<{
        rejection_pct: number
        measured_yield_pct: number
        planned_yield_pct: number
        against_plan_pct: number
        attributed_pct: number | null
        biggest_cause: string | null
      }>(`select * from quality_by_department where department_code = 'WOOD'`)
    ).rows[0]

  it('puts the counted yield beside the one somebody typed', async () => {
    await withRollback(async (c) => {
      await madeAndRejected(c, 90, 10)
      const q = await dept(c)
      expect(q.rejection_pct).toBe(10)
      expect(q.measured_yield_pct).toBe(90)
      // The seed claims 98% for wood. Counting says 90, and the gap is the
      // number worth looking at — reported, never applied to the master.
      expect(q.planned_yield_pct).toBe(98)
      expect(q.against_plan_pct).toBe(-8)
    })
  })

  it('says how much of it anybody has explained, and what led', async () => {
    await withRollback(async (c) => {
      const { line, component } = await madeAndRejected(c, 90, 10)
      expect((await dept(c)).attributed_pct).toBe(0)

      await attribute(c, line, component, 'SPLIT', 6)
      await attribute(c, line, component, 'KNOT', 1)
      const q = await dept(c)
      expect(q.attributed_pct).toBe(70)
      expect(q.biggest_cause).toMatch(/Split/)
    })
  })

  it('says nothing at all about a department that has declared nothing', async () => {
    await withRollback(async (c) => {
      await madeAndRejected(c)
      const { rows } = await c.query(
        `select * from quality_by_department where department_code = 'STITCH'`,
      )
      // Not a zero rejection rate, which would read as a department doing
      // perfectly. It has not reported.
      expect(rows).toHaveLength(0)
    })
  })
})

describe('per article', () => {
  it('separates a bad article from a bad department', async () => {
    await withRollback(async (c) => {
      await madeAndRejected(c, 90, 10)
      const { rows } = await c.query<{
        article_code: string
        rejection_pct: number
        departments: number
      }>(`select * from quality_by_article`)
      expect(rows[0].article_code).toBe('AARA-LC')
      expect(rows[0].rejection_pct).toBe(10)
      expect(rows[0].departments).toBe(1)
    })
  })
})
