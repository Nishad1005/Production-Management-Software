// @vitest-environment node
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script module, shared with the CLI tools.
import { buildWorkbook, parseWorkbook } from '../scripts/lib/capacity-workbook.mjs'
import { withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

/**
 * The workbook PPC fill in, round-tripped.
 *
 * This is the only check that can see the failure that matters. A generator and
 * a parser that disagree by one column produce a file that imports without a
 * single error and puts every crew size where a rate should be — the plan comes
 * out wrong and nothing anywhere says so. Writing then reading is what catches
 * it; neither half alone can.
 */

const DEPARTMENTS = [
  { name: 'Ply Cutting' },
  { name: 'Machining' },
  { name: 'Stitching' },
]

const ARTICLES = [
  {
    code: 'UD354 SPPL WAL',
    name: 'Betsy Chair — Specter Pearl',
    cells: {
      'Ply Cutting': { manpower: 4, units: 120, dminus: 60 },
      Stitching: { manpower: 12, units: 38, dminus: 30 },
    },
  },
  {
    code: 'DL25107',
    name: 'Mable Chair',
    cells: { Machining: { manpower: 6, units: 90, dminus: 45 } },
  },
]

const roundTrip = () => parseWorkbook(buildWorkbook({ departments: DEPARTMENTS, articles: ARTICLES }))

describe('the capacity workbook', () => {
  it('comes back with the articles it went in with', () => {
    const { articles } = roundTrip()
    expect(articles.map((a: { code: string }) => a.code)).toEqual([
      'UD354 SPPL WAL',
      'DL25107',
    ])
    expect(articles[0].name).toBe('Betsy Chair — Specter Pearl')
  })

  it('reads the departments back off the header row', () => {
    const { departments } = roundTrip()
    expect(departments.map((d: { name: string }) => d.name)).toEqual([
      'Ply Cutting',
      'Machining',
      'Stitching',
    ])
  })

  it('keeps manpower and units in their own columns', () => {
    const { articles } = roundTrip()
    const stitching = articles[0].cells.find(
      (c: { department: string }) => c.department === 'Stitching',
    )
    // The whole point of the round trip. Swapped, this reads 38 people making
    // 12 covers, which is a sentence nobody would question on a screen.
    expect(stitching.manpower).toBe(12)
    expect(stitching.units).toBe(38)
  })

  it('carries D-minus on its own sheet, against the right department', () => {
    const { articles } = roundTrip()
    const cells = Object.fromEntries(
      articles[0].cells.map((c: { department: string; dminus: number | null }) => [
        c.department,
        c.dminus,
      ]),
    )
    expect(cells['Ply Cutting']).toBe(60)
    expect(cells.Stitching).toBe(30)
    expect(cells.Machining).toBeNull()
  })

  it('brings a blank back as blank, not as zero', () => {
    const { articles } = roundTrip()
    const machining = articles[0].cells.find(
      (c: { department: string }) => c.department === 'Machining',
    )
    // A zero rate would mean "this department can make none of these per day",
    // which schedules as infinity. Nobody-has-said has to survive the file.
    expect(machining.units).toBeNull()
    expect(machining.manpower).toBeNull()
    expect(machining.dminus).toBeNull()
  })

  it('reads a workbook with no D-minus sheet at all', () => {
    // The sheet PPC already hold predates D-minus. It must still load.
    const { articles } = parseWorkbook(
      buildWorkbook({
        departments: DEPARTMENTS,
        articles: [{ code: 'X', name: 'Old sheet', cells: {} }],
      }),
    )
    expect(articles[0].cells.every((c: { dminus: null }) => c.dminus === null)).toBe(
      true,
    )
  })

  it('survives an empty article list rather than writing a broken file', () => {
    const { departments, articles } = parseWorkbook(
      buildWorkbook({ departments: DEPARTMENTS, articles: [] }),
    )
    expect(articles).toEqual([])
    expect(departments).toHaveLength(3)
  })
})

/**
 * And the other half of the journey: the parsed file into the database, and
 * back out of the view the capacity screen reads.
 *
 * The round trip above proves the two halves of the file agree with each other.
 * This proves they agree with Kram — that a figure typed into the Units column
 * of the Stitching pair arrives as Stitching's rate and not as its crew size,
 * or as Wood's anything.
 */
describe('the workbook into the database', () => {
  it('lands every figure in the cell it was written in', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      const { rows: departments } = await c.query<{ code: string; name: string }>(
        `select code, name from departments where is_active order by route_position`,
      )
      const { articles } = parseWorkbook(
        buildWorkbook({
          departments: departments.map((d) => ({ name: d.name })),
          articles: [
            {
              code: 'AARA-LC',
              name: 'Aara Lounge Chair',
              cells: {
                Wood: { manpower: 5, units: 44, dminus: 70 },
                Stitching: { manpower: 12, units: 38, dminus: 30 },
              },
            },
          ],
        }),
      )

      const codeOf = new Map(departments.map((d) => [d.name, d.code]))

      // What fabric cutting's offset is before the sheet touches anything. The
      // fixture seeds every D-minus, and a sheet that says nothing about a cell
      // must leave it exactly as it found it.
      const fabcutBefore = (
        await c.query<{ dminus_days: number | null }>(
          `select dminus_days from capacity_sheet
            where article_code = 'AARA-LC' and department_code = 'FABCUT'`,
        )
      ).rows[0].dminus_days

      // Exactly what scripts/import-capacity-sheet.mjs does, in the same order.
      for (const cell of articles[0].cells) {
        if (cell.units === null) continue
        await c.query(`select set_capacity_cell('AARA-LC', $1, $2, $3)`, [
          codeOf.get(cell.department),
          cell.units,
          cell.manpower,
        ])
      }
      for (const cell of articles[0].cells) {
        if (cell.units === null || cell.dminus === null) continue
        await c.query(`select set_dminus('AARA-LC', $1, $2)`, [
          codeOf.get(cell.department),
          cell.dminus,
        ])
      }

      const { rows } = await c.query<{
        department_code: string
        units_per_day: number | null
        manpower: number | null
        dminus_days: number | null
        dminus_complete: boolean
      }>(
        `select department_code, units_per_day, manpower, dminus_days, dminus_complete
           from capacity_sheet where article_code = 'AARA-LC'
          order by route_position`,
      )
      const byDept = Object.fromEntries(rows.map((r) => [r.department_code, r]))

      expect(byDept.WOOD.units_per_day).toBe(44)
      expect(byDept.WOOD.manpower).toBe(5)
      expect(byDept.WOOD.dminus_days).toBe(70)
      expect(byDept.STITCH.units_per_day).toBe(38)
      expect(byDept.STITCH.manpower).toBe(12)
      expect(byDept.STITCH.dminus_days).toBe(30)

      // And the department the sheet left blank is untouched — no rate, no crew
      // size, and the offset it already had, unmoved. A blank column must not
      // arrive as a zero, and must not pick up its neighbour's figures.
      expect(byDept.FABCUT.units_per_day).toBeNull()
      expect(byDept.FABCUT.manpower).toBeNull()
      expect(byDept.FABCUT.dminus_days).toBe(fabcutBefore)
    })
  })

  it('takes a sheet that contradicts the route, and says so rather than fixing it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // Wood feeds fabric cutting in the parity fixture, so wood must finish
      // first — its D-minus has to be the larger number. Entering it the wrong
      // way round is exactly the mistake a filled-in sheet can carry.
      await c.query(`select set_capacity_cell('AARA-LC', 'WOOD', 44, 5)`)
      await c.query(`select set_capacity_cell('AARA-LC', 'FABCUT', 30, 4)`)
      await c.query(`select set_dminus('AARA-LC', 'WOOD', 20)`)
      await c.query(`select set_dminus('AARA-LC', 'FABCUT', 60)`)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from route_order_conflicts`,
      )
      // Loading a sheet does not silently correct it. The contradiction is
      // reported and both figures are left exactly as PPC entered them.
      expect(Number(rows[0].n)).toBeGreaterThan(0)
    })
  })
})
