// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The WIP ledger. The first thing in Kram that records what happened rather
 * than what someone asserted, so the tests care most about two things: that a
 * declaration lands on the job it was made against, and that the department
 * asked to count it in is genuinely the one the work went to.
 */

const dep = (c: pg.Client, department: string, feeder: string, on: boolean) =>
  c.query(`select set_department_dependency($1, $2, $3)`, [department, feeder, on])

async function firstLine(c: pg.Client) {
  const { rows } = await c.query<{ id: string }>(
    `select id from shipment_lines limit 1`,
  )
  return rows[0].id
}

const declare = (
  c: pg.Client,
  line: string,
  department: string,
  component: string,
  date: string,
  good: number,
  rejected = 0,
) =>
  c.query<{ declare_production: string }>(
    `select declare_production($1, $2, $3, $4::date, 'GEN', $5, $6) as declare_production`,
    [line, department, component, date, good, rejected],
  )

describe('who hands to whom', () => {
  it('follows the route graph, not the component', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // No component is worked by two departments — the capacity sheet writes
      // one stage component per department — so a component-level handover
      // would find nothing at all. This is the check that it does not.
      const { rows } = await c.query<{ from: string; to: string }>(
        `select f.code as "from", t.code as "to"
           from article_handover h
           join departments f on f.id = h.from_department_id
           join departments t on t.id = h.to_department_id
           join articles a on a.id = h.article_id
          where a.code = 'AARA-LC'
          order by f.route_position`,
      )
      expect(rows).toEqual([
        { from: 'WOOD', to: 'FABCUT' },
        { from: 'FABCUT', to: 'STITCH' },
        { from: 'STITCH', to: 'ASSY' },
      ])
    })
  })

  it('hands over to the nearest department, not every one downstream', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from article_handover h
           join departments f on f.id = h.from_department_id
          where f.code = 'WOOD'`,
      )
      // Fabric cutting, and not also stitching and assembly. Without the
      // transitive reduction a supervisor is asked to count in work from every
      // department upstream of them, most of which never reached their bench.
      expect(Number(rows[0].n)).toBe(1)
    })
  })

  it('splits when a department feeds two', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Wood feeds both fabric cutting and stitching directly.
      await dep(c, 'STITCH', 'FABCUT', false)
      await dep(c, 'STITCH', 'WOOD', true)

      const { rows } = await c.query<{ to: string }>(
        `select t.code as "to"
           from article_handover h
           join departments f on f.id = h.from_department_id
           join departments t on t.id = h.to_department_id
          where f.code = 'WOOD' order by t.code`,
      )
      expect(rows.map((r) => r.to)).toEqual(['FABCUT', 'STITCH'])
    })
  })

  it('gives the last department nobody to hand to', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from article_handover h
           join departments f on f.id = h.from_department_id
          where f.code = 'ASSY'`,
      )
      expect(Number(rows[0].n)).toBe(0)
    })
  })
})

describe('declaring production', () => {
  it('lands on the scheduled job and shows up on the worklist', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)

      const { rows: before } = await c.query<{
        qty_planned: number
        qty_good: number
        declaration_id: string | null
      }>(
        `select qty_planned, qty_good, declaration_id
           from production_worklist
          where department_code = 'STITCH' and component_code = 'COVER'
          order by work_date limit 1`,
      )
      expect(before[0].qty_planned).toBeGreaterThan(0)
      // Nothing said yet is not the same as nothing made.
      expect(before[0].declaration_id).toBeNull()
      expect(before[0].qty_good).toBe(0)

      const { rows: dates } = await c.query<{ work_date: string }>(
        `select work_date from production_worklist
          where department_code = 'STITCH' order by work_date limit 1`,
      )
      await declare(c, line, 'STITCH', 'COVER', dates[0].work_date, 28, 2)

      const { rows: after } = await c.query<{
        qty_good: number
        qty_rejected: number
        declaration_id: string | null
      }>(
        `select qty_good, qty_rejected, declaration_id
           from production_worklist
          where department_code = 'STITCH' and work_date = $1`,
        [dates[0].work_date],
      )
      expect(after[0].declaration_id).not.toBeNull()
      expect(after[0].qty_good).toBe(28)
      expect(after[0].qty_rejected).toBe(2)
    })
  })

  it('corrects rather than doubles when entered twice', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')

      await declare(c, line, 'STITCH', 'COVER', date, 28, 2)
      await declare(c, line, 'STITCH', 'COVER', date, 30, 0)

      const { rows } = await c.query<{ n: string; qty_good: string }>(
        `select count(*) as n, sum(qty_good)::text as qty_good
           from production_declarations`,
      )
      // A supervisor entering the day again is correcting it, not adding to it.
      expect(Number(rows[0].n)).toBe(1)
      expect(Number(rows[0].qty_good)).toBe(30)
    })
  })

  it('refuses a department that does not exist', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      await expect(
        declare(c, line, 'NOSUCH', 'COVER', date, 10),
      ).rejects.toThrow(/unknown department/)
    })
  })

  it('will not take a negative count', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      await expect(
        declare(c, line, 'STITCH', 'COVER', date, -5),
      ).rejects.toThrow()
    })
  })
})

