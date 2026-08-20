// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Phase 10 — prediction.
 *
 * Built after a disagreement worth recording: I recommended measuring before
 * modelling, because the live project holds no production history and a model
 * trained on nothing is a confident wrong one rather than a cautious one.
 * Nishad chose to build the models. These tests are the condition that came
 * with that — **nothing states a figure without stating what it is based on**.
 *
 * So the most important test here is the one that proves it refuses. A
 * prediction that always produces a number is the failure mode; one that says
 * "too few to say" on nine observations and speaks on ten is the requirement.
 */

async function declaring(c: pg.Client) {
  await applySeed(c)
  await createOrder(c, { qty: 500, stuffingDate: '2026-12-01' })
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
  return { line, component }
}

/**
 * One declaration per day, which is one observation per day.
 *
 * `from` matters: declare_production corrects a day rather than adding to it,
 * so a second call starting at the same date overwrites the first day instead
 * of extending the run — which looked like the threshold being off by one.
 */
async function declareDays(
  c: pg.Client,
  line: string,
  component: string,
  days: number,
  qty = 40,
  from = 0,
) {
  for (let i = from; i < from + days; i++) {
    const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)
    await c.query(
      `select declare_production($1, 'WOOD', $2, $3::date, 'GEN', $4, 0)`,
      [line, component, date, qty],
    )
  }
}

const measured = async (c: pg.Client) =>
  (
    await c.query<{
      observations: number
      standing_rate: number | null
      measured_rate: number | null
      against_plan_pct: number | null
      confidence: string
    }>(`select * from measured_rate where department_code = 'WOOD'`)
  ).rows[0]

describe('a prediction refuses before it guesses', () => {
  it('says too few to say on nine days, and speaks on ten', async () => {
    await withRollback(async (c) => {
      const { line, component } = await declaring(c)

      await declareDays(c, line, component, 9)
      const thin = await measured(c)
      expect(thin.observations).toBe(9)
      expect(thin.confidence).toBe('too few to say')
      // The count is there; the figure is not. A screen can say "nine days so
      // far" honestly, and cannot say "44 a day" from nine days.
      expect(thin.measured_rate).toBeNull()
      expect(thin.against_plan_pct).toBeNull()

      await declareDays(c, line, component, 1, 40, 9)
      const enough = await measured(c)
      expect(enough.observations).toBe(10)
      expect(enough.confidence).toBe('measured')
      expect(enough.measured_rate).not.toBeNull()
    })
  })

  it('keeps the threshold in one place', async () => {
    await withRollback(async (c) => {
      const { rows } = await c.query<{ t: number }>(
        `select forecast_threshold() as t`,
      )
      // A judgement rather than a statistical result, and one that has to be
      // arguable — which means it must live somewhere a person can find it.
      expect(rows[0].t).toBe(10)
    })
  })
})

describe('measured against claimed', () => {
  it('reports the gap without touching the master', async () => {
    await withRollback(async (c) => {
      const { line, component } = await declaring(c)
      const before = (
        await c.query<{ units_per_day: string }>(
          `select units_per_day::text from component_rates cr
             join components c on c.id = cr.component_id
            where c.code = $1`,
          [component],
        )
      ).rows[0].units_per_day

      await declareDays(c, line, component, 12, 20)
      const m = await measured(c)
      expect(m.confidence).toBe('measured')
      expect(m.measured_rate).toBe(20)

      // The standing rate is untouched. A master that edits itself is one
      // nobody can account for, and a rate that drifted on its own would move
      // every date in the system with no entry anywhere saying why.
      const after = (
        await c.query<{ units_per_day: string }>(
          `select units_per_day::text from component_rates cr
             join components c on c.id = cr.component_id
            where c.code = $1`,
          [component],
        )
      ).rows[0].units_per_day
      expect(after).toBe(before)
      expect(m.standing_rate).toBe(Number(before))
    })
  })

  it('states the gap as a percentage of the claim', async () => {
    await withRollback(async (c) => {
      const { line, component } = await declaring(c)
      const rate = Number(
        (
          await c.query<{ units_per_day: string }>(
            `select units_per_day::text from component_rates cr
               join components c on c.id = cr.component_id
              where c.code = $1`,
            [component],
          )
        ).rows[0].units_per_day,
      )

      // Achieving exactly half of what the master claims.
      await declareDays(c, line, component, 10, rate / 2)
      const m = await measured(c)
      expect(m.against_plan_pct).toBeCloseTo(-50, 1)
    })
  })
})

describe('shipment risk', () => {
  const risk = async (c: pg.Client) =>
    (
      await c.query<{
        band: string
        because: string
        observations: number
        work_done_pct: number | null
        window_elapsed_pct: number | null
      }>(`select * from shipment_risk`)
    ).rows[0]

  it('bands rather than scores, and says why', async () => {
    await withRollback(async (c) => {
      await declaring(c)
      const r = await risk(c)
      // Bands, not percentages: a percentage would be read as a probability,
      // and it would be a number invented to look like one.
      expect(['on track', 'at risk', 'likely late', 'not started']).toContain(r.band)
      expect(r.because.length).toBeGreaterThan(10)
    })
  })

  it('calls a line likely late when the plan already cannot be made', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Far too much, far too soon: the engine cannot schedule it.
      await createOrder(c, {
        erpOrderNo: 'SO-RUSH',
        qty: 9000,
        stuffingDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      })
      await runSchedule(c)

      const rows = (
        await c.query<{ band: string; infeasible: number }>(
          `select band, infeasible from shipment_risk where erp_order_no = 'SO-RUSH'`,
        )
      ).rows
      expect(rows[0].infeasible).toBeGreaterThan(0)
      expect(rows[0].band).toBe('likely late')
    })
  })
})

describe('readiness comes first', () => {
  it('counts the history that exists, and the line it has to clear', async () => {
    await withRollback(async (c) => {
      const { line, component } = await declaring(c)

      const empty = (
        await c.query<{
          declarations: number
          days_recorded: number
          rates_measured: number
          threshold: number
        }>(`select * from forecast_readiness`)
      ).rows[0]
      // Nothing declared: every model above is silent, and this is the view
      // that says so rather than leaving four blank panels to look broken.
      expect(empty.declarations).toBe(0)
      expect(empty.rates_measured).toBe(0)
      expect(empty.threshold).toBe(10)

      await declareDays(c, line, component, 11)
      const some = (
        await c.query<{
          declarations: number
          days_recorded: number
          rates_measured: number
          rates_seen: number
        }>(`select * from forecast_readiness`)
      ).rows[0]
      expect(some.declarations).toBe(11)
      expect(some.days_recorded).toBe(11)
      expect(some.rates_measured).toBe(1)
      expect(some.rates_seen).toBe(1)
    })
  })
})
