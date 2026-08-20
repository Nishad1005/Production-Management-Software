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
