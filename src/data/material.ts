import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, select } from '@/lib/backend'

/**
 * Phase 5 — material.
 *
 * Quantities are not computed here. They ride on the engine's yield-inflated
 * figure in SQL, so the compounding that took Phase 2 to get right is inherited
 * rather than reimplemented in TypeScript.
 */

export type MaterialShortage = {
  material_code: string
  material_name: string
  category: string | null
  uom: string
  supplier_code: string | null
  lead_time_days: number
  qty_required: number
  qty_on_hand: number | null
  counted_on: string | null
  stock_known: boolean
  shortfall: number | null
  status: 'short' | 'covered' | 'not counted'
  first_needed_on: string
  first_order_by: string
  order_now: boolean
  jobs: number
}

export function useMaterialShortage() {
  return useQuery({
    queryKey: ['material-shortage'],
    queryFn: () =>
      select<MaterialShortage>('material_shortage', {
        order: ['first_order_by', 'material_code'],
      }),
  })
}

export type MaterialRequirement = {
  material_code: string
  material_name: string
  uom: string
  supplier_name: string | null
  article_code: string
  erp_order_no: string
  line_no: number
  department_code: string
  department_name: string
  needed_on: string
  order_by: string
  lead_time_days: number
  qty_required: number
  qty_per_unit: number
  order_now: boolean
}

export function useMaterialRequirements(materialCode: string | null) {
  return useQuery({
    queryKey: ['material-requirements', materialCode],
    enabled: Boolean(materialCode),
    queryFn: () =>
      select<MaterialRequirement>('material_requirements', {
        eq: { material_code: materialCode! },
        order: ['needed_on'],
      }),
  })
}

export type MaterialRow = {
  code: string
  name: string
  category: string | null
  uom: string
  supplier_code: string | null
  supplier_name: string | null
  lead_time_days: number
  qty_on_hand: number | null
  counted_on: string | null
  is_active: boolean
  used_by: number
}

export function useMaterials() {
  return useQuery({
    queryKey: ['materials'],
    queryFn: () => select<MaterialRow>('material_master', { order: ['category', 'code'] }),
  })
}

/**
 * Counting the store does not move a single date, so unlike a masters edit this
 * deliberately does not re-run the schedule. It changes whether the plan can be
 * *met*, which is a different question from what the plan is.
 */
export function useSetMaterialStock() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      materialCode: string
      qtyOnHand: number | null
      note?: string | null
    }) =>
      rpc('set_material_stock', {
        p_material_code: input.materialCode,
        p_qty_on_hand: input.qtyOnHand,
        p_counted_on: null,
        p_note: input.note ?? null,
      }),
    onSuccess: () => client.invalidateQueries(),
  })
}
