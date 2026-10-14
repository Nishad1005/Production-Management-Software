// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * A day a department has entered is over for that department (15 Oct).
 *
 * Found by the mock run: the evening run re-planned today's remainder onto
 * today, so a department that had declared half its target saw the day's
 * planned figure drop to meet what it made ("made 33 of 32, met"). Once a
 * declaration dated today exists for a department, today is a past day for
 * it: its loads for today are frozen from the previous run, and its work
 * that is behind starts the next working day. Departments that have entered
 * nothing today still work today.
 *
 * The seed's chair, 250 on 16 Nov: wood is due 17 Sept and plans 15 to 17
 * Sept, starting on the day the engine is told it is.
 */

const TODAY = '2026-09-15'

const loadOn = async (c: pg.Client, run: string, dept: string, date: string) =>
  Number(
    (
      await c.query<{ q: string }>(
        `select coalesce(sum(l.qty_planned), 0)::text as q
           from schedule_daily_load l
           join departments d on d.id = l.department_id
          where l.run_id = $1 and d.code = $2 and l.load_date = $3::date`,
        [run, dept, date],
      )
    ).rows[0].q,
  )

const tasksOf = async (c: pg.Client, run: string, dept: string) =>
  (
    await c.query<{ component: string; start_date: string | null; breach_reason: string | null }>(
      `select cmp.code as component, t.start_date::text as start_date,
              t.breach_reason::text as breach_reason
         from schedule_tasks t
         join departments d on d.id = t.department_id
         join components cmp on cmp.id = t.component_id
        where t.run_id = $1 and d.code = $2
        order by cmp.code`,
      [run, dept],
    )
  ).rows

describe('a day a department has entered', () => {
  it('keeps the morning plan for today and starts the remainder tomorrow', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const morning = await runSchedule(c, { today: TODAY })
      const planned = await loadOn(c, morning, 'WOOD', TODAY)
      expect(planned).toBeGreaterThan(0)
      expect((await tasksOf(c, morning, 'WOOD')).every((t) => t.start_date === TODAY)).toBe(true)

      // Six o'clock: the wood shop has entered some legs.
      await c.query(
        `select declare_production($1, 'WOOD', 'LEG', $2::date, 'GEN', 100)`,
        [line, TODAY],
      )
      const evening = await runSchedule(c, { today: TODAY })

      // Today's planned figure is what it was this morning, not what was made.
      expect(await loadOn(c, evening, 'WOOD', TODAY)).toBe(planned)
      // And what remains — every component the department makes — starts
      // tomorrow, not on a day that is over.
      const wood = await tasksOf(c, evening, 'WOOD')
      expect(wood.length).toBe(3)
      expect(wood.every((t) => t.start_date! > TODAY)).toBe(true)
    })
  })

  it('leaves today alone for a department that has entered nothing', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const morning = await runSchedule(c, { today: TODAY })
      // Assembly enters a figure today; wood, which has not, still works today.
      await c.query(
        `select declare_production($1, 'ASSY', 'CHAIR', $2::date, 'GEN', 1)`,
        [line, TODAY],
      )
      const evening = await runSchedule(c, { today: TODAY })
      expect((await tasksOf(c, evening, 'WOOD')).every((t) => t.start_date === TODAY)).toBe(true)
      expect(await loadOn(c, evening, 'WOOD', TODAY)).toBe(
        await loadOn(c, morning, 'WOOD', TODAY),
      )
    })
  })

  it('does not count a frozen day twice on the capacity grid', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      await runSchedule(c, { today: TODAY })
      await c.query(
        `select declare_production($1, 'WOOD', 'LEG', $2::date, 'GEN', 100)`,
        [line, TODAY],
      )
      const evening = await runSchedule(c, { today: TODAY })
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n
           from schedule_daily_capacity c
           join departments d on d.id = c.department_id
           join components cmp on cmp.id = c.component_id
          where c.run_id = $1 and d.code = 'WOOD' and cmp.code = 'LEG'
            and c.load_date = $2::date`,
        [evening, TODAY],
      )
      expect(Number(rows[0].n)).toBe(1)
    })
  })

  it('changes nothing when the engine is not told the day', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const line = await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      const before = await tasksOf(c, await runSchedule(c), 'WOOD')
      await c.query(
        `select declare_production($1, 'WOOD', 'LEG', $2::date, 'GEN', 100)`,
        [line, TODAY],
      )
      const after = await tasksOf(c, await runSchedule(c), 'WOOD')
      expect(after.map((t) => t.start_date)).toEqual(before.map((t) => t.start_date))
    })
  })
})

describe('the behind card', () => {
  it('says when the order was taken against the plan, and why', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 250, stuffingDate: '2026-11-16' })
      await c.query(
        `update orders set accepted_against_plan = true,
                           acceptance_note = 'Customer insists; overtime agreed'`,
      )
      // Told it is well past wood's start, the job is behind.
      await runSchedule(c, { today: '2026-10-10' })
      const { rows } = await c.query<{ detail: string }>(
        `select detail from attention_behind`,
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(
        rows.every((r) => r.detail.includes('taken against the plan: Customer insists')),
      ).toBe(true)
    })
  })
})
