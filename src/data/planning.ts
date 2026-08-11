import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { backend, rpc, rpcRows, select } from '@/lib/backend'

/**
 * Every figure on screen comes from a view or a function in the database — the
 * same SQL whether it runs in the browser or on Supabase. Nothing is recomputed
 * in TypeScript, so there is only one implementation of the arithmetic to be
 * wrong.
 *
 * The views cast every column to the type wanted here, so nothing needs parsing
 * or converting on the way out.
 */

export type Run = {
  id: string
  run_at: string
  note: string | null
  task_count: number
  breach_count: number
  duration_ms: number | null
  horizon_from: string | null
  horizon_to: string | null
}

export function useCurrentRun() {
  return useQuery({
    queryKey: ['run', 'current'],
    queryFn: async () =>
      (await select<Run>('run_history', { eq: { is_current: true } }))[0] ??
      null,
  })
}

export type Kpis = {
  open_orders: number
  shipment_lines: number
  tasks: number
  breaches: number
  flagged_days: number
  idle_days: number
  pinned: number
}

export function useKpis(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['kpis', runId],
    queryFn: async () =>
      (await select<Kpis>('schedule_kpis', { eq: { run_id: runId } }))[0],
  })
}

export type Bottleneck = {
  department_id: string
  department_code: string
  department_name: string
  route_position: number
  avg_utilisation: number
  peak_utilisation: number
  flagged_days: number
  idle_days: number
  days_in_horizon: number
  bottleneck_rank: number
}

export function useBottlenecks(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['bottleneck', runId],
    queryFn: () =>
      select<Bottleneck>('schedule_bottleneck', {
        eq: { run_id: runId },
        order: ['bottleneck_rank'],
      }),
  })
}

export type TriageRow = {
  department_code: string
  load_date: string
  utilisation: number
  over_by: number
  days_out: number
  still_possible: string
}

export function useFlagTriage(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['triage', runId],
    queryFn: () =>
      select<TriageRow>('schedule_flag_triage', {
        eq: { run_id: runId },
        order: ['load_date', 'department_code'],
      }),
  })
}

export type HeatmapCell = {
  department_id: string
  department_code: string
  route_position: number
  load_date: string
  utilisation: number
  status: 'over' | 'loaded' | 'idle'
  components_loaded: number
}

export function useHeatmap(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['heatmap', runId],
    queryFn: () =>
      select<HeatmapCell>('heatmap_cell', {
        eq: { run_id: runId },
        order: ['route_position', 'load_date'],
      }),
  })
}

/** What is on a given department-day, for the heatmap detail panel. */
export type CellDetail = {
  erp_order_no: string
  customer_name: string
  component_code: string
  qty_planned: number
  capacity: number
}

export function useCellDetail(
  runId: string | undefined,
  departmentId: string | undefined,
  loadDate: string | undefined,
) {
  return useQuery({
    enabled: Boolean(runId && departmentId && loadDate),
    queryKey: ['cell', runId, departmentId, loadDate],
    queryFn: () =>
      select<CellDetail>('load_detail', {
        eq: {
          run_id: runId,
          department_id: departmentId,
          load_date: loadDate,
        },
        order: ['erp_order_no', 'component_code'],
      }),
  })
}

export type GanttRow = {
  task_id: string
  shipment_line_id: string
  erp_order_no: string
  customer_name: string
  confidence: string
  line_no: number
  line_qty: number
  stuffing_date: string
  container_ref: string | null
  department_code: string
  route_position: number
  component_code: string
  due_date: string | null
  start_date: string | null
  end_date: string | null
  days_needed: number | null
  qty_required: number
  is_feasible: boolean
  breach_reason: string | null
  is_pinned: boolean
}

export function useGantt(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['gantt', runId],
    queryFn: () =>
      select<GanttRow>('schedule_gantt', {
        eq: { run_id: runId },
        order: [
          'stuffing_date',
          'erp_order_no',
          'route_position',
          'component_code',
        ],
      }),
  })
}

export type OrderRow = {
  order_id: string
  erp_order_no: string
  customer_name: string
  article_code: string
  total_qty: number
  confidence: string
  status: string
  line_count: number
  unallocated_qty: number
  next_stuffing: string | null
  breaches: number
}

