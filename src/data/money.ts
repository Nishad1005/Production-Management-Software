import { useQuery } from '@tanstack/react-query'
import { select } from '@/lib/backend'

/**
 * Phase 8 — money.
 *
 * Costs and money out. Nothing here touches revenue: no order in Kram carries a
 * value, and a cash-flow screen showing money in with nothing behind it would
 * be the most believable wrong number in the system.
 */

export type CostSummary = {
  article_code: string
  article_name: string
  unit_cost: number | null
  lines: number
  has_breakdown: boolean
  material_cost: number
  labour_cost: number
  packing_and_freight: number
  overhead: number
}

export function useCostSummary() {
  return useQuery({
    queryKey: ['article-cost-summary'],
    queryFn: () =>
      select<CostSummary>('article_cost_summary', { order: ['article_code'] }),
  })
}

export type CostLine = {
  article_code: string
  cost_line_code: string
  cost_line_name: string
  kind: string
  sort_order: number
  amount: number
  share_pct: number
}

export function useCostBreakdown(articleCode: string | null) {
  return useQuery({
    queryKey: ['article-cost-breakdown', articleCode],
    enabled: Boolean(articleCode),
    queryFn: () =>
      select<CostLine>('article_cost_breakdown', {
        eq: { article_code: articleCode! },
        order: ['sort_order'],
      }),
  })
}

export type CashWeek = {
  week_starting: string
  amount: number | null
  priced_lines: number
  unpriced_lines: number
  suppliers: number
  first_due: string
  overdue: boolean
}

export function useCashOutWeekly() {
  return useQuery({
    queryKey: ['cash-out-weekly'],
    queryFn: () =>
      select<CashWeek>('cash_out_weekly', { order: ['week_starting'] }),
  })
}

export type SupplierCommitment = {
  supplier_code: string
  supplier_name: string
  payment_terms_days: number
  amount: number | null
  lines: number
  unpriced_lines: number
  first_due: string
  materials: number
}

export function useSupplierCommitments() {
  return useQuery({
    queryKey: ['supplier-commitments'],
    queryFn: () =>
      select<SupplierCommitment>('supplier_commitments', { order: ['first_due'] }),
  })
}
