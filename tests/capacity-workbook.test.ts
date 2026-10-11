// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildWorkbook,
  modelFromParsed,
  modelFromSheet,
  parseWorkbook,
  planWorkbookLoad,
  type SheetRow,
} from '../src/lib/capacity-workbook'
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
    expect(articles.map((a) => a.code)).toEqual(['UD354 SPPL WAL', 'DL25107'])
    expect(articles[0].name).toBe('Betsy Chair — Specter Pearl')
  })

  it('reads the departments back off the header row', () => {
    const { departments } = roundTrip()
    expect(departments.map((d) => d.name)).toEqual(['Ply Cutting', 'Machining', 'Stitching'])
  })

  it('keeps manpower and units in their own columns', () => {
    const { articles } = roundTrip()
    const stitching = articles[0].cells.find((c) => c.department === 'Stitching')!
    // The whole point of the round trip. Swapped, this reads 38 people making
    // 12 covers, which is a sentence nobody would question on a screen.
    expect(stitching.manpower).toBe(12)
    expect(stitching.units).toBe(38)
  })

  it('carries D-minus on its own sheet, against the right department', () => {
    const { articles } = roundTrip()
    const cells = Object.fromEntries(articles[0].cells.map((c) => [c.department, c.dminus]))
    expect(cells['Ply Cutting']).toBe(60)
    expect(cells.Stitching).toBe(30)
    expect(cells.Machining).toBeNull()
  })

  it('brings a blank back as blank, not as zero', () => {
    const { articles } = roundTrip()
    const machining = articles[0].cells.find((c) => c.department === 'Machining')!
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
    expect(articles[0].cells.every((c) => c.dminus === null)).toBe(true)
  })

  it('survives an empty article list rather than writing a broken file', () => {
    const { departments, articles } = parseWorkbook(
      buildWorkbook({ departments: DEPARTMENTS, articles: [] }),
    )
    expect(articles).toEqual([])
    expect(departments).toHaveLength(3)
  })

  it('edits and writes again through the model, losing nothing', () => {
    // The browser check edits one cell of a downloaded workbook this way.
    const model = modelFromParsed(roundTrip())
    model.articles[1].cells!.Stitching = { units: 41, dminus: 34 }
    const { articles } = parseWorkbook(buildWorkbook(model))
    const mable = Object.fromEntries(articles[1].cells.map((c) => [c.department, c]))
    expect(mable.Machining.units).toBe(90)
    expect(mable.Stitching.units).toBe(41)
    expect(mable.Stitching.dminus).toBe(34)
    expect(mable.Stitching.manpower).toBeNull()
  })

  it('writes what Kram holds, in route order, with incomplete offsets left blank', () => {
    const rows: SheetRow[] = [
      row('B', 'STITCH', 'Stitching', 30, { units: 38, manpower: 12, dminus: 30, complete: true }),
      row('B', 'WOOD', 'Wood', 10, { units: 44, manpower: null, dminus: 70, complete: true }),
      row('A', 'WOOD', 'Wood', 10, { units: null, manpower: null, dminus: 60, complete: false }),
      row('A', 'STITCH', 'Stitching', 30, { units: 20, manpower: 3, dminus: null, complete: false }),
    ]
    const model = modelFromSheet(rows)
    expect(model.departments.map((d) => d.name)).toEqual(['Wood', 'Stitching'])
    expect(model.articles.map((a) => a.code)).toEqual(['A', 'B'])
    // An incomplete offset is a blank that stops the article scheduling;
    // sending its leftover number out would turn "still to answer" into
    // "answered".
    expect(model.articles[0].cells!.Wood.dminus).toBeNull()
    expect(model.articles[1].cells!.Wood).toEqual({ manpower: null, units: 44, dminus: 70 })
  })
})

function row(
  article: string,
  code: string,
  name: string,
  position: number,
  f: { units: number | null; manpower: number | null; dminus: number | null; complete: boolean },
): SheetRow {
  return {
    article_code: article,
    article_name: `Article ${article}`,
    department_code: code,
    department_name: name,
    route_position: position,
    units_per_day: f.units,
    manpower: f.manpower,
    dminus_days: f.dminus,
    dminus_complete: f.complete,
  }
}