export function useOrders(runId: string | undefined) {
  return useQuery({
    // The view counts breaches against the live plan, so a new run has to
    // invalidate this even though the run is not a filter.
    queryKey: ['orders', runId],
    queryFn: () => select<OrderRow>('order_book', { order: ['erp_order_no'] }),
  })
}

export type ShipmentLineRow = {
  id: string
  line_no: number
  qty: number
  stuffing_date: string
  delivery_date: string | null
  container_ref: string | null
  material_ready_date: string | null
}

export function useShipmentLines(orderId: string | undefined) {
  return useQuery({
    enabled: Boolean(orderId),
    queryKey: ['lines', orderId],
    queryFn: () =>
      select<ShipmentLineRow>('shipment_line_list', {
        eq: { order_id: orderId },
        order: ['line_no'],
      }),
  })
}

export type AcceptanceRow = {
  department_code: string
  component_code: string
  due_date: string | null
  start_date: string | null
  end_date: string | null
  qty_required: number
  is_feasible: boolean
  breach_reason: string | null
}

/** Spec §14 — the check that finds the problem before the commitment. */
export function useAcceptanceCheck() {
  return useMutation({
    mutationFn: (input: {
      articleId: string
      qty: number
      stuffingDate: string
    }) =>
      rpcRows<AcceptanceRow>('check_order_acceptance', {
        p_article_id: input.articleId,
        p_qty: input.qty,
        p_stuffing_date: input.stuffingDate,
      }),
  })
}

export type Article = { id: string; code: string; name: string }

export function useArticles() {
  return useQuery({
    queryKey: ['articles'],
    queryFn: () =>
      select<Article>('article_list', {
        eq: { is_active: true },
        order: ['code'],
      }),
  })
}

export function useRunSchedule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (confidence: string[]) =>
      rpc('run_schedule', { p_confidence: confidence }),
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useResetDemo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await backend.reset?.()
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

export type DepartmentRow = {
  id: string
  code: string
  name: string
  route_position: number
  yield_pct: number
  shifts: string | null
  headcount: number | null
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () =>
      select<DepartmentRow>('department_master', {
        eq: { is_active: true },
        order: ['route_position'],
      }),
  })
}

export type ShiftRow = {
  id: string
  code: string
  name: string
  start_label: string
  end_label: string
  net_production_hours: number
  max_ot_hours: number
  is_active: boolean
  departments_running: number
}

export function useShifts() {
  return useQuery({
    queryKey: ['shifts'],
    queryFn: () =>
      select<ShiftRow>('shift_master', { order: ['start_time', 'code'] }),
  })
}

export type DeptShiftCell = {
  department_id: string
  department_code: string
  route_position: number
  shift_id: string
  shift_code: string
  shift_is_active: boolean
  is_active: boolean
  sanctioned_headcount: number | null
  rate_count: number
}

export function useDepartmentShiftGrid() {
  return useQuery({
    queryKey: ['department-shifts'],
    queryFn: () =>
      select<DeptShiftCell>('department_shift_grid', {
        order: ['route_position', 'start_time', 'shift_code'],
      }),
  })
}

export type RateRow = {
  department_code: string
  component_code: string
  shift_code: string
  units_per_day: number
  is_measured: boolean
  route_position: number
}

export function useRates() {
  return useQuery({
    queryKey: ['rates'],
    queryFn: () =>
      select<RateRow>('component_rate_master', {
        order: ['route_position', 'component_code', 'shift_code'],
      }),
  })
}

export type DminusRow = {
  article_code: string
  department_code: string
  route_position: number
  dminus_days: number | null
  is_complete: boolean
}

export function useDminus() {
  return useQuery({
    queryKey: ['dminus'],
    queryFn: () =>
      select<DminusRow>('dminus_matrix', {
        order: ['article_code', 'route_position'],
      }),
  })
}

export type BomRow = {
  article_code: string
  component_code: string
  component_name: string
  qty_per_unit: number
}

export function useBom() {
  return useQuery({
    queryKey: ['bom'],
    queryFn: () =>
      select<BomRow>('bom_master', {
        order: ['article_code', 'component_code'],
      }),
  })
}
