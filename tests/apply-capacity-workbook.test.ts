// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { becomeUser, createUser, withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

/**
 * `apply_capacity_workbook` against the two functions it replaces.
 *
 * The screen's single edits write one cell at a time with `set_capacity_cell`
 * and `set_dminus`. The workbook writes the whole file in one call, as sets.
 * The two must land exactly the same rows — the component, its BOM row, a rate
 * on every active shift, the crew, the offset — or a figure loaded from the
 * sheet means something different from the same figure typed into the grid.
 * So: the same cells both ways, every table snapshotted by natural key, and
 * compared.
 *
 * Then the guarantees the one-call form adds: nothing half-loaded, and every
 * refusal in a sentence a person can act on.
 */

type Cell = {
  article_code: string
  department_code: string
  units: number | null
  manpower: number | null
  dminus: number | null
}

const CELLS: Cell[] = [
  { article_code: 'AARA-LC', department_code: 'WOOD', units: 44, manpower: 5, dminus: 70 },
  { article_code: 'AARA-LC', department_code: 'STITCH', units: 38, manpower: 12, dminus: 30 },
  { article_code: 'AARA-LC', department_code: 'ASSY', units: 20, manpower: null, dminus: null },
  { article_code: 'AARA-LC', department_code: 'FABCUT', units: null, manpower: null, dminus: 55 },
]

const file = (cells: Cell[]) => ({ kram_capacity: 1, cells })

async function apply(c: pg.Client, payload: unknown) {
  const { rows } = await c.query<{ r: { rates: number; dminus: number } }>(
    `select apply_capacity_workbook($1::jsonb) as r`,
    [JSON.stringify(payload)],
  )
  return rows[0].r
}

/** Runs the call expecting it to fail, inside a savepoint, and returns the message. */
async function refused(c: pg.Client, payload: unknown): Promise<string> {
  await c.query('savepoint probe')
  try {
    await apply(c, payload)
    await c.query('release savepoint probe')
    return ''
  } catch (error) {
    await c.query('rollback to savepoint probe')
    return error instanceof Error ? error.message : String(error)
  }
}

/** Cell by cell, as the grid does it. */
async function replay(c: pg.Client, cells: Cell[]) {
  for (const cell of cells) {
    if (cell.units === null) continue
    await c.query(`select set_capacity_cell($1, $2, $3, $4)`, [
      cell.article_code,
      cell.department_code,
      cell.units,
      cell.manpower,
    ])
  }
  for (const cell of cells) {
    if (cell.dminus === null) continue
    await c.query(`select set_dminus($1, $2, $3)`, [
      cell.article_code,
      cell.department_code,
      cell.dminus,
    ])
  }
}

/** Every table either path touches, by natural key, no ids and no timestamps. */
async function snapshot(c: pg.Client) {
  const q = async (sql: string) => (await c.query(sql)).rows
  return {
    sheet: await q(
      `select article_code, department_code, units_per_day::text as units, manpower,
              dminus_days, dminus_complete
         from capacity_sheet order by article_code, route_position`,
    ),
    components: await q(
      `select code, name, uom from components where code like '%::%' order by code`,
    ),
    bom: await q(
      `select a.code as article, cmp.code as component, b.qty_per_unit::text as qty
         from article_bom b
         join articles a on a.id = b.article_id
         join components cmp on cmp.id = b.component_id
        where cmp.code like '%::%' order by 1, 2`,
    ),
    rates: await q(
      `select cmp.code as component, d.code as department, s.code as shift,
              cr.units_per_day::text as units, cr.manpower
         from component_rates cr
         join components cmp on cmp.id = cr.component_id
         join departments d on d.id = cr.department_id
         join shifts s on s.id = cr.shift_id
        where cmp.code like '%::%' order by 1, 2, 3`,
    ),
    dminus: await q(
      `select a.code as article, d.code as department, adm.dminus_days, adm.is_complete
         from article_dept_dminus adm
         join articles a on a.id = adm.article_id
         join departments d on d.id = adm.department_id
        order by 1, 2`,
    ),
  }
}

