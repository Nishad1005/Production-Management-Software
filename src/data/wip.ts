import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, select } from '@/lib/backend'

/**
 * The WIP ledger. Everything else in Kram is a number somebody asserted — a
 * rate, a yield, a D-minus. This is what actually happened, which is the only
 * thing that can eventually contradict them.
 */

export type WorklistRow = {
  department_code: string
  department_name: string
  work_date: string
  shift_code: string
  shipment_line_id: string
  erp_order_no: string
  article_code: string
  component_code: string
  component_name: string
  qty_planned: number
  declaration_id: string | null
  qty_good: number
  qty_rejected: number
  declaration_note: string | null
  due_date: string | null
  breach_reason: string | null
}

export function useWorklist(departmentCode: string | null, date: string) {
  return useQuery({
    queryKey: ['worklist', departmentCode, date],
    // A department has to be chosen first: the worklist for "everywhere" is
    // every job in the factory, which is not a thing anyone fills in.
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<WorklistRow>('production_worklist', {
        eq: { department_code: departmentCode!, work_date: date },
        order: ['erp_order_no', 'component_code'],
      }),
  })
}

export type ProductionDay = {
  department_code: string
  work_date: string
  jobs: number
  qty_planned: number
  declared: number
}

/** The days this department is asked to work, so an empty day can say so. */
export function useProductionDays(departmentCode: string | null) {
  return useQuery({
    queryKey: ['production-days', departmentCode],
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<ProductionDay>('production_days', {
        eq: { department_code: departmentCode! },
        order: ['work_date'],
      }),
  })
}

export type PendingAcceptance = {
  declaration_id: string
  accepting_department_code: string
  from_department_code: string
  from_department_name: string
  erp_order_no: string
  article_code: string
  component_code: string
  component_name: string
  production_date: string
  qty_declared: number
  qty_rejected: number
  declaration_note: string | null
  stuffing_date: string
}

export function usePendingAcceptance(departmentCode: string | null) {
  return useQuery({
    queryKey: ['pending-acceptance', departmentCode],
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<PendingAcceptance>('wip_pending_acceptance', {
        eq: { accepting_department_code: departmentCode! },
        order: ['production_date', 'erp_order_no'],
      }),
  })
}

export type WipRow = {
  erp_order_no: string
  customer_code: string
  article_code: string
  shipment_line_id: string
  line_no: number
  line_qty: number
  stuffing_date: string
  department_code: string
  department_name: string
  route_position: number
  qty_required: number
  qty_good: number
  qty_rejected: number
  last_declared: string | null
  state: string
  fraction_done: number | null
}

export function useWipByOrder() {
  return useQuery({
    queryKey: ['wip-by-order'],
    queryFn: () =>
      select<WipRow>('wip_by_order', {
        order: ['stuffing_date', 'erp_order_no', 'route_position'],
      }),
  })
}

export type MeasuredYield = {
  department_code: string
  department_name: string
  route_position: number
  planned_yield_pct: number
  qty_good: number
  qty_rejected: number
  measured_yield_pct: number | null
  declarations: number
}

export function useMeasuredYield() {
  return useQuery({
    queryKey: ['measured-yield'],
    queryFn: () =>
      select<MeasuredYield>('measured_yield', { order: ['route_position'] }),
  })
}

/**
 * A declaration does not move any planned date, so unlike a masters edit this
 * deliberately does *not* re-run the schedule. Rescheduling the factory because
 * someone typed the morning's output would make the plan move under people all
 * day, and the plan is what they are working to.
 */
function useLedgerWrite<TInput>(fn: (input: TInput) => Promise<void>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useDeclareProduction() {
  return useLedgerWrite<{
    shipmentLineId: string
    departmentCode: string
    componentCode: string
    date: string
    shiftCode: string
    good: number
    rejected: number
    note?: string | null
  }>(async (input) => {
    await rpc('declare_production', {
      p_shipment_line_id: input.shipmentLineId,
      p_department_code: input.departmentCode,
      p_component_code: input.componentCode,
      p_date: input.date,
      p_shift_code: input.shiftCode,
      p_good: input.good,
      p_rejected: input.rejected,
      p_note: input.note ?? null,
    })
  })
}

export function useAcceptProduction() {
  return useLedgerWrite<{
    declarationId: string
    departmentCode: string
    qty: number
    note?: string | null
  }>(async ({ declarationId, departmentCode, qty, note }) => {
    await rpc('accept_production', {
      p_declaration_id: declarationId,
      p_department_code: departmentCode,
      p_qty: qty,
      p_note: note ?? null,
    })
  })
}
