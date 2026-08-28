// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Interim data, and the notice that stops it passing as real.
 *
 * U&M's live project holds their route and nothing else, which makes it
 * unusable for anything but looking at empty screens. Interim figures fix that
 * and create the risk this whole project is built against: an invented number
 * that looks normal.
 *
 * So two things need guarding. That the banner is on while the data is there,
 * and that removing it removes **exactly** what was added — the interim order
 * book and its production, and nothing a real user has entered since.
 */

const state = async (c: pg.Client) =>
  (
    await c.query<{
      is_provisional: boolean
      what: string | null
      order_prefix: string | null
      provisional_orders: number
    }>(`select * from provisional_state`)
  ).rows[0]

describe('the notice', () => {
  it('is off until something provisional is loaded', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const s = await state(c)
      expect(s.is_provisional).toBe(false)
      expect(s.what).toBeNull()
    })
  })

  it('comes on, and says what went in', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `select mark_provisional('Rates, D-minus and a twelve-order book')`,
      )
      const s = await state(c)
      expect(s.is_provisional).toBe(true)
      expect(s.what).toMatch(/twelve-order/)
      expect(s.order_prefix).toBe('PROV-')
    })
  })

  it('keeps one standing notice rather than a history', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select mark_provisional('first')`)
      await c.query(`select mark_provisional('second')`)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from provisional_load`,
      )
      // The question the banner answers is "is what I am looking at
      // confirmed", and that has one answer.
      expect(Number(rows[0].n)).toBe(1)
      expect((await state(c)).what).toBe('second')
    })
  })
})

describe('the purge', () => {
  async function loaded(c: pg.Client) {
    await applySeed(c)
    await c.query(`select mark_provisional('interim')`)

    // Two interim orders and one a real user entered afterwards.
    await createOrder(c, {
      erpOrderNo: 'PROV-0001',
      qty: 100,
      stuffingDate: '2026-12-01',
    })
    await createOrder(c, {
      erpOrderNo: 'PROV-0002',
      qty: 60,
      stuffingDate: '2026-12-10',
    })
    await createOrder(c, {
      erpOrderNo: 'SO/26-27/9001',
      qty: 40,
      stuffingDate: '2026-12-20',
    })
    await runSchedule(c)

    // Production against an interim order, which must go with it.
    const line = (
      await c.query<{ id: string }>(
        `select sl.id from shipment_lines sl
           join orders o on o.id = sl.order_id
          where o.erp_order_no = 'PROV-0001'`,
      )
    ).rows[0].id
    const component = (
      await c.query<{ component_code: string }>(
        `select component_code from schedule_gantt
          where department_code = 'WOOD' order by component_code limit 1`,
      )
    ).rows[0].component_code
    await c.query(
      `select declare_production($1, 'WOOD', $2, '2026-10-01', 'GEN', 30, 1)`,
      [line, component],
    )
  }

  it('removes the interim orders and everything recorded against them', async () => {
    await withRollback(async (c) => {
      await loaded(c)
      expect((await state(c)).provisional_orders).toBe(2)

      const gone = (
        await c.query<{ n: number }>(`select purge_provisional() as n`)
      ).rows[0].n
      expect(gone).toBe(2)

      const { rows } = await c.query<{ erp_order_no: string }>(
        `select erp_order_no from orders order by erp_order_no`,
      )
      // The real order is untouched. Anything else would make this command
      // unusable the moment somebody had entered something they cared about.
      expect(rows.map((r) => r.erp_order_no)).toEqual(['SO/26-27/9001'])

      // And the ledger against the interim order went with it, rather than
      // being left orphaned or — worse — counted in a KPI.
      const { rows: ledger } = await c.query<{ n: string }>(
        `select count(*) as n from production_declarations`,
      )
      expect(Number(ledger[0].n)).toBe(0)
    })
  })

  it('turns the banner off', async () => {
    await withRollback(async (c) => {
      await loaded(c)
      await c.query(`select purge_provisional()`)
      expect((await state(c)).is_provisional).toBe(false)
    })
  })

  it('leaves the masters alone, because they overwrite themselves', async () => {
    await withRollback(async (c) => {
      await loaded(c)
      const before = (
        await c.query<{ n: string }>(`select count(*) as n from component_rates`)
      ).rows[0].n

      await c.query(`select purge_provisional()`)

      // Rates and D-minus upsert by code, so PPC's sheet replaces them cell by
      // cell with nothing left behind. Deleting them here would throw away
      // anything real that had been entered alongside.
      const after = (
        await c.query<{ n: string }>(`select count(*) as n from component_rates`)
      ).rows[0].n
      expect(after).toBe(before)
    })
  })

  it('refuses when nothing is marked, rather than deleting on a guess', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, {
        erpOrderNo: 'PROV-LOOKALIKE',
        qty: 10,
        stuffingDate: '2026-12-01',
      })
      // An order that happens to start with the prefix is not a licence to
      // delete it. Without the marker there is no load to undo.
      await expect(c.query(`select purge_provisional()`)).rejects.toThrow(
        /nothing is marked provisional/,
      )
    })
  })
})
