/**
 * Formatting and vocabulary shared across the screens.
 *
 * Kept apart from ui.tsx so that file exports components and nothing else —
 * mixing the two breaks React Fast Refresh during development.
 */

/** Breach reasons, phrased the way the specification phrases them. */
export const BREACH_LABEL: Record<string, string> = {
  material: 'Material',
  runway: 'Runway',
  pin: 'Pin',
  no_capacity: 'No capacity',
  out_of_horizon: 'Out of horizon',
  dminus_incomplete: 'D-minus missing',
}

export const BREACH_EXPLAINER: Record<string, string> = {
  material: 'The window opens before material is available.',
  runway:
    'Fewer working days than the department needs. Overtime cannot fix this.',
  pin: 'A manual pin has pushed this past its due date. Reported, not corrected.',
  no_capacity: 'No rate for this component in this department.',
  out_of_horizon: 'The window falls outside the working-day calendar.',
  dminus_incomplete:
    'This article × department offset has never been entered, so it cannot be scheduled.',
}

export const inputClass =
  'w-full border border-rule bg-sheet px-2.5 py-2 text-[13px] rounded-[2px] focus-visible:outline-2 focus-visible:outline-blue'

/**
 * Dates are handled as plain ISO strings throughout and formatted in UTC.
 * Parsing them into local-time Date objects shifts a stuffing date across a
 * day boundary for anyone west of Greenwich, which is exactly the class of bug
 * that shows up as an off-by-one in a schedule and nowhere else.
 */
export function formatDate(iso: string | null | undefined) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

export function formatDateLong(iso: string | null | undefined) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatNumber(n: number | null | undefined, dp = 0) {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}
