/**
 * The capacity workbook, read and written from one place.
 *
 * PPC work in Excel. Seventy articles across fourteen departments is a long
 * session at a screen, and they already have the sheet in a shape they know —
 * so Kram meets them there: it writes a blank workbook in exactly the layout it
 * reads back.
 *
 * Both directions live here rather than in the two scripts that use them,
 * because the failure this guards against is a silent one. A generator and a
 * parser that drift apart by a single column produce a workbook that imports
 * cleanly and puts every manpower figure where the units should be. Nothing
 * errors; the plan is simply wrong. `tests/capacity-workbook.test.ts` round
 * trips the pair, which is the only check that can see it.
 *
 * The layout is fixed by what `import-capacity-sheet.mjs` has always parsed:
 *
 *   row 1   title
 *   row 2   department names, at the first column of each pair
 *   row 3   Manpower / Units sub-headers
 *   row 4+  serial, code, name, then the pairs
 */
import * as XLSX from 'xlsx'

export const CAPACITY_SHEET = 'Capacity'
export const DMINUS_SHEET = 'D-minus'

/** Where the article columns end and the departments begin. */
const FIRST_DEPARTMENT_COLUMN = 3

export function numberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Reads a workbook.
 *
 * Departments come from the capacity sheet's header row. D-minus is optional:
 * a workbook from before that sheet existed still parses, and every offset
 * simply comes back null.
 */
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' })

  const capacity = wb.Sheets[CAPACITY_SHEET] ?? wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(capacity, { header: 1, blankrows: false })

  const header = rows[1] ?? []
  const departments = []
  for (let col = FIRST_DEPARTMENT_COLUMN; col < header.length; col += 1) {
    const name = String(header[col] ?? '').trim()
    if (name) departments.push({ name, column: col })
  }

  // D-minus carries one column per department rather than a pair, so its
  // columns are found by name rather than by arithmetic on the other sheet's.
  const dminusRows = wb.Sheets[DMINUS_SHEET]
    ? XLSX.utils.sheet_to_json(wb.Sheets[DMINUS_SHEET], {
        header: 1,
        blankrows: false,
      })
    : []
  const dminusHeader = dminusRows[1] ?? []
  const dminusColumn = new Map()
  for (let col = FIRST_DEPARTMENT_COLUMN; col < dminusHeader.length; col += 1) {
    const name = String(dminusHeader[col] ?? '').trim()
    if (name) dminusColumn.set(name, col)
  }
  const dminusByCode = new Map(
    dminusRows.slice(3).map((row) => [String(row[1] ?? '').trim(), row]),
  )

  const articles = []
  for (const row of rows.slice(3)) {
    const code = String(row[1] ?? '').trim()
    if (!code) continue
    // Names carry hard line breaks from the spreadsheet's wrapping.
    const name = String(row[2] ?? code).replace(/\s+/g, ' ').trim()
    const dminusRow = dminusByCode.get(code)

    const cells = departments.map((d) => ({
      department: d.name,
      manpower: numberOrNull(row[d.column]),
      units: numberOrNull(row[d.column + 1]),
      dminus:
        dminusRow && dminusColumn.has(d.name)
          ? numberOrNull(dminusRow[dminusColumn.get(d.name)])
          : null,
    }))
    articles.push({ code, name, cells })
  }

  return { departments, articles }
}

/**
 * Writes the workbook PPC fill in.
 *
 * `articles[].cells` is optional and keyed by department name — whatever Kram
 * already holds is filled in, so a sheet sent back a second time arrives
 * carrying the first round's answers rather than asking for them again.
 */
export function buildWorkbook({ departments, articles }) {
  const names = departments.map((d) => d.name)

  const capacity = [
    [
      'U&M Designs — capacity for Kram',
      '',
      '',
      'Two columns per department. Leave both blank where the article does not go through it.',
    ],
    ['', '', '', ...names.flatMap((name) => [name, ''])],
    ['#', 'Code', 'Article', ...names.flatMap(() => ['Manpower', 'Units'])],
    ...articles.map((a, i) => [
      i + 1,
      a.code,
      a.name,
      ...names.flatMap((name) => [
        a.cells?.[name]?.manpower ?? '',
        a.cells?.[name]?.units ?? '',
      ]),
    ]),
  ]

  const dminus = [
    [
      'D-minus — working days before the container stuffing date',
      '',
      '',
      'The department must be finished this many days before stuffing. Larger means earlier.',
    ],
    ['', '', '', ...names],
    ['#', 'Code', 'Article', ...names.map(() => 'Days')],
    ...articles.map((a, i) => [
      i + 1,
      a.code,
      a.name,
      ...names.map((name) => a.cells?.[name]?.dminus ?? ''),
    ]),
  ]

  const wb = XLSX.utils.book_new()
  const capacitySheet = XLSX.utils.aoa_to_sheet(capacity)
  const dminusSheet = XLSX.utils.aoa_to_sheet(dminus)

  // Article names are long and the code is what gets read across a room.
  capacitySheet['!cols'] = [
    { wch: 4 },
    { wch: 18 },
    { wch: 38 },
    ...names.flatMap(() => [{ wch: 10 }, { wch: 8 }]),
  ]
  dminusSheet['!cols'] = [
    { wch: 4 },
    { wch: 18 },
    { wch: 38 },
    ...names.map(() => ({ wch: 12 })),
  ]

  XLSX.utils.book_append_sheet(wb, capacitySheet, CAPACITY_SHEET)
  XLSX.utils.book_append_sheet(wb, dminusSheet, DMINUS_SHEET)

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}
