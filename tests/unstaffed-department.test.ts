// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * A department with no shift is dropped from every plan, silently.
 *
 * Found on the live project rather than here: the command centre reported a
 * completed run of 24 tasks where twelve shipment lines through fourteen
 * departments should have been 168. Twelve departments had no row in
 * `department_shifts`, the engine's `_pair` inner-joins that table, and so they
 * produced no task, no capacity, no load and no breach. Nothing said so. The
 * run succeeded, the Gantt drew bars, and `article_master.can_schedule` was
 * true for every article because the D-minus matrix was complete.
 *
 * The first test here is the defect, stated as behaviour rather than fixed —
 * because it is not a bug in the engine. A department nobody works in really
 * does not produce anything. What was missing was anyone being told.
 */

/** Removes a department's shift, as the live project had it. */
async function unstaff(c: pg.Client, code: string) {
  await c.query(
    `delete from department_shifts ds
       using departments d
      where d.id = ds.department_id and d.code = $1`,
    [code],
  )
}

const findings = async (c: pg.Client) =>
  (
    await c.query<{ title: string; detail: string; severity: string }>(
      `select title, detail, severity from attention_department_unstaffed order by title`,
    )
  ).rows

describe('set_headcount creates the pairing it is setting', () => {
  it('gives a department its first shift instead of doing nothing', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await unstaff(c, 'WOOD')

      // This used to be an UPDATE with no INSERT: it matched no row, changed
      // nothing, and returned successfully. Fourteen such calls on the live
      // project reported success and created two rows.
      await c.query(`select set_headcount('WOOD', 'GEN', 12)`)

      const { rows } = await c.query<{ sanctioned_headcount: number; is_active: boolean }>(
        `select ds.sanctioned_headcount, ds.is_active
           from department_shifts ds
           join departments d on d.id = ds.department_id
          where d.code = 'WOOD'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].sanctioned_headcount).toBe(12)
      expect(rows[0].is_active).toBe(true)
    })
  })

  it('still updates one that already exists', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_headcount('WOOD', 'GEN', 33)`)
      await c.query(`select set_headcount('WOOD', 'GEN', 34)`)

      const { rows } = await c.query<{ n: string; headcount: number }>(
        `select count(*) as n, max(ds.sanctioned_headcount) as headcount
           from department_shifts ds
           join departments d on d.id = ds.department_id
          where d.code = 'WOOD'`,
      )
      expect(Number(rows[0].n)).toBe(1)
      expect(rows[0].headcount).toBe(34)
    })
  })
})

describe('a department with no shift', () => {
  it('vanishes from the plan without raising anything', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })

      await runSchedule(c)
      const before = (
        await c.query<{ wood: string; breaches: string }>(
          `select (select count(*) from schedule_gantt
                    where run_id = current_run_id() and department_code = 'WOOD') as wood,
                  (select count(*) from schedule_gantt
                    where run_id = current_run_id() and not is_feasible) as breaches`,
        )
      ).rows[0]
      expect(Number(before.wood)).toBeGreaterThan(0)

      await unstaff(c, 'WOOD')
      await runSchedule(c)
      const after = (
        await c.query<{ wood: string; breaches: string }>(
          `select (select count(*) from schedule_gantt
                    where run_id = current_run_id() and department_code = 'WOOD') as wood,
                  (select count(*) from schedule_gantt
                    where run_id = current_run_id() and not is_feasible) as breaches`,
        )
      ).rows[0]

      // Gone completely, and not as a breach — as an absence. This is the shape
      // of the defect: the plan does not become infeasible, it becomes smaller,
      // and a smaller plan looks exactly like a plan. The breach count is
      // unchanged, so losing an entire department raised nothing at all.
      expect(Number(after.wood)).toBe(0)
      expect(Number(after.breaches)).toBe(Number(before.breaches))
    })
  })

  it('is named on the attention screen, since the plan will not name it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect(await findings(c)).toEqual([])

      await unstaff(c, 'WOOD')
      const raised = await findings(c)
      expect(raised).toHaveLength(1)
      expect(raised[0].severity).toBe('critical')
      expect(raised[0].title).toMatch(/nobody on any shift/)
      // It has to say what is being left out, not merely that something is.
      expect(raised[0].detail).toMatch(/components have a rate here/)
    })
  })

  it('clears the moment somebody is put on a shift, and the work comes back', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      await unstaff(c, 'WOOD')
      expect(await findings(c)).toHaveLength(1)

      await c.query(`select set_headcount('WOOD', 'GEN', 8)`)
      expect(await findings(c)).toEqual([])

      await runSchedule(c)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) n from schedule_gantt
          where run_id = current_run_id() and department_code = 'WOOD'`,
      )
      expect(Number(rows[0].n)).toBeGreaterThan(0)
    })
  })

  it('says nothing about a department that carries no rates', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into departments (code, name, route_position) values ('NEW', 'Not yet used', 500)`,
      )
      // On the route in name only. Nothing is routed through it, so nothing is
      // being lost, and an alert here would be noise on every new department
      // anybody creates.
      expect(await findings(c)).toEqual([])
    })
  })
})
