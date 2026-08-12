// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * The route is a graph. route_position orders the display; department_
 * dependencies says what must finish before what.
 *
 * The seed declares a single line — wood → fabric cutting → stitching →
 * assembly — because the parity harness reproduces a single-line prototype.
 * Every test here departs from it deliberately, which is the only way to show
 * the graph is being walked rather than the positions being read.
 */

type Task = {
  component_code: string
  department_code: string
  start_date: string | null
  due_date: string | null
  qty_required: number
  breach_reason: string | null
}

const tasks = async (c: pg.Client, run: string) =>
  (
    await c.query<Task>(
      `select component_code, department_code, start_date, due_date,
              qty_required, breach_reason
         from schedule_gantt where run_id = $1
        order by route_position, component_code`,
      [run],
    )
  ).rows

const dep = (c: pg.Client, department: string, feeder: string, on: boolean) =>
  c.query(`select set_department_dependency($1, $2, $3)`, [
    department,
    feeder,
    on,
  ])

describe('cumulative yield follows the material, not the positions', () => {
  /**
   * The defect this file exists for. A wooden leg is made in Wood and goes into
   * the chair at Assembly. It never enters Fabric Cutting or Stitching, so it
   * must not be inflated by their losses — but "every department after this one"
   * read as every higher route_position, and charged it for both.
   */
  it('charges a component only for the departments its material passes through', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      // As seeded — a single line, so the leg carries all four yields.
      const before = await tasks(c, await runSchedule(c))
      const legBefore = before.find((t) => t.component_code === 'LEG')!
      expect(legBefore.qty_required).toBeCloseTo(
        (100 * 4) / (0.98 * 0.97 * 0.98 * 0.99),
        3,
      )
      expect(legBefore.qty_required).toBeCloseTo(433.711, 3)

      // Say what is actually true: wood feeds assembly directly, and fabric
      // cutting is an entry point rather than something wood hands over to.
      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'ASSY', 'WOOD', true)

      const after = await tasks(c, await runSchedule(c))
      const legAfter = after.find((t) => t.component_code === 'LEG')!
      expect(legAfter.qty_required).toBeCloseTo((100 * 4) / (0.98 * 0.99), 3)
      expect(legAfter.qty_required).toBeCloseTo(412.286, 3)

      // 21 legs a hundred chairs that never needed making.
      expect(legBefore.qty_required - legAfter.qty_required).toBeCloseTo(21.43, 1)
    })
  })

  it('leaves the components that do pass through those departments alone', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'ASSY', 'WOOD', true)

      const after = await tasks(c, await runSchedule(c))
      // A fabric panel really is cut, stitched into a cover and assembled, so
      // its three yields stand. Only the path wood takes changed.
      expect(
        after.find((t) => t.component_code === 'FAB-PANEL')!.qty_required,
      ).toBeCloseTo((100 * 6) / (0.97 * 0.98 * 0.99), 3)
      expect(
        after.find((t) => t.component_code === 'CHAIR')!.qty_required,
      ).toBeCloseTo(100 / 0.99, 3)
    })
  })

  it('counts a department once when two branches rejoin', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      // A diamond: wood and fabric cutting both feed stitching and both reach
      // assembly through it. Assembly's yield must be applied once, not twice.
      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'STITCH', 'WOOD', true)

      const after = await tasks(c, await runSchedule(c))
      expect(
        after.find((t) => t.component_code === 'LEG')!.qty_required,
      ).toBeCloseTo((100 * 4) / (0.98 * 0.98 * 0.99), 3)
    })
  })

  it('skips a department the article never reaches, however the graph runs', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into articles (code, name) values ('ONEDEPT', 'Stitched only')`,
      )
      // Routed through stitching alone. Assembly is downstream of stitching in
      // the graph, but this article never gets there, so it loses nothing to it.
      await c.query(`select set_capacity_cell('ONEDEPT', 'STITCH', 30)`)
      await c.query(`select set_dminus('ONEDEPT', 'STITCH', 40)`)
      await createOrder(c, {
        articleCode: 'ONEDEPT',
        qty: 100,
        stuffingDate: '2026-12-01',
      })

      const rows = await tasks(c, await runSchedule(c))
      const stitch = rows.find((t) => t.department_code === 'STITCH')!
      expect(stitch.qty_required).toBeCloseTo(100 / 0.98, 3)
    })
  })
})

describe('the runway check follows the graph', () => {
  /**
   * The false breach. Fabric cutting due before wood, while sitting after it in
   * the route, made the engine hold it behind work not due for another ten days.
   * Saying they are parallel is the answer, and it has to be sayable.
   */
  it('stops holding a feeder behind a line it does not touch', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 70)`)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const before = await tasks(c, await runSchedule(c))
      expect(
        before.find((t) => t.department_code === 'FABCUT')!.breach_reason,
      ).toBe('runway')

      // Fabric cutting is an entry point: nothing feeds it.
      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'STITCH', 'WOOD', true)

      const after = await tasks(c, await runSchedule(c))
      expect(
        after.find((t) => t.department_code === 'FABCUT')!.breach_reason,
      ).toBeNull()
    })
  })

  it('holds a department behind the latest of its feeders, not the nearest position', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      // Two entry points feeding stitching. Wood is due D-60; fabric cutting is
      // pushed to D-42, which lands after stitching would otherwise start.
      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'STITCH', 'WOOD', true)
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 42)`)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })

      const both = await tasks(c, await runSchedule(c))
      const stitch = both.find((t) => t.department_code === 'STITCH')!
      // The later feeder governs, so stitching cannot start when it wants to.
      expect(stitch.breach_reason).toBe('runway')

      // Drop the later feeder and only wood is left, twenty days earlier —
      // nothing to wait for, and the breach goes with it.
      await dep(c, 'STITCH', 'FABCUT', false)
      const woodOnly = await tasks(c, await runSchedule(c))
      expect(
        woodOnly.find((t) => t.department_code === 'STITCH')!.breach_reason,
      ).toBeNull()
    })
  })

  it('raises nothing for a department with nothing upstream of it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      const rows = await tasks(c, await runSchedule(c))
      // Wood is the head of the seeded line and has no ancestors.
      expect(
        rows.find((t) => t.department_code === 'WOOD')!.breach_reason,
      ).toBeNull()
    })
  })
})

describe('the graph refuses to stop being one', () => {
  it('refuses an edge that closes a loop', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Assembly is already downstream of wood, so wood waiting on assembly
      // would mean each waits for the other.
      await expect(dep(c, 'WOOD', 'ASSY', true)).rejects.toThrow(/cycle/)
    })
  })

  it('refuses a department that feeds itself', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(dep(c, 'WOOD', 'WOOD', true)).rejects.toThrow()
    })
  })

  it('allows a diamond, which is not a loop', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await dep(c, 'FABCUT', 'WOOD', false)
      await dep(c, 'STITCH', 'WOOD', true)
      // Wood and fabric cutting both reach assembly through stitching. Two paths
      // to the same place is exactly what the graph is for.
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from department_dependencies`,
      )
      expect(Number(rows[0].n)).toBe(3)
    })
  })
})

describe('the seeded graph', () => {
  it('is the single line the parity harness depends on', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ d: string; f: string }>(
        `select d.code as d, f.code as f
           from department_dependencies dd
           join departments d on d.id = dd.department_id
           join departments f on f.id = dd.depends_on_department_id
          order by d.route_position`,
      )
      expect(rows).toEqual([
        { d: 'FABCUT', f: 'WOOD' },
        { d: 'STITCH', f: 'FABCUT' },
        { d: 'ASSY', f: 'STITCH' },
      ])
    })
  })
})
