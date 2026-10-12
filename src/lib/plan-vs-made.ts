/**
 * Planned against made, shaped for a picture.
 *
 * Units are not additive across departments (CLAUDE.md): legs, covers and
 * chairs cannot be summed into one factory figure. So the picture is one row
 * per department and one cell per working day, each cell its own made ÷
 * planned — and a department can be looked at on its own as bars. Nothing
 * here computes a plan or a count; it arranges what `production_vs_plan`
 * already says.
 */

export type PlanVsMadeRow = {
  department_code: string
  department_name: string
  route_position: number
  work_date: string
  qty_planned: number
  qty_good: number
  qty_rejected: number
}

/**
 * How a day went for a department.
 *
 * - `none`: nothing planned, nothing made — an ordinary empty day.
 * - `unplanned`: nothing planned, something made. Not a variance to be
 *   praised for; it is work that arrived off-plan, and it reads differently.
 * - `met`: made at least what was planned.
 * - `behind`: made most of it (seventy per cent or more).
 * - `short`: made less than seventy per cent.
 */
export type DayState = 'none' | 'unplanned' | 'met' | 'behind' | 'short'

export type DayCell = {
  date: string
  planned: number
  made: number
  rejected: number
  /** made ÷ planned, null when nothing was planned. */
  ratio: number | null
  state: DayState
}

export type PlanVsMadeGrid = {
  days: string[]
  departments: { code: string; name: string; position: number }[]
  /** By department code, one cell per day, in the order of `days`. */
  cells: Map<string, DayCell[]>
}

const isoAfter = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const isSunday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 0

/**
 * The last `count` working days ending on `to`, oldest first. Sundays are
 * skipped: the factory's week has six days, and a column for a day nobody
 * works would read as a day nobody made anything.
 */
export function workingDaysBack(to: string, count: number): string[] {
  const out: string[] = []
  for (let d = to; out.length < count; d = isoAfter(d, -1)) {
    if (!isSunday(d)) out.unshift(d)
  }
  return out
}

export function stateOfDay(planned: number, made: number): DayState {
  if (planned <= 0) return made > 0 ? 'unplanned' : 'none'
  const ratio = made / planned
  if (ratio >= 1) return 'met'
  if (ratio >= 0.7) return 'behind'
  return 'short'
}

export function gridFromRows(rows: PlanVsMadeRow[], days: string[]): PlanVsMadeGrid {
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const departments = new Map<string, { code: string; name: string; position: number }>()
  const cells = new Map<string, DayCell[]>()

  for (const r of rows) {
    const i = dayIndex.get(r.work_date)
    if (i === undefined) continue
    if (!departments.has(r.department_code)) {
      departments.set(r.department_code, {
        code: r.department_code,
        name: r.department_name,
        position: r.route_position,
      })
      cells.set(
        r.department_code,
        days.map((date) => ({ date, planned: 0, made: 0, rejected: 0, ratio: null, state: 'none' })),
      )
    }
    const row = cells.get(r.department_code)!
    const c = row[i]
    // One row per department per day in the view; summed anyway, so a second
    // row — a shift split — cannot overwrite the first.
    c.planned += r.qty_planned
    c.made += r.qty_good
    c.rejected += r.qty_rejected
    c.ratio = c.planned > 0 ? c.made / c.planned : null
    c.state = stateOfDay(c.planned, c.made)
  }

  return {
    days,
    departments: [...departments.values()].sort((a, b) => a.position - b.position),
    cells,
  }
}
