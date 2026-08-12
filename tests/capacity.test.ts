// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The capacity sheet is how PPC enters the real figures. It writes into the same
 * tables the engine already reads, so a cell filled here has to schedule exactly
 * as a hand-built component would.
 */

describe('a capacity cell', () => {
  it('creates the component, the BOM row and a rate on every working shift', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('NEW-CHAIR', 'New chair')`,
      )

      await c.query(`select set_capacity_cell('NEW-CHAIR', 'STITCH', 45, 6)`)

      const { rows } = await c.query<{
        units_per_day: string
        manpower: number
        shift_code: string
      }>(
        `select cr.units_per_day::text, cr.manpower, s.code as shift_code
           from component_rates cr
           join components cmp on cmp.id = cr.component_id
           join shifts s on s.id = cr.shift_id
          where cmp.code = 'NEW-CHAIR::STITCH'`,
      )

      expect(rows).toHaveLength(1)
      expect(Number(rows[0].units_per_day)).toBe(45)
      expect(rows[0].manpower).toBe(6)
      expect(rows[0].shift_code).toBe('GEN')

      const { rows: bom } = await c.query<{ qty: string }>(
        `select qty_per_unit::text as qty from bom_master
          where article_code = 'NEW-CHAIR' and component_code = 'NEW-CHAIR::STITCH'`,
      )
      expect(Number(bom[0].qty)).toBe(1)
    })
  })

  it('lands on both shifts when a department works two', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('NEW-CHAIR', 'New chair')`,
      )
      await c.query(
        `select set_shift_active((select id from shifts where code = 'A'), true)`,
      )
      await c.query(`select set_department_shift('STITCH', 'A', true)`)

      await c.query(`select set_capacity_cell('NEW-CHAIR', 'STITCH', 45, 6)`)

      const { rows } = await c.query<{ shift_code: string }>(
        `select s.code as shift_code
           from component_rates cr
           join components cmp on cmp.id = cr.component_id
           join shifts s on s.id = cr.shift_id
          where cmp.code = 'NEW-CHAIR::STITCH' order by s.code`,
      )
      expect(rows.map((r) => r.shift_code)).toEqual(['A', 'GEN'])
    })
  })

  it('clearing it takes the article out of that department', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('NEW-CHAIR', 'New chair')`,
      )
      await c.query(`select set_capacity_cell('NEW-CHAIR', 'STITCH', 45, 6)`)
      await c.query(`select set_capacity_cell('NEW-CHAIR', 'STITCH', null)`)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from component_rates cr
           join components cmp on cmp.id = cr.component_id
          where cmp.code = 'NEW-CHAIR::STITCH'`,
      )
      expect(Number(rows[0].n)).toBe(0)

      // The component survives, because WIP recorded against it would not.
      const { rows: comp } = await c.query<{ n: string }>(
        `select count(*) as n from components where code = 'NEW-CHAIR::STITCH'`,
      )
      expect(Number(comp[0].n)).toBe(1)
    })
  })

  it('refuses an article or department that does not exist', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_capacity_cell('NOPE', 'STITCH', 10)`),
      ).rejects.toThrow(/No such article/)
    })
  })
})

describe('the capacity sheet view', () => {
  it('shows every article against every department, blanks included', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from capacity_sheet`,
      )
      // One article, four departments in the placeholder route.
      expect(Number(rows[0].n)).toBe(4)

      const { rows: blank } = await c.query<{ n: string }>(
        `select count(*) as n from capacity_sheet where units_per_day is null`,
      )
      // The seeded article is only worked by the departments that have rates,
      // and those rates are on named components, not stage components.
      expect(Number(blank[0].n)).toBe(4)
    })
  })

  it('carries the D-minus alongside, so one grid holds both', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{
        department_code: string
        dminus_days: number
        dminus_complete: boolean
      }>(
        `select department_code, dminus_days, dminus_complete
           from capacity_sheet where article_code = 'AARA-LC'
          order by route_position`,
      )
      expect(rows.map((r) => r.dminus_days)).toEqual([60, 50, 40, 25])
      expect(rows.every((r) => r.dminus_complete)).toBe(true)
    })
  })
})

describe('a cell entered on the sheet', () => {
  it('schedules exactly as a hand-built component does', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('SHEET-CHAIR', 'Sheet chair')`,
      )

      // Stitching only, 30 a day — the same rate the seeded article uses.
      await c.query(`select set_capacity_cell('SHEET-CHAIR', 'STITCH', 30, 12)`)
      await c.query(`select set_dminus('SHEET-CHAIR', 'STITCH', 40)`)

      await createOrder(c, {
        erpOrderNo: 'SO-SHEET',
        articleCode: 'SHEET-CHAIR',
        qty: 100,
        stuffingDate: '2026-12-01',
      })
      const run = await runSchedule(c)

      const { rows } = await c.query<{
        department_code: string
        days_needed: number
        is_feasible: boolean
      }>(
        `select department_code, days_needed, is_feasible
           from schedule_gantt
          where run_id = $1 and erp_order_no = 'SO-SHEET'`,
        [run],
      )

      expect(rows).toHaveLength(1)
      expect(rows[0].department_code).toBe('STITCH')
      // 100 units inflated for stitching's own yield, at 30 a day.
      expect(rows[0].days_needed).toBe(4)
      expect(rows[0].is_feasible).toBe(true)
    })
  })
})
