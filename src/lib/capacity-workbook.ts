/**
 * The capacity workbook: read, written, and planned from one place.
 *
 * PPC work in Excel. Seventy-two articles across twenty departments is a long
 * session at a screen, and they already have the sheet in a shape they know —
 * so Kram meets them there: it writes a workbook in exactly the layout it
 * reads back, and reads one back into a plan it shows before writing a thing.
 *
 * All three directions live here rather than in the screen and the two
 * scripts that use them, because the failure this guards against is a silent
 * one. A generator and a parser that drift apart by a single column produce a
 * workbook that loads cleanly and puts every manpower figure where the units
 * should be. Nothing errors; the plan is simply wrong.
 * `tests/capacity-workbook.test.ts` round-trips the pair, which is the only
 * check that can see it.
 *
 * This file is imported by the browser (lazily, so xlsx is its own chunk) and
 * by `scripts/*.mjs` under plain Node, which strips the types. So: no `@/`
 * imports, no Node globals — bytes are `Uint8Array` in and `ArrayBuffer` out.
 *
 * The layout:
 *
 *   sheet "Capacity"
 *     row 1   title
 *     row 2   department names, at the first column of each pair
 *     row 3   Manpower / Units sub-headers
 *     row 4+  serial, code, name, then the pairs
 *   sheet "D-minus"
 *     the same rows, one Days column per department
 */
import * as XLSX from 'xlsx'

export const CAPACITY_SHEET = 'Capacity'
export const DMINUS_SHEET = 'D-minus'
export const WORKBOOK_FILENAME = 'kram-capacity-sheet.xlsx'

/** Where the article columns end and the departments begin. */
const FIRST_DEPARTMENT_COLUMN = 3

type Cellish = string | number | boolean | null | undefined

export type ParsedCell = {
  department: string
  manpower: number | null
  units: number | null
  dminus: number | null
}
export type ParsedArticle = { code: string; name: string; cells: ParsedCell[] }
export type ParsedWorkbook = {
  departments: { name: string; column: number }[]
  articles: ParsedArticle[]
}

export type CellFigures = {
  manpower?: number | null
  units?: number | null
  dminus?: number | null
}
export type WorkbookModel = {
  departments: { name: string }[]
  articles: { code: string; name: string; cells?: Record<string, CellFigures> }[]
}

/** A blank or anything that is not a number is null — never a zero. */
export function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const collapse = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * Reads a workbook.
 *
 * Departments come from the capacity sheet's header row. D-minus is optional:
 * a workbook from before that sheet existed still parses, and every offset
 * simply comes back null.
 */