describe('accepting a handover', () => {
  it('queues the declaration for the department it was handed to', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      await declare(c, line, 'STITCH', 'COVER', date, 28, 2)

      const { rows } = await c.query<{
        accepting_department_code: string
        from_department_code: string
        qty_declared: number
      }>(`select * from wip_pending_acceptance`)

      expect(rows).toHaveLength(1)
      expect(rows[0].from_department_code).toBe('STITCH')
      expect(rows[0].accepting_department_code).toBe('ASSY')
      expect(rows[0].qty_declared).toBe(28)
    })
  })

  it('leaves the queue once counted in, and keeps the shortfall', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      const { rows: made } = await declare(c, line, 'STITCH', 'COVER', date, 28)

      await c.query(`select accept_production($1, 'ASSY', $2, $3)`, [
        made[0].declare_production,
        26,
        'two short',
      ])

      const { rows: pending } = await c.query(
        `select * from wip_pending_acceptance`,
      )
      expect(pending).toHaveLength(0)

      // The disagreement is kept rather than reconciled away.
      const { rows: acc } = await c.query<{ qty_accepted: string; note: string }>(
        `select qty_accepted::text, note from production_acceptances`,
      )
      expect(Number(acc[0].qty_accepted)).toBe(26)
      expect(acc[0].note).toBe('two short')
    })
  })

  it('refuses a department the work was never handed to', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      const { rows: made } = await declare(c, line, 'STITCH', 'COVER', date, 28)

      // Wood is upstream of stitching, not downstream. Without this check the
      // ledger would record handovers that never happened, which is worse than
      // recording none because it reads as evidence.
      await expect(
        c.query(`select accept_production($1, 'WOOD', 28)`, [
          made[0].declare_production,
        ]),
      ).rejects.toThrow(/not fed by/)
    })
  })

  it('does not queue a declaration of nothing', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      // A real record — the department worked and produced nothing usable — but
      // there is no delivery for the next bench to confirm.
      await declare(c, line, 'STITCH', 'COVER', date, 0, 12)

      const { rows } = await c.query(`select * from wip_pending_acceptance`)
      expect(rows).toHaveLength(0)
    })
  })
})

describe('what the ledger tells you', () => {
  it('reports progress per department without multiplying the joins', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'WOOD')
      // Wood makes three components for this article. Summing required and
      // declared across one join would multiply each by the other's row count.
      await declare(c, line, 'WOOD', 'LEG', date, 100)

      const { rows } = await c.query<{
        qty_required: number
        qty_good: number
        state: string
      }>(
        `select qty_required, qty_good, state from wip_by_order
          where department_code = 'WOOD'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].qty_good).toBe(100)
      expect(rows[0].state).toBe('in progress')
      // 4 legs + 1 seat frame + 1 back frame per chair, inflated for yield.
      expect(rows[0].qty_required).toBeGreaterThan(500)
    })
  })

  it('measures yield against the figure someone typed', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      await declare(c, line, 'STITCH', 'COVER', date, 90, 10)

      const { rows } = await c.query<{
        planned_yield_pct: number
        measured_yield_pct: number
      }>(
        `select planned_yield_pct, measured_yield_pct from measured_yield
          where department_code = 'STITCH'`,
      )
      expect(rows[0].planned_yield_pct).toBe(98)
      expect(rows[0].measured_yield_pct).toBeCloseTo(90, 5)
    })
  })

  it('shows a day worked against a day planned', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      const date = await firstWorkDate(c, 'STITCH')
      await declare(c, line, 'STITCH', 'COVER', date, 25)

      const { rows } = await c.query<{
        qty_planned: number
        qty_good: number
        variance: number
      }>(
        `select qty_planned, qty_good, variance from production_vs_plan
          where department_code = 'STITCH' and work_date = $1`,
        [date],
      )
      expect(rows[0].qty_good).toBe(25)
      expect(rows[0].variance).toBeCloseTo(25 - rows[0].qty_planned, 3)
    })
  })

  it('still reports a day that was worked with nothing planned', async () => {
    await withRollback(async (c) => {
      const line = await withOrder(c)
      // A Sunday, which no plan ever asks for. The full join is what keeps it
      // visible instead of dropping it as unmatched.
      await declare(c, line, 'STITCH', 'COVER', '2026-11-01', 12)

      const { rows } = await c.query<{ qty_planned: number; qty_good: number }>(
        `select qty_planned, qty_good from production_vs_plan
          where department_code = 'STITCH' and work_date = '2026-11-01'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].qty_planned).toBe(0)
      expect(rows[0].qty_good).toBe(12)
    })
  })
})

/** Seed, one order, one schedule run. Returns the shipment line id. */
async function withOrder(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
  await runSchedule(c)
  return firstLine(c)
}

async function firstWorkDate(c: pg.Client, department: string) {
  const { rows } = await c.query<{ work_date: string }>(
    `select work_date from production_worklist
      where department_code = $1 order by work_date limit 1`,
    [department],
  )
  return rows[0].work_date
}