/**
 * The plan: what loading a file would do, worked out against what Kram holds
 * before anything is written. Pure, so it is proved here without a database,
 * on a small factory of three departments and two articles.
 */
describe('planning a load', () => {
  const KRAM = {
    departments: [
      { code: 'WOOD', name: 'Wood' },
      { code: 'FABCUT', name: 'Fabric cutting' },
      { code: 'STITCH', name: 'Stitching' },
    ],
    articles: [
      { code: 'AARA-LC', name: 'Aara Lounge Chair' },
      { code: 'MABLE', name: 'Mable Chair' },
    ],
    sheet: [
      row('AARA-LC', 'WOOD', 'Wood', 10, { units: 44, manpower: 5, dminus: 70, complete: true }),
      row('AARA-LC', 'FABCUT', 'Fabric cutting', 20, { units: null, manpower: null, dminus: null, complete: false }),
      row('AARA-LC', 'STITCH', 'Stitching', 30, { units: 38, manpower: 12, dminus: 30, complete: true }),
      row('MABLE', 'WOOD', 'Wood', 10, { units: null, manpower: null, dminus: null, complete: false }),
      row('MABLE', 'FABCUT', 'Fabric cutting', 20, { units: null, manpower: null, dminus: null, complete: false }),
      row('MABLE', 'STITCH', 'Stitching', 30, { units: null, manpower: null, dminus: null, complete: false }),
    ],
  }

  const planOf = (
    departments: { name: string }[],
    articles: { code: string; name: string; cells?: Record<string, { units?: number | null; manpower?: number | null; dminus?: number | null }> }[],
  ) => planWorkbookLoad(parseWorkbook(buildWorkbook({ departments, articles })), KRAM)

  it('matches departments by name, ignoring capitals and spacing', () => {
    const plan = planOf(
      [{ name: ' stitching ' }, { name: 'WOOD' }, { name: 'Fabric  cutting' }],
      [{ code: 'AARA-LC', name: 'Aara', cells: {} }],
    )
    expect(plan.matchedDepartments.map((d) => d.code)).toEqual(['STITCH', 'WOOD', 'FABCUT'])
    expect(plan.unknownDepartments).toEqual([])
  })

  it('lists a column it cannot place and writes nothing under it', () => {
    const plan = planOf(
      [{ name: 'Wood' }, { name: 'Upholstery' }],
      [{ code: 'AARA-LC', name: 'Aara', cells: { Upholstery: { units: 99, dminus: 9 } } }],
    )
    expect(plan.unknownDepartments).toEqual(['Upholstery'])
    expect(plan.file.cells).toEqual([])
    expect(plan.rates).toEqual({ new: 0, changed: 0, unchanged: 0 })
  })

  it('matches articles by code and lists the ones Kram does not hold', () => {
    const plan = planOf(
      [{ name: 'Wood' }],
      [
        { code: ' AARA-LC ', name: 'Aara', cells: { Wood: { units: 44 } } },
        { code: 'NOPE', name: 'Nobody', cells: { Wood: { units: 10 } } },
      ],
    )
    expect(plan.matchedArticles).toEqual(['AARA-LC'])
    expect(plan.unknownArticles).toEqual(['NOPE'])
    expect(plan.file.cells.map((c) => c.article_code)).toEqual(['AARA-LC'])
  })

  it('leaves a blank Units cell exactly as it is, and says how many hold a rate', () => {
    const plan = planOf(
      [{ name: 'Wood' }, { name: 'Fabric cutting' }],
      [{ code: 'AARA-LC', name: 'Aara', cells: {} }],
    )
    expect(plan.blanks).toBe(2)
    expect(plan.keptRates).toBe(1)
    expect(plan.file.cells).toEqual([])
  })

  it('tells new from changed from unchanged, for rates and for crews', () => {
    const plan = planOf(
      [{ name: 'Wood' }, { name: 'Fabric cutting' }, { name: 'Stitching' }],
      [
        {
          code: 'AARA-LC',
          name: 'Aara',
          cells: {
            Wood: { units: 44, manpower: 5 }, // as it is
            'Fabric cutting': { units: 20 }, // new
            Stitching: { units: 38, manpower: 10 }, // the crew changed
          },
        },
      ],
    )
    expect(plan.rates).toEqual({ new: 1, changed: 1, unchanged: 1 })
  })

  it('treats a blank crew over an entered one as unchanged, because the crew is kept', () => {
    const plan = planOf(
      [{ name: 'Wood' }],
      [{ code: 'AARA-LC', name: 'Aara', cells: { Wood: { units: 44 } } }],
    )
    expect(plan.rates).toEqual({ new: 0, changed: 0, unchanged: 1 })
  })

  it('tallies D-minus on its own, including on a cell with no rate', () => {
    const plan = planOf(
      [{ name: 'Wood' }, { name: 'Fabric cutting' }, { name: 'Stitching' }],
      [
        {
          code: 'AARA-LC',
          name: 'Aara',
          cells: {
            Wood: { dminus: 70 }, // as it is
            'Fabric cutting': { dminus: 55 }, // new, on a cell with no rate
            Stitching: { dminus: 25 }, // changed
          },
        },
      ],
    )
    expect(plan.dminus).toEqual({ new: 1, changed: 1, unchanged: 1 })
    expect(plan.file.cells.find((c) => c.department_code === 'FABCUT')).toEqual({
      article_code: 'AARA-LC',
      department_code: 'FABCUT',
      units: null,
      manpower: null,
      dminus: 55,
    })
  })

  it('counts the articles that will be schedulable after loading, over the whole factory', () => {
    // Aara is routed through Wood and Stitching and has both offsets: already
    // schedulable. Mable is not routed at all, so it is in neither figure —
    // until the file routes it.
    const alone = planOf([{ name: 'Wood' }], [{ code: 'AARA-LC', name: 'Aara', cells: {} }])
    expect(alone.schedulable).toEqual({ after: 1, of: 1 })

    const routed = planOf(
      [{ name: 'Wood' }],
      [{ code: 'MABLE', name: 'Mable', cells: { Wood: { units: 30, dminus: 40 } } }],
    )
    expect(routed.schedulable).toEqual({ after: 2, of: 2 })

    const undated = planOf(
      [{ name: 'Wood' }],
      [{ code: 'MABLE', name: 'Mable', cells: { Wood: { units: 30 } } }],
    )
    expect(undated.schedulable).toEqual({ after: 1, of: 2 })
  })

  it('lets the last of two rows for one code win, and says so', () => {
    const plan = planOf(
      [{ name: 'Wood' }],
      [
        { code: 'AARA-LC', name: 'Aara', cells: { Wood: { units: 50 } } },
        { code: 'AARA-LC', name: 'Aara again', cells: { Wood: { units: 60 } } },
      ],
    )
    expect(plan.duplicateArticles).toEqual(['AARA-LC'])
    expect(plan.file.cells).toEqual([
      { article_code: 'AARA-LC', department_code: 'WOOD', units: 60, manpower: null, dminus: null },
    ])
  })

  it('hands Apply a file in a fixed order, under its own version mark', () => {
    const plan = planOf(
      [{ name: 'Stitching' }, { name: 'Wood' }],
      [
        { code: 'MABLE', name: 'Mable', cells: { Stitching: { units: 1 }, Wood: { units: 2 } } },
        { code: 'AARA-LC', name: 'Aara', cells: { Stitching: { units: 3 } } },
      ],
    )
    expect(plan.file.kram_capacity).toBe(1)
    expect(plan.file.cells.map((c) => `${c.article_code}/${c.department_code}`)).toEqual([
      'AARA-LC/STITCH',
      'MABLE/WOOD',
      'MABLE/STITCH',
    ])
  })
})

/**
 * And the other half of the journey: the parsed file into the database, and
 * back out of the view the capacity screen reads.
 *
 * The round trip above proves the two halves of the file agree with each other.
 * This proves they agree with Kram — that a figure typed into the Units column
 * of the Stitching pair arrives as Stitching's rate and not as its crew size,
 * or as Wood's anything. Cell by cell here, as the grid's own edits do it;
 * `apply-capacity-workbook.test.ts` proves the one-call function lands the
 * same rows.
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
