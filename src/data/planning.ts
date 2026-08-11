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
             from schedule_runs where is_current`,
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
          `select
             (select count(*)::int from orders where status = 'open') as open_orders,
             (select count(*)::int from shipment_lines) as shipment_lines,
             (select count(*)::int from schedule_tasks where run_id = $1) as tasks,
             (select count(*)::int from schedule_tasks
               where run_id = $1 and not is_feasible) as breaches,
             (select count(*)::int from schedule_department_day
               where run_id = $1 and status = 'over') as flagged_days,
             (select count(*)::int from schedule_department_day
               where run_id = $1 and status = 'idle') as idle_days,
             (select count(*)::int from schedule_tasks
               where run_id = $1 and is_pinned) as pinned`,
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
        `select dd.department_id, d.code as department_code, d.route_position::int,
                dd.load_date::text, dd.utilisation::float8, dd.status,
                dd.components_loaded::int
           from schedule_department_day dd
           join departments d on d.id = dd.department_id
          where dd.run_id = $1
          order by d.route_position, dd.load_date`,
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
        `select o.erp_order_no, cu.name as customer_name, cmp.code as component_code,
                sum(l.qty_planned)::float8 as qty_planned,
                max(cap.capacity)::float8 as capacity
           from schedule_daily_load l
           join shipment_lines sl on sl.id = l.shipment_line_id
           join orders o on o.id = sl.order_id
           join customers cu on cu.id = o.customer_id
           join components cmp on cmp.id = l.component_id
           left join (
             select run_id, department_id, component_id, load_date, sum(capacity) as capacity
               from schedule_daily_capacity group by 1,2,3,4
           ) cap on cap.run_id = l.run_id and cap.department_id = l.department_id
                and cap.component_id = l.component_id and cap.load_date = l.load_date
          where l.run_id = $1 and l.department_id = $2 and l.load_date = $3
          group by o.erp_order_no, cu.name, cmp.code
          order by o.erp_order_no, cmp.code`,
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
        `select o.id as order_id, o.erp_order_no, cu.name as customer_name,
                a.code as article_code, o.total_qty::float8, o.confidence, o.status,
                r.line_count::int, r.unallocated_qty::float8,
                (select min(sl.stuffing_date)::text from shipment_lines sl
                  where sl.order_id = o.id) as next_stuffing,
                (select count(*)::int from schedule_tasks t
                   join shipment_lines sl on sl.id = t.shipment_line_id
                  where sl.order_id = o.id and t.run_id = $1 and not t.is_feasible
                ) as breaches
           from orders o
           join customers cu on cu.id = o.customer_id
           join articles a on a.id = o.article_id
           join order_qty_reconciliation r on r.order_id = o.id
          where cu.code <> '__ACCEPTANCE_CHECK__'
          order by o.erp_order_no`,
        [runId ?? null],
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
        `select d.id, d.code, d.name, d.route_position::int, d.yield_pct::float8,
                string_agg(s.code, ', ' order by s.code) as shifts,
                sum(ds.sanctioned_headcount)::int as headcount
           from departments d
           left join department_shifts ds on ds.department_id = d.id and ds.is_active
           left join shifts s on s.id = ds.shift_id and s.is_active
          where d.is_active
          group by d.id, d.code, d.name, d.route_position, d.yield_pct
          order by d.route_position`,
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
        `select d.code as department_code, cmp.code as component_code,
                s.code as shift_code, cr.units_per_day::float8, cr.is_measured,
                d.route_position::int
           from component_rates cr
           join departments d on d.id = cr.department_id
           join components cmp on cmp.id = cr.component_id
           join shifts s on s.id = cr.shift_id
          order by d.route_position, cmp.code, s.code`,
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
        `select a.code as article_code, d.code as department_code,
                d.route_position::int, adm.dminus_days::int, adm.is_complete
           from article_dept_dminus adm
           join articles a on a.id = adm.article_id
           join departments d on d.id = adm.department_id
          where a.is_active and d.is_active
          order by a.code, d.route_position`,
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
        `select a.code as article_code, c.code as component_code,
                c.name as component_name, b.qty_per_unit::float8
           from article_bom b
           join articles a on a.id = b.article_id
           join components c on c.id = b.component_id
          order by a.code, c.code`,
      ),
  })
}
