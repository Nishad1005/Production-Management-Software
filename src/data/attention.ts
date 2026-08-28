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

export function useAttention() {
  return useQuery({
    queryKey: ['attention'],
    queryFn: () => select<Finding>('attention', { order: ['days_out'] }),
  })
}

export type AttentionCount = {
  critical: number
  warning: number
  info: number
  total: number
}

/**
 * A separate small query, so the header badge on every screen costs one count
 * rather than fetching every finding in the factory.
 */
export function useAttentionCount() {
  return useQuery({
    queryKey: ['attention-count'],
    queryFn: async () =>
      (await select<AttentionCount>('attention_count'))[0] ?? {
        critical: 0,
        warning: 0,
        info: 0,
        total: 0,
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
