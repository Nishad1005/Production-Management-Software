import { useQuery } from '@tanstack/react-query'
import { select } from '@/lib/backend'

/**
 * Phase 9 — attention.
 *
 * Deck slide 2, objective five: "create alerts for timely response without
 * getting into crisis points". Nothing is computed here or in SQL — every row
 * is a finding some other view already makes, gathered into one list.
 */

export type Finding = {
  kind: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  route: string
  key: string
  days_out: number
}

/**
 * Every finding has its own view, and they are fetched together.
 *
 * `attention` unions all eight, and that union costs more than the API allows:
 * each branch is itself a multi-table view, and `security_invoker` makes every
 * nested table re-apply its policy, so the cost compounds rather than adds. On
 * the live project the union was cancelled at eight seconds while its slowest
 * branch measured 536 ms.
 *
 * Asking for them at once makes the wall clock the slowest branch instead of
 * the sum. Nothing is computed here — the branches are concatenated and sorted,
 * which is the same order the union declared.
 */
const BRANCHES = [
  'attention_breach',
  'attention_overloaded',
  'attention_material_late',
  'attention_material_short',
  'attention_route_conflict',
  'attention_machine_down',
  'attention_article_unplannable',
  'attention_handover',
] as const

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

async function fetchFindings(views: readonly string[]) {
  const parts = await Promise.all(views.map((v) => select<Finding>(v)))
  return parts
    .flat()
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.days_out - b.days_out,
    )
}

export function useAttention() {
  return useQuery({
    queryKey: ['attention'],
    queryFn: () => fetchFindings(BRANCHES),
  })
}

export type AttentionCount = {
  critical: number
  warning: number
  info: number
  total: number
}

/**
 * The header badge, on every screen, counting only what is critical.
 *
 * `attention_count` reads the union and so inherited its cost — which meant the
 * badge was quietly absent everywhere the moment the union stopped loading, and
 * nothing on screen said so. It now reads the three branches that can produce a
 * critical finding, which is the only thing the badge shows.
 */
const CRITICAL_BRANCHES = [
  'attention_breach',
  'attention_overloaded',
  'attention_material_late',
  'attention_route_conflict',
] as const

export function useAttentionCount() {
  return useQuery({
    queryKey: ['attention-count'],
    queryFn: async () => {
      const rows = await fetchFindings(CRITICAL_BRANCHES)
      return {
        critical: rows.filter((r) => r.severity === 'critical').length,
        warning: rows.filter((r) => r.severity === 'warning').length,
        info: rows.filter((r) => r.severity === 'info').length,
        total: rows.length,
      } satisfies AttentionCount
    },
  })
}

/**
 * Whether the figures on screen are U&M's or ours.
 *
 * The hosted system has no equivalent of the offline build's "Offline draft"
 * badge, and it is the one people believe. While interim data is loaded this
 * returns what went in, and the shell shows a standing banner.
 */
export type ProvisionalState = {
  is_provisional: boolean
  what: string | null
  loaded_at: string | null
  order_prefix: string | null
  provisional_orders: number
}

export function useProvisionalState() {
  return useQuery({
    queryKey: ['provisional-state'],
    queryFn: async () =>
      (await select<ProvisionalState>('provisional_state'))[0] ?? {
        is_provisional: false,
        what: null,
        loaded_at: null,
        order_prefix: null,
        provisional_orders: 0,
      },
  })
}
