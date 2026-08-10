// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { runSchedule } from './helpers/fixtures'
import {
  PROTOTYPE_DEPTS,
  PROTOTYPE_ORDERS,
  referenceLoad,
} from './helpers/reference-scheduler'

/**
 * Spec-level verification: the SQL engine must reproduce, exactly, the output of
 * the capacity-flagging prototype the client has already seen working.
 *
 * The prototype knows nothing about yields, components, multiple shifts or
 * holidays, so the fixture strips all four back to the conditions it assumed —
 * yield 100%, one component per department, one shift, Sundays the only closed
 * days. Any divergence after that is a real defect in one implementation or the
 * other, not a difference of modelling.
 */
async function buildPrototypeFixture(c: pg.Client) {
  // The prototype closes Sundays and nothing else.
  await c.query('delete from holidays')

  await c.query(
    `insert into shifts (code, name, start_time, end_time)
     values ('GEN', 'General', '09:00', '18:00')`,
  )

  await c.query(
    `insert into articles (code, name) values ('PROTO', 'Prototype article')`,
  )

  for (const [i, d] of PROTOTYPE_DEPTS.entries()) {
    // yield_pct 100: the prototype applies no yield inflation.
    await c.query(
      `insert into departments (code, name, route_position, yield_pct)
       values ($1, $2, $3, 100)`,
      [d.code, d.name, (i + 1) * 10],
    )
    await c.query(
      `insert into department_shifts (department_id, shift_id, sanctioned_headcount)
       values ((select id from departments where code = $1),
               (select id from shifts where code = 'GEN'), $2)`,
      [d.code, d.headcount],
    )
    // One component per department, one per finished unit, so the prototype's
    // department-level capacity maps straight onto a component rate.
    await c.query(`insert into components (code, name) values ($1, $1)`, [
      `C-${d.code}`,
    ])
    await c.query(
      `insert into article_bom (article_id, component_id, qty_per_unit)
       values ((select id from articles where code = 'PROTO'),
               (select id from components where code = $1), 1)`,
      [`C-${d.code}`],
    )
    await c.query(
      `insert into component_rates (component_id, department_id, shift_id, units_per_day)
       values ((select id from components where code = $1),
               (select id from departments where code = $2),
               (select id from shifts where code = 'GEN'), $3)`,
      [`C-${d.code}`, d.code, d.capacity],
    )
    await c.query(
      `update article_dept_dminus
          set dminus_days = $2, is_complete = true
        where department_id = (select id from departments where code = $1)`,
      [d.code, d.dminus],
    )
  }

  await c.query(
    `insert into customers (code, name) values ('PROTO-CUST', 'Prototype customer')`,
  )
}

async function addOrder(
  c: pg.Client,
  order: { id: string; qty: number; stuffingDate: string },
) {
  const { rows } = await c.query<{ id: string }>(
    `insert into orders (erp_order_no, customer_id, article_id, total_qty)
     values ($1,
             (select id from customers where code = 'PROTO-CUST'),
             (select id from articles where code = 'PROTO'), $2)
     returning id`,
    [`PROTO-${order.id}`, order.qty],
  )
  await c.query(
    `insert into shipment_lines (order_id, line_no, qty, stuffing_date)
     values ($1, 1, $2, $3)`,
    [rows[0].id, order.qty, order.stuffingDate],
  )
}

/** Engine output as department|date → planned quantity. */
async function engineLoad(c: pg.Client, run: string) {
  const { rows } = await c.query<{ code: string; d: string; qty: string }>(
    `select d.code, l.load_date::text as d, sum(l.qty_planned)::text as qty
       from schedule_daily_load l
       join departments d on d.id = l.department_id
      where l.run_id = $1
      group by d.code, l.load_date`,
    [run],
  )
  return new Map(rows.map((r) => [`${r.code}|${r.d}`, Number(r.qty)]))
}

function diff(a: Map<string, number>, b: Map<string, number>) {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  return keys
    .map((k) => ({ key: k, engine: a.get(k) ?? 0, reference: b.get(k) ?? 0 }))
    .filter((r) => Math.abs(r.engine - r.reference) > 0.001)
}

describe('parity with the capacity-flagging prototype', () => {
  it('reproduces the prototype’s own default scenario cell for cell', async () => {
    await withRollback(async (c) => {
      await buildPrototypeFixture(c)
      for (const order of PROTOTYPE_ORDERS) await addOrder(c, order)

      const run = await runSchedule(c)
      const engine = await engineLoad(c, run)
      const reference = referenceLoad(PROTOTYPE_ORDERS, PROTOTYPE_DEPTS)

      expect(diff(engine, reference)).toEqual([])
      expect(engine.size).toBe(reference.size)
    })
  })

  it('agrees across a range of quantities and dates', async () => {
    const scenarios = [
      { id: 'X', qty: 40, stuffingDate: '2026-11-02' },
      { id: 'Y', qty: 41, stuffingDate: '2026-11-03' },
      { id: 'Z', qty: 1000, stuffingDate: '2026-12-15' },
      // Stuffing on a Sunday: both must roll the due date back, not forward.
      { id: 'S', qty: 175, stuffingDate: '2026-09-06' },
      // Quantity landing exactly on a capacity boundary leaves no remainder.
      { id: 'E', qty: 120, stuffingDate: '2026-10-05' },
    ] as const

    for (const scenario of scenarios) {
      await withRollback(async (c) => {
        await buildPrototypeFixture(c)
        await addOrder(c, scenario)

        const run = await runSchedule(c)
        const engine = await engineLoad(c, run)
        const reference = referenceLoad([scenario], PROTOTYPE_DEPTS)

        expect(
          diff(engine, reference),
          `scenario ${scenario.id}: ${scenario.qty} units due ${scenario.stuffingDate}`,
        ).toEqual([])
      })
    }
  })

  it('puts the remainder on the earliest day, as the prototype does', async () => {
    await withRollback(async (c) => {
      await buildPrototypeFixture(c)
      // 100 units at 40/day: two full days and a 20-unit tail.
      await addOrder(c, { id: 'R', qty: 100, stuffingDate: '2026-11-02' })

      const run = await runSchedule(c)
      const { rows } = await c.query<{ d: string; qty: string }>(
        `select l.load_date::text as d, sum(l.qty_planned)::text as qty
           from schedule_daily_load l
           join departments dep on dep.id = l.department_id
          where l.run_id = $1 and dep.code = 'WOOD'
          group by l.load_date order by l.load_date`,
        [run],
      )

      expect(rows.map((r) => Number(r.qty))).toEqual([20, 40, 40])
    })
  })
})