export function parseWorkbook(data: Uint8Array | ArrayBuffer): ParsedWorkbook {
  const wb = XLSX.read(data, { type: 'array' })

  const capacity = wb.Sheets[CAPACITY_SHEET] ?? wb.Sheets[wb.SheetNames[0]]
  if (!capacity) throw new Error('That file has no sheets in it.')
  const rows = XLSX.utils.sheet_to_json<Cellish[]>(capacity, {
    header: 1,
    blankrows: false,
  })

  const header = rows[1] ?? []
  const departments: { name: string; column: number }[] = []
  for (let col = FIRST_DEPARTMENT_COLUMN; col < header.length; col += 1) {
    const name = collapse(header[col])
    if (name) departments.push({ name, column: col })
  }
  if (!departments.length) {
    throw new Error(
      'That file is not a Kram capacity workbook: no department columns on row 2.',
    )
  }

  // D-minus carries one column per department rather than a pair, so its
  // columns are found by name rather than by arithmetic on the other sheet's.
  const dminusSheet = wb.Sheets[DMINUS_SHEET]
  const dminusRows = dminusSheet
    ? XLSX.utils.sheet_to_json<Cellish[]>(dminusSheet, { header: 1, blankrows: false })
    : []
  const dminusHeader = dminusRows[1] ?? []
  const dminusColumn = new Map<string, number>()
  for (let col = FIRST_DEPARTMENT_COLUMN; col < dminusHeader.length; col += 1) {
    const name = collapse(dminusHeader[col])
    if (name) dminusColumn.set(name, col)
  }
  const dminusByCode = new Map(
    dminusRows.slice(3).map((row) => [collapse(row[1]), row] as const),
  )

  const articles: ParsedArticle[] = []
  for (const row of rows.slice(3)) {
    const code = collapse(row[1])
    if (!code) continue
    // Names carry hard line breaks from the spreadsheet's wrapping.
    const name = collapse(row[2]) || code
    const dminusRow = dminusByCode.get(code)

    const cells = departments.map((d) => {
      const col = dminusColumn.get(d.name)
      return {
        department: d.name,
        manpower: numberOrNull(row[d.column]),
        units: numberOrNull(row[d.column + 1]),
        dminus: dminusRow && col !== undefined ? numberOrNull(dminusRow[col]) : null,
      }
    })
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
export function buildWorkbook({ departments, articles }: WorkbookModel): ArrayBuffer {
  const names = departments.map((d) => d.name)
  const blank = (v: number | null | undefined) => (v === null || v === undefined ? '' : v)

  const capacity: Cellish[][] = [
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
      ...names.flatMap((name) => [blank(a.cells?.[name]?.manpower), blank(a.cells?.[name]?.units)]),
    ]),
  ]

  const dminus: Cellish[][] = [
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
      ...names.map((name) => blank(a.cells?.[name]?.dminus)),
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

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/** A parsed workbook as a model, so a file can be edited and written again. */
export function modelFromParsed(parsed: ParsedWorkbook): WorkbookModel {
  return {
    departments: parsed.departments.map((d) => ({ name: d.name })),
    articles: parsed.articles.map((a) => ({
      code: a.code,
      name: a.name,
      cells: Object.fromEntries(
        a.cells.map((c) => [
          c.department,
          { manpower: c.manpower, units: c.units, dminus: c.dminus },
        ]),
      ),
    })),
  }
}

/** One row of the `capacity_sheet` view: an active article × an active department. */
export type SheetRow = {
  article_code: string
  article_name: string
  department_code: string
  department_name: string
  route_position: number
  units_per_day: number | null
  manpower: number | null
  dminus_days: number | null
  dminus_complete: boolean
}

/**
 * What Kram holds, as a model: departments across in route order, articles
 * down by code, and the figures already entered filled in. A D-minus is
 * written only when it is complete — an incomplete one is a blank that stops
 * the article scheduling, and sending it out as a number would hide that.
 */
export function modelFromSheet(rows: SheetRow[]): WorkbookModel {
  const departments = [
    ...new Map(
      rows.map((r) => [r.department_code, { name: r.department_name, position: r.route_position }]),
    ).values(),
  ]
    .sort((a, b) => a.position - b.position)
    .map((d) => ({ name: d.name }))

  const byArticle = new Map<string, { code: string; name: string; cells: Record<string, CellFigures> }>()
  for (const r of rows) {
    const a = byArticle.get(r.article_code) ?? {
      code: r.article_code,
      name: r.article_name,
      cells: {},
    }
    a.cells[r.department_name] = {
      manpower: r.manpower,
      units: r.units_per_day,
      dminus: r.dminus_complete ? r.dminus_days : null,
    }
    byArticle.set(r.article_code, a)
  }
  const articles = [...byArticle.values()].sort((a, b) => a.code.localeCompare(b.code))

  return { departments, articles }
}

/** Hands the browser a file to save, the way masters-io.ts does for JSON. */
export function downloadWorkbook(bytes: ArrayBuffer, name = WORKBOOK_FILENAME): void {
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// The plan: what loading this file would do, worked out before anything is
// written, against what Kram holds.
// ---------------------------------------------------------------------------

export type MasterDepartment = { code: string; name: string }
export type MasterArticle = { code: string; name: string }

/** One cell as the database receives it; a null is "not given", never a zero. */
export type WorkbookCell = {
  article_code: string
  department_code: string
  units: number | null
  manpower: number | null
  dminus: number | null
}
export type CapacityWorkbookFile = { kram_capacity: 1; cells: WorkbookCell[] }

export type Tally = { new: number; changed: number; unchanged: number }

export type WorkbookPlan = {
  /** Workbook columns that are departments on Masters, with the code each resolved to. */
  matchedDepartments: { name: string; code: string }[]
  /** Workbook columns Kram has no department for: listed, never created. */
  unknownDepartments: string[]
  /** Article codes found on Masters. */
  matchedArticles: string[]
  /** Article codes Kram has no article for: listed, never created. */
  unknownArticles: string[]
  /** Codes that appear on more than one row; the last row wins. */
  duplicateArticles: string[]
  rates: Tally
  dminus: Tally
  /** Matched cells with no Units figure — left exactly as they are. */
  blanks: number
  /** Of those, the ones that hold a rate in Kram today. */
  keptRates: number
  /** Routed articles that would have every D-minus after loading, out of all routed. */
  schedulable: { after: number; of: number }
  /** What Apply sends. */
  file: CapacityWorkbookFile
}

const norm = (s: string) => collapse(s).toLowerCase()

/**
 * Departments match by name, with capitals and spacing ignored, because the
 * workbook carries names and a name is what PPC see. Articles match by code,
 * exactly, because a code is an identifier and the blank workbook writes it
 * verbatim. Neither is ever created here, and nothing is ever retired or
 * re-ordered: a loader that can change the route is a loader that one day
 * will, quietly. The route is changed on Masters.
 *
 * A blank Units cell changes nothing. Removing a step is a decision taken one
 * cell at a time on the sheet, not something a half-filled file does to
 * sixty articles at once.
 */
export function planWorkbookLoad(
  parsed: ParsedWorkbook,
  kram: { departments: MasterDepartment[]; articles: MasterArticle[]; sheet: SheetRow[] },
): WorkbookPlan {
  const departmentByName = new Map(kram.departments.map((d) => [norm(d.name), d]))
  const matchedDepartments: { name: string; code: string }[] = []
  const unknownDepartments: string[] = []
  const codeOfColumn = new Map<string, string>()
  const placed = new Set<string>()
  for (const column of parsed.departments) {
    const dept = departmentByName.get(norm(column.name))
    if (!dept) {
      unknownDepartments.push(column.name)
      continue
    }
    // Two columns that are the same department: the first one is the one.
    if (placed.has(dept.code)) continue
    placed.add(dept.code)
    codeOfColumn.set(column.name, dept.code)
    matchedDepartments.push({ name: column.name, code: dept.code })
  }

  const known = new Set(kram.articles.map((a) => a.code))
  const matched: string[] = []
  const unknownArticles: string[] = []
  const duplicateArticles: string[] = []
  const cellsByKey = new Map<string, WorkbookCell>()
  for (const article of parsed.articles) {
    const code = collapse(article.code)
    if (!known.has(code)) {
      if (!unknownArticles.includes(code)) unknownArticles.push(code)
      continue
    }
    if (matched.includes(code)) {
      if (!duplicateArticles.includes(code)) duplicateArticles.push(code)
    } else {
      matched.push(code)
    }
    for (const cell of article.cells) {
      const department = codeOfColumn.get(cell.department)
      if (!department) continue
      // Last row wins, which is what a spreadsheet user expects of a row
      // they pasted below the first.
      cellsByKey.set(`${code}|${department}`, {
        article_code: code,
        department_code: department,
        units: cell.units,
        manpower: cell.manpower,
        dminus: cell.dminus,
      })
    }
  }

  const sheetByKey = new Map(kram.sheet.map((r) => [`${r.article_code}|${r.department_code}`, r]))
  const positionOf = new Map(kram.sheet.map((r) => [r.department_code, r.route_position]))

  const rates: Tally = { new: 0, changed: 0, unchanged: 0 }
  const dminus: Tally = { new: 0, changed: 0, unchanged: 0 }
  let blanks = 0
  let keptRates = 0
  const cells: WorkbookCell[] = []
  for (const cell of cellsByKey.values()) {
    const row = sheetByKey.get(`${cell.article_code}|${cell.department_code}`)
    const hasRate = row !== undefined && row.units_per_day !== null
    if (cell.units !== null) {
      if (!hasRate) rates.new += 1
      else if (
        cell.units !== row.units_per_day ||
        (cell.manpower !== null && cell.manpower !== row.manpower)
      )
        rates.changed += 1
      else rates.unchanged += 1
    } else {
      blanks += 1
      if (hasRate) keptRates += 1
    }
    if (cell.dminus !== null) {
      if (!row?.dminus_complete) dminus.new += 1
      else if (cell.dminus !== row.dminus_days) dminus.changed += 1
      else dminus.unchanged += 1
    }
    if (cell.units !== null || cell.dminus !== null) cells.push(cell)
  }
  cells.sort(
    (a, b) =>
      a.article_code.localeCompare(b.article_code) ||
      (positionOf.get(a.department_code) ?? 0) - (positionOf.get(b.department_code) ?? 0),
  )

  // Schedulable after loading: every article Kram holds, with the file
  // merged in. Routed means a rate, from the file or already there; a
  // D-minus likewise. An article with no route is in neither figure — it is
  // not unschedulable, it is not routed yet.
  const routed = new Map<string, { steps: number; dated: number }>()
  for (const row of kram.sheet) {
    const incoming = cellsByKey.get(`${row.article_code}|${row.department_code}`)
    const hasRate = (incoming?.units ?? null) !== null || row.units_per_day !== null
    if (!hasRate) continue
    const hasDminus = (incoming?.dminus ?? null) !== null || row.dminus_complete
    const tally = routed.get(row.article_code) ?? { steps: 0, dated: 0 }
    tally.steps += 1
    if (hasDminus) tally.dated += 1
    routed.set(row.article_code, tally)
  }
  const of = routed.size
  const after = [...routed.values()].filter((t) => t.dated === t.steps).length

  return {
    matchedDepartments,
    unknownDepartments,
    matchedArticles: matched,
    unknownArticles,
    duplicateArticles,
    rates,
    dminus,
    blanks,
    keptRates,
    schedulable: { after, of },
    file: { kram_capacity: 1, cells },
  }
}
