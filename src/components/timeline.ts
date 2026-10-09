/**
 * Dates along an axis, for the heatmap and the schedule.
 *
 * Both screens draw time left to right and, until 9 Oct, neither said which
 * day was which: the heatmap had three month labels across sixty-seven cells
 * and the schedule had no axis at all. A reader could not answer "which day is
 * this red square?" without clicking it. These helpers give both the same
 * rhythm — Mondays, months, and today — so a date learned on one screen reads
 * the same on the other.
 *
 * Day numbers are days since the epoch in UTC, which is how the schedule
 * already positions its bars; an ISO date is `yyyy-mm-dd` as the views return
 * it. "Today" is the browser's local date, which for a factory in one time
 * zone is the day on the wall clock.
 */
import { formatDate } from './format'

export const MS_PER_DAY = 86_400_000

export const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY
export const isoOf = (n: number) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10)

const pad = (n: number) => String(n).padStart(2, '0')
export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let n = dayNumber(from); n <= dayNumber(to); n += 1) out.push(isoOf(n))
  return out
}

export const isMonday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 1
export const isFirstOfMonth = (iso: string) => iso.endsWith('-01')

/** "Oct 2026" — the band label; the year because horizons cross it. */
export function monthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Contiguous runs of one month, as column index and span, for a grid. */
export function monthBands(days: string[]): { label: string; start: number; span: number }[] {
  const out: { label: string; start: number; span: number }[] = []
  days.forEach((day, i) => {
    const label = monthLabel(day)
    const last = out[out.length - 1]
    if (last?.label === label) last.span += 1
    else out.push({ label, start: i, span: 1 })
  })
  return out
}

export type Mark = { pos: number; label: string; iso: string }
export type Band = { label: string; left: number; width: number }

/**
 * Where to draw the ruler on a percentage track from day `from` to day `to`.
 *
 * `weeks` is every Monday; `labelEvery` says how many of them to caption so
 * the labels do not run into one another when the horizon is long. `today`
 * is a position or null when today is off the track.
 */
export function timelineMarks(from: number, to: number) {
  const span = Math.max(1, to - from)
  const pos = (n: number) => ((n - from) / span) * 100

  const weeks: Mark[] = []
  for (let n = from; n <= to; n += 1) {
    const iso = isoOf(n)
    if (isMonday(iso)) weeks.push({ pos: pos(n), label: formatDate(iso), iso })
  }

  const months: Band[] = []
  let start = from
  let label = monthLabel(isoOf(from))
  for (let n = from + 1; n <= to + 1; n += 1) {
    const next = n <= to ? monthLabel(isoOf(n)) : null
    if (next !== label) {
      months.push({ label, left: pos(start), width: pos(n) - pos(start) })
      start = n
      label = next ?? ''
    }
  }

  const t = dayNumber(todayIso())
  const today = t >= from && t <= to ? pos(t) : null

  const labelEvery = weeks.length > 40 ? 4 : weeks.length > 18 ? 2 : 1
  return { weeks, months, today, labelEvery, pos }
}