describe('the workbook lands exactly what the grid would', () => {
  it('matches set_capacity_cell and set_dminus, table for table', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      await c.query('savepoint grid')
      await replay(c, CELLS)
      const byGrid = await snapshot(c)
      await c.query('rollback to savepoint grid')

      await apply(c, file(CELLS))
      const byWorkbook = await snapshot(c)

      // Not vacuous: the cells did land.
      expect(byWorkbook.rates.length).toBeGreaterThanOrEqual(3)
      expect(byWorkbook).toEqual(byGrid)
    })
  })

  it('counts the cells it applied, not the rows', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect(await apply(c, file(CELLS))).toEqual({ rates: 3, dminus: 3 })
    })
  })

  it('is the same twice', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const first = await apply(c, file(CELLS))
      const once = await snapshot(c)
      const second = await apply(c, file(CELLS))
      expect(second).toEqual(first)
      expect(await snapshot(c)).toEqual(once)
    })
  })

  it('keeps the crew already entered when the file leaves manpower blank', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_capacity_cell('AARA-LC', 'WOOD', 44, 5)`)
      await apply(c, file([{ ...CELLS[0], units: 50, manpower: null, dminus: null }]))
      const { rows } = await c.query<{ units_per_day: number; manpower: number }>(
        `select units_per_day, manpower from capacity_sheet
          where article_code = 'AARA-LC' and department_code = 'WOOD'`,
      )
      expect(rows[0].units_per_day).toBe(50)
      expect(rows[0].manpower).toBe(5)
    })
  })

  it('writes the rate on every shift the department works', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_shift_active((select id from shifts where code = 'A'), true)`)
      await c.query(`select set_department_shift('STITCH', 'A', true)`)
      await apply(c, file([CELLS[1]]))
      const { rows } = await c.query<{ shift: string }>(
        `select s.code as shift
           from component_rates cr
           join components cmp on cmp.id = cr.component_id
           join shifts s on s.id = cr.shift_id
          where cmp.code = 'AARA-LC::STITCH' order by s.code`,
      )
      expect(rows.map((r) => r.shift)).toEqual(['A', 'GEN'])
    })
  })

  it('creates a D-minus row that is missing rather than silently updating nothing', async () => {
    // The seeding triggers cover active × active at insert time, and
    // reactivating an article does not go back for the rows it lacks.
    // set_dminus on a missing row updates zero rows and reports success.
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `delete from article_dept_dminus
          where article_id = (select id from articles where code = 'AARA-LC')
            and department_id = (select id from departments where code = 'ASSY')`,
      )
      await apply(c, file([{ ...CELLS[2], units: null, dminus: 25 }]))
      const { rows } = await c.query<{ dminus_days: number; dminus_complete: boolean }>(
        `select dminus_days, dminus_complete from capacity_sheet
          where article_code = 'AARA-LC' and department_code = 'ASSY'`,
      )
      expect(rows[0]).toEqual({ dminus_days: 25, dminus_complete: true })
    })
  })
})

describe('all or nothing', () => {
  const before = (c: pg.Client) => snapshot(c)

  it('refuses a department the masters do not hold, naming it, and writes nothing', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const was = await before(c)
      const message = await refused(
        c,
        file([CELLS[0], { ...CELLS[1], department_code: 'NOPE' }]),
      )
      expect(message).toMatch(/Not an active department on Masters: NOPE/)
      expect(await snapshot(c)).toEqual(was)
    })
  })

  it('refuses an article the masters do not hold, naming it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const was = await before(c)
      const message = await refused(c, file([{ ...CELLS[0], article_code: 'GHOST' }, CELLS[1]]))
      expect(message).toMatch(/Not an active article on Masters: GHOST/)
      expect(await snapshot(c)).toEqual(was)
    })
  })

  it('treats a retired department as unknown', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `select set_department_active((select id from departments where code = 'FABCUT'), false)`,
      )
      const message = await refused(c, file([CELLS[3]]))
      expect(message).toMatch(/Not an active department on Masters: FABCUT/)
    })
  })

  it('refuses a file that is not a capacity workbook', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect(await refused(c, { cells: CELLS })).toMatch(/not a Kram capacity file/)
      expect(await refused(c, { kram_capacity: 1 })).toMatch(/carries no cells/)
    })
  })

  it('refuses the same pair twice, a zero rate, and a fractional day', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect(await refused(c, file([CELLS[0], CELLS[0]]))).toMatch(
        /same article and department twice/,
      )
      expect(await refused(c, file([{ ...CELLS[0], units: 0 }]))).toMatch(
        /Units must be above zero/,
      )
      expect(await refused(c, file([{ ...CELLS[0], dminus: 12.5 }]))).toMatch(
        /whole numbers/,
      )
    })
  })

  it('can be called by a planner, as the screen will', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const planner = await createUser(c, 'ppc@kram.test', ['planner'])
      await becomeUser(c, planner)
      expect(await apply(c, file(CELLS))).toEqual({ rates: 3, dminus: 3 })
      const { rows } = await c.query<{ units_per_day: number }>(
        `select units_per_day from capacity_sheet
          where article_code = 'AARA-LC' and department_code = 'STITCH'`,
      )
      expect(rows[0].units_per_day).toBe(38)
    })
  })
})
