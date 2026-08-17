import { useQuery } from '@tanstack/react-query'
import { select } from '@/lib/backend'

/**
 * Phase 6 — quality.
 *
 * Nothing here counts anything. Every figure is the ledger's own qty_good and
 * qty_rejected, grouped a different way, with the reason somebody attributed.
 */

export type ParetoRow = {
  code: string
  name: string
  category: string
  qty: number
  share_pct: number
  running_pct: number
}

export function useDefectPareto() {
  return useQuery({
    queryKey: ['defect-pareto'],
    queryFn: () => select<ParetoRow>('defect_pareto', { order: ['running_pct'] }),
  })
}

export type QualityDepartment = {
  department_code: string
  department_name: string
  route_position: number
  planned_yield_pct: number
  qty_good: number
  qty_rejected: number
  rejection_pct: number | null
  measured_yield_pct: number | null
  against_plan_pct: number | null
  qty_attributed: number
  attributed_pct: number | null
  biggest_cause: string | null
  declarations: number
}

export function useQualityByDepartment() {
  return useQuery({
    queryKey: ['quality-by-department'],
    queryFn: () =>
      select<QualityDepartment>('quality_by_department', { order: ['route_position'] }),
  })
}

export type QualityArticle = {
  article_code: string
  article_name: string
  qty_good: number
  qty_rejected: number
  rejection_pct: number | null
  departments: number
}

export function useQualityByArticle() {
  return useQuery({
    queryKey: ['quality-by-article'],
    queryFn: () =>
      select<QualityArticle>('quality_by_article', { order: ['article_code'] }),
  })
}
