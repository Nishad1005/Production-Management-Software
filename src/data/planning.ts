import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { exec, query, resetDatabase } from '@/lib/database'

/**
 * Every figure on screen comes from a view or function in the database — the
 * same SQL that runs on Supabase. Nothing is recomputed in TypeScript, so there
 * is only one implementation of the arithmetic to be wrong.
 *
 * Numerics are cast to float8 in SQL rather than parsed here: Postgres returns
 * `numeric` as a string to preserve precision, and silently getting a string
 * where a number is expected is a bug that renders fine and sorts wrongly.
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
      (
        await query<Run>(
          // run_at is cast to text like every other date here: the driver
          // hands back a Date object otherwise, and a Date where a string is
          // expected fails at the point of use rather than at the query.
          `select id, run_at::text, note, task_count, breach_count, duration_ms,
                  horizon_from::text, horizon_to::text
             from run_history where is_current`,
        )
      )[0] ?? null,
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
      (
        await query<Kpis>(
          `select open_orders, shipment_lines, tasks, breaches, flagged_days,
                  idle_days, pinned
             from schedule_kpis where run_id = $1`,
          [runId],
        )
      )[0],
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
      query<Bottleneck>(
        `select department_id, department_code, department_name, route_position,
                avg_utilisation::float8, peak_utilisation::float8,
                flagged_days::int, idle_days::int, days_in_horizon::int,
                bottleneck_rank::int
           from schedule_bottleneck where run_id = $1 order by bottleneck_rank`,
        [runId],
      ),
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
      query<TriageRow>(
        `select department_code, load_date::text, utilisation::float8,
                over_by::float8, days_out::int, still_possible
           from schedule_flag_triage where run_id = $1
          order by load_date, department_code`,
        [runId],
      ),
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
      query<HeatmapCell>(
        `select department_id, department_code, route_position::int,
                load_date::text, utilisation::float8, status,
                components_loaded::int
           from heatmap_cell where run_id = $1
          order by route_position, load_date`,
        [runId],
      ),
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
      query<CellDetail>(
        `select erp_order_no, customer_name, component_code,
                qty_planned::float8, capacity::float8
           from load_detail
          where run_id = $1 and department_id = $2 and load_date = $3
          order by erp_order_no, component_code`,
        [runId, departmentId, loadDate],
      ),
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
      query<GanttRow>(
        `select task_id, shipment_line_id, erp_order_no, customer_name,
                confidence, line_no,
                line_qty::float8, stuffing_date::text, container_ref,
                department_code, route_position::int, component_code,
                due_date::text, start_date::text, end_date::text,
                days_needed::int, qty_required::float8,
                is_feasible, breach_reason, is_pinned
           from schedule_gantt where run_id = $1
          order by stuffing_date, erp_order_no, route_position, component_code`,
        [runId],
      ),
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
    queryKey: ['orders', runId],
    queryFn: () =>
      query<OrderRow>(
        `select order_id, erp_order_no, customer_name, article_code,
                total_qty::float8, confidence, status, line_count::int,
                unallocated_qty::float8, next_stuffing::text, breaches
           from order_book order by erp_order_no`,
      ),
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
      query<ShipmentLineRow>(
        `select id, line_no::int, qty::float8, stuffing_date::text,
                delivery_date::text, container_ref, material_ready_date::text
           from shipment_lines where order_id = $1 order by line_no`,
        [orderId],
      ),
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
    mutationFn: async (input: {
      articleId: string
      qty: number
      stuffingDate: string
    }) =>
      query<AcceptanceRow>(
        `select department_code, component_code, due_date::text, start_date::text,
                end_date::text, qty_required::float8, is_feasible, breach_reason
           from check_order_acceptance($1, $2, $3::date)`,
        [input.articleId, input.qty, input.stuffingDate],
      ),
  })
}

export type Article = { id: string; code: string; name: string }

export function useArticles() {
  return useQuery({
    queryKey: ['articles'],
    queryFn: () =>
      query<Article>(
        `select id, code, name from articles where is_active order by code`,
      ),
  })
}

export function useRunSchedule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (confidence: string[]) => {
      await exec(
        `select run_schedule(array[${confidence
          .map((c) => `'${c}'`)
          .join(',')}]::order_confidence[])`,
      )
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useResetDemo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: resetDatabase,
    onSuccess: () => client.invalidateQueries(),
  })
}

// ---------------------------------------------------------------------------
// Masters, read-only for now — enough to show the numbers the engine is using.
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
      query<DepartmentRow>(
        `select id, code, name, route_position::int, yield_pct::float8,
                shifts, headcount
           from department_master where is_active
          order by route_position`,
      ),
  })
}

export type ShiftRow = {
  id: string
  code: string
  name: string
  start_time: string
  end_time: string
  net_production_hours: number
  max_ot_hours: number
  is_active: boolean
  departments_running: number
}

export function useShifts() {
  return useQuery({
    queryKey: ['shifts'],
    queryFn: () =>
      query<ShiftRow>(
        `select id, code, name, start_label as start_time, end_label as end_time,
                net_production_hours::float8, max_ot_hours::float8,
                is_active, departments_running
           from shift_master order by start_time, code`,
      ),
  })
}

/**
 * Every active department against every shift, whether or not the pairing
 * exists. rate_count is what makes the grid honest: switching a shift on adds
 * no capacity at all until component rates exist for it, and a department
 * showing as running a shift with no rates is a trap.
 */
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
      query<DeptShiftCell>(
        `select department_id, department_code, route_position::int,
                shift_id, shift_code, shift_is_active, is_active,
                sanctioned_headcount::int, rate_count
           from department_shift_grid
          order by route_position, start_time, shift_code`,
      ),
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
      query<RateRow>(
        `select department_code, component_code, shift_code,
                units_per_day::float8, is_measured, route_position::int
           from component_rate_master
          order by route_position, component_code, shift_code`,
      ),
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
      query<DminusRow>(
        `select article_code, department_code, route_position::int,
                dminus_days::int, is_complete
           from dminus_matrix order by article_code, route_position`,
      ),
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
      query<BomRow>(
        `select article_code, component_code, component_name,
                qty_per_unit::float8
           from bom_master order by article_code, component_code`,
      ),
  })
}
