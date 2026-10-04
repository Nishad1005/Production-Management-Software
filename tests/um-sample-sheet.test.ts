// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  buildMasters,
  buildOrders,
  expectedConflicts,
  // @ts-expect-error — a plain .mjs script module, shared with the CLI loader.
} from '../scripts/lib/um-sample.mjs'
import { withRollback } from './helpers/db'
import { importMastersOnSeed } from './helpers/fixtures'

/**
 * U&M's own planning sheet, run through the engine.
 *
 * The first real data from the production management team was six rows of a
 * time-and-action sheet. This loads exactly that — through `import_masters`,
 * the same single call the hosted loader makes — and plans it, so what the
 * sheet does inside Kram is known before the live project is touched, and
 * stays known afterwards.
 *
 * What it guards is the translation. A loader that mapped a column onto the
 * wrong department, or dropped a checkpoint, or left a department without a
 * shift, would still produce a plan; it would simply be a plan of something
 * other than their sheet. Each assertion below is one way of that going wrong.
 */

type Sheet = {
  rows: { sku: string; qty: (number | null)[]; days: number[] }[]
  departments: { code: string; checkpoint?: boolean }[]
  steps: { departments: string[] }[]
}

const sheet: Sheet = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../scripts/data/um-sample-sheet.json', import.meta.url)),
    'utf8',
  ),
)

type Task = {
  erp_order_no: string
  article_code: string
  department_code: string
  line_qty: number
  qty_required: number
  due_date: string
  start_date: string | null
  end_date: string | null
  days_needed: number | null
  is_feasible: boolean
  breach_reason: string | null
}

/** Loads the sheet on top of the seed and plans it. */
async function planTheSheet(c: pg.Client) {
  await importMastersOnSeed(c, buildMasters(sheet))
  await c.query(`select rebuild_working_days('2026-06-01', '2027-03-31')`)

  const customer = (
    await c.query<{ id: string }>(
      `select create_customer('UM-SAMPLE', 'U&M sample dispatch plan') as id`,
    )
  ).rows[0].id

  const orders = buildOrders(sheet)
  for (const o of orders) {
    await c.query(
      `select create_order($1, $2, (select id from articles where code = $3),
                           $4, $5::date, 'confirmed', null, $6)`,
      [o.erp_order_no, customer, o.sku, o.qty, o.stuffing_date, o.container_ref],
    )
  }

  await c.query(
    `select run_schedule(array['confirmed','probable']::order_confidence[],
                         true, 'U&M sample sheet')`,
  )

  const tasks = (
    await c.query<Task>(
      `select erp_order_no, article_code, department_code, line_qty, qty_required,
              due_date, start_date, end_date, days_needed, is_feasible,
              breach_reason::text as breach_reason
         from schedule_gantt
        where run_id = current_run_id()
        order by erp_order_no, route_position`,
    )
  ).rows
  return { orders, tasks }
}

