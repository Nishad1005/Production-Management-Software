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

export type ProductionVsPlan = {
  department_code: string
  department_name: string
  route_position: number
  work_date: string
  qty_planned: number
  qty_good: number
  qty_rejected: number
  variance: number
}

/**
 * Planned against declared, per department per day — deck slide 11. A full
 * join in SQL, so a day with output nobody planned shows up as loudly as a
 * planned day with no output.
 */
export function useProductionVsPlan(from: string, to: string) {
  return useQuery({
    queryKey: ['production-vs-plan', from, to],
    queryFn: () =>
      select<ProductionVsPlan>('production_vs_plan', {
        gte: { work_date: from },
        lte: { work_date: to },
        order: ['work_date', 'route_position'],
      }),
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

// ---------------------------------------------------------------------------
// Today's capacity
//
// U&M: "day rate is variable, can we give an option to put it in by the end
// user." Three things vary and they named all three — the article (the capacity
// sheet, already editable), the day (an override), and how many people turned
// up (attendance, which scales the rate in proportion to the crew it was
// measured with).
// ---------------------------------------------------------------------------

export type DepartmentDay = {
  department_code: string
  department_name: string
  route_position: number
  shift_code: string
  sanctioned: number
  present: number | null
  attendance_note: string | null
  attendance_date: string | null
  override_units: number | null
  override_reason: string | null
  attendance_fraction: number | null
  rates: number
  rates_with_crew: number
}

export function useDepartmentDay(departmentCode: string | null) {
  return useQuery({
    queryKey: ['department-day', departmentCode],
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<DepartmentDay>('department_day', {
        eq: { department_code: departmentCode! },
        order: ['shift_code'],
      }),
  })
}

/**
 * Capacity *is* what the engine reads, so unlike a production declaration these
 * do move the plan — and the schedule reruns.
 */
function useCapacityWrite<TInput>(fn: (input: TInput) => Promise<void>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      await fn(input)
      await rpc('run_schedule', { p_note: "Recomputed after a change to today's capacity" })
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useSetAttendance() {
  return useCapacityWrite<{
    departmentCode: string
    shiftCode: string
    date: string
    present: number | null
    note?: string | null
  }>(async ({ departmentCode, shiftCode, date, present, note }) => {
    await rpc('set_attendance', {
      p_department_code: departmentCode,
      p_shift_code: shiftCode,
      p_date: date,
      p_present: present,
      p_note: note ?? null,
    })
  })
}

export function useSetDayCapacity() {
  return useCapacityWrite<{
    departmentCode: string
    shiftCode: string
    date: string
    units: number | null
    reason?: string | null
  }>(async ({ departmentCode, shiftCode, date, units, reason }) => {
    await rpc('set_day_capacity', {
      p_department_code: departmentCode,
      p_shift_code: shiftCode,
      p_date: date,
      p_units: units,
      p_reason: reason ?? null,
    })
  })
}

// ---------------------------------------------------------------------------
// The department's own board
//
// U&M: "what are the pending remaining for that day, work order or according to
// their shipping date, and from which department a component has to come so as
// to I can start my work."
// ---------------------------------------------------------------------------

export type QueueRow = {
  department_code: string
  erp_order_no: string
  customer_code: string
  article_code: string
  article_name: string
  component_code: string
  shipment_line_id: string
  line_no: number
  stuffing_date: string
  days_to_stuffing: number
  due_date: string | null
  days_to_due: number | null
  qty_required: number
  qty_done: number
  qty_remaining: number
  qty_rejected: number
  last_declared: string | null
  breach_reason: string | null
  state: string
}

export function useDepartmentQueue(departmentCode: string | null) {
  return useQuery({
    queryKey: ['department-queue', departmentCode],
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<QueueRow>('department_queue', {
        eq: { department_code: departmentCode! },
        // The container it ships in, soonest first. Their words: "according to
        // their shipping date".
        order: ['stuffing_date', 'erp_order_no'],
      }),
  })
}

export type InboundRow = {
  department_code: string
  from_department_code: string
  from_department_name: string
  from_route_position: number
  erp_order_no: string
  article_code: string
  shipment_line_id: string
  stuffing_date: string
  their_due_date: string | null
  days_to_their_due: number | null
  qty_required: number
  qty_made: number
  qty_counted_in: number
  last_declared: string | null
  state: string
}

export function useDepartmentInbound(departmentCode: string | null) {
  return useQuery({
    queryKey: ['department-inbound', departmentCode],
    enabled: Boolean(departmentCode),
    queryFn: () =>
      select<InboundRow>('department_inbound', {
        eq: { department_code: departmentCode! },
        order: ['stuffing_date', 'from_route_position'],
      }),
  })
}

/**
 * Where each shipment line has actually got to.
 *
 * wip_by_order has existed since Phase 3 with nothing rendering it — the one
 * thing U&M say they most want, computed and invisible. This is the per-line
 * summary the screen reads.
 */
export type WipLine = {
  erp_order_no: string
  customer_code: string
  article_code: string
  shipment_line_id: string
  line_no: number
  line_qty: number
  stuffing_date: string
  days_to_stuffing: number
  departments: number
  departments_done: number
  departments_running: number
  last_declared: string | null
  fraction_done: number
  started: boolean
  complete: boolean
}

export function useWipLines() {
  return useQuery({
    queryKey: ['wip-lines'],
    queryFn: () =>
      select<WipLine>('wip_lines', { order: ['stuffing_date', 'erp_order_no'] }),
  })
}
