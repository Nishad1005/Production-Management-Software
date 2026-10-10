/**
 * Sentences the database writes, made readable on the way to the screen.
 *
 * The Attention views build their titles in SQL — `PACK cannot make SO/… as
 * planned`, `runway · ships 2026-10-03` — because the same rule has to produce
 * the same sentence in the browser and on Supabase. Codes and ISO dates are
 * right for a rule and wrong for a person. This swaps them for the department's
 * name and a written date without the database having to know who is reading.
 *
 * Codes are matched whole, so `CUT` leaves `PLYCUT` alone and `QC` leaves
 * `WOODQC` alone, and longest first so `STITCHQC` is replaced before `STITCH`
 * could be found inside it.
 */
import { useMemo } from 'react'
import { useDepartments } from '@/data/planning'
import { formatDateLong } from './format'

/** The reason codes a breach carries, said the way the explainers say them. */
const REASON: Record<string, string> = {
  runway: 'not enough working days',
  material: 'material arrives too late',
  pin: 'pinned past its deadline',
  no_capacity: 'no rate for this department',
  out_of_horizon: 'outside the working calendar',
  dminus_incomplete: 'D-minus missing',
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function humanise(text: string, names: Map<string, string>): string {
  let out = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => formatDateLong(m))
  for (const [code, said] of Object.entries(REASON)) {
    out = out.replace(new RegExp(`(^|[^a-z_])${code}(?![a-z_])`, 'g'), `$1${said}`)
  }
  const codes = [...names.keys()].sort((a, b) => b.length - a.length)
  for (const code of codes) {
    const name = names.get(code)!
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${escape(code)}(?![A-Za-z0-9_])`, 'g'), `$1${name}`)
  }
  return out
}

/**
 * A component code, said for a person: `125034299::STITCH` is the stitching
 * work on article 125034299, so it reads "125034299 · Stitching". A named
 * component with no `::` is left as it is.
 */
export function componentLabel(code: string, names: Map<string, string>): string {
  const i = code.indexOf('::')
  if (i < 0) return code
  const dept = code.slice(i + 2)
  return `${code.slice(0, i)} · ${names.get(dept) ?? dept}`
}

/** Department code → name, from the master; a code with no row stays a code. */
export function useDepartmentNames(): Map<string, string> {
  const departments = useDepartments()
  return useMemo(
    () => new Map((departments.data ?? []).map((d) => [d.code, d.name])),
    [departments.data],
  )
}