describe("U&M's sample sheet, planned", () => {
  it('schedules every dispatch through every step on the sheet', async () => {
    await withRollback(async (c) => {
      const { orders, tasks } = await planTheSheet(c)

      // Six rows carry eleven quantities; each goes through twenty departments —
      // the seventeen columns, three of which are two departments apiece.
      expect(orders).toHaveLength(11)
      expect(tasks).toHaveLength(orders.length * sheet.departments.length)

      // The department that silently vanishes for want of a shift row: every
      // one of the twenty must appear for every order.
      const perOrder = new Map<string, Set<string>>()
      for (const t of tasks) {
        if (!perOrder.has(t.erp_order_no)) perOrder.set(t.erp_order_no, new Set())
        perOrder.get(t.erp_order_no)!.add(t.department_code)
      }
      for (const [, seen] of perOrder) expect(seen.size).toBe(sheet.departments.length)
    })
  })

  it('puts each step on the day the sheet gives it', async () => {
    await withRollback(async (c) => {
      const { orders, tasks } = await planTheSheet(c)
      const dateOf = new Map<string, string>(
        orders.map((o: { erp_order_no: string; stuffing_date: string }) => [o.erp_order_no, o.stuffing_date]),
      )
      const rowOf = new Map(
        orders.map((o: { erp_order_no: string; sku: string }) => [o.erp_order_no, sheet.rows.find((r) => r.sku === o.sku)!]),
      )
      const working = new Map<string, boolean>(
        (
          await c.query<{ day: string; is_working: boolean }>(
            `select calendar_date::text as day, is_working from working_days
              where calendar_date between '2026-07-01' and '2026-11-30'`,
          )
        ).rows.map((r) => [r.day, r.is_working]),
      )
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

      for (const t of tasks) {
        const row = rowOf.get(t.erp_order_no)!
        const step = sheet.steps.findIndex((s) => s.departments.includes(t.department_code))
        const anchor = Date.parse(`${dateOf.get(t.erp_order_no)}T00:00:00Z`)
        const target = anchor - row.days[step] * 86_400_000
        const due = Date.parse(`${t.due_date}T00:00:00Z`)
        const where = `${t.erp_order_no} ${t.department_code}`

        // The sheet's day, or the last working day before it. Not a tolerance
        // of "a day or so": a first version allowed one day for a Sunday and
        // failed on a holiday that fell on the Monday after one. So the rule is
        // stated as it is — never later than the sheet says, itself a working
        // day, and nothing but closed days in between.
        expect(due, where).toBeLessThanOrEqual(target)
        expect(working.get(iso(due)), `${where} is due on a closed day`).toBe(true)
        for (let d = due + 86_400_000; d <= target; d += 86_400_000) {
          expect(working.get(iso(d)), `${where} skipped a working day`).toBe(false)
        }
      }
    })
  })

  it('treats a checkpoint as a deadline: one day, and never the cause of a breach', async () => {
    await withRollback(async (c) => {
      const { tasks } = await planTheSheet(c)
      const checkpoints = new Set(
        sheet.departments.filter((d) => d.checkpoint).map((d) => d.code),
      )
      const gates = tasks.filter((t) => checkpoints.has(t.department_code))
      expect(gates.length).toBeGreaterThan(0)
      for (const g of gates) {
        expect(g.days_needed, `${g.erp_order_no} ${g.department_code}`).toBe(1)
        expect(g.is_feasible, `${g.erp_order_no} ${g.department_code}`).toBe(true)
      }
    })
  })

  it('fails only for want of days — never for a missing figure', async () => {
    await withRollback(async (c) => {
      const { tasks } = await planTheSheet(c)
      const reasons = new Set(
        tasks.filter((t) => !t.is_feasible).map((t) => t.breach_reason),
      )
      // `runway` is the sheet's own arithmetic meeting forty a day: the gap it
      // leaves a department is shorter than the quantity needs. Any other
      // reason would mean the *load* was incomplete — a missing rate, a blank
      // D-minus, a date outside the calendar — and that is this loader's fault,
      // not the sheet's.
      for (const r of reasons) expect(r).toBe('runway')
    })
  })

  it('reports the equal days the sheet contains, and nothing it does not', async () => {
    await withRollback(async (c) => {
      await planTheSheet(c)
      const { rows } = await c.query<{ article_code: string; later_department_code: string }>(
        `select article_code, later_department_code from route_order_conflicts
          order by article_code, later_department_code`,
      )
      const reported = rows.map((r) => `${r.article_code}|${r.later_department_code}`)

      const expected = [
        ...new Set(
          expectedConflicts(sheet).map(
            (x: { sku: string; department: string }) => `${x.sku}|${x.department}`,
          ),
        ),
      ].sort()

      // The fixture must contain some, or this compares two empty lists.
      expect(expected.length).toBeGreaterThan(0)
      expect(reported.sort()).toEqual(expected)
    })
  })

  it('writes what it found, when asked to', async () => {
    // Not an assertion — the dry run's report. Set UM_SAMPLE_DUMP to a path and
    // the plan is written there for a person to read before the live load.
    const out = process.env.UM_SAMPLE_DUMP
    if (!out) return
    await withRollback(async (c) => {
      const { orders, tasks } = await planTheSheet(c)
      const conflicts = (
        await c.query(
          `select article_code, earlier_department_code, earlier_dminus,
                  later_department_code, later_dminus, affects_scheduling
             from route_order_conflicts order by article_code, later_department_code`,
        )
      ).rows
      const flagged = (
        await c.query(
          `select department_code, load_date, round(utilisation::numeric, 2) as utilisation
             from schedule_flag_triage where run_id = current_run_id()
            order by load_date, department_code`,
        )
      ).rows
      const run = (
        await c.query(
          `select task_count, breach_count, duration_ms, horizon_from::text, horizon_to::text
             from schedule_runs where is_current`,
        )
      ).rows[0]
      writeFileSync(out, JSON.stringify({ run, orders, tasks, conflicts, flagged }, null, 1))
      expect(tasks.length).toBeGreaterThan(0)
    })
  })
})
