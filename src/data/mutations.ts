import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, select } from '@/lib/backend'

/**
 * Writes.
 *
 * Every one calls a database function rather than issuing SQL. Two reasons: the
 * rules stay next to the data — the D-minus completeness rule, the rate copying
 * when a shift is switched on — and PostgREST can call functions but not
 * arbitrary SQL, so this is what lets the same client work against Supabase.
 *
 * Spec §11: "Recomputation runs on order or master change (debounced), on
 * demand, and nightly." Anything that changes the arithmetic re-runs the
 * schedule immediately here — a run costs about a tenth of a second, and a
 * screen showing a plan that no longer matches its inputs is worse than one
 * that pauses briefly.
 */

async function rerunSchedule() {
  await rpc('run_schedule', { p_note: 'Recomputed after change' })
}

/** Every write invalidates everything: the schedule touches all of it. */
function useWrite<TInput>(
  fn: (input: TInput) => Promise<void>,
  { rerun = true }: { rerun?: boolean } = {},
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      await fn(input)
      if (rerun) await rerunSchedule()
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type Customer = { id: string; code: string; name: string }

export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
    queryFn: () =>
      select<Customer>('customer_list', {
        eq: { is_active: true },
        order: ['name'],
      }),
  })
}

/**
 * Until this existed there was no way to add a customer, so on a fresh database
 * no order could ever be entered — the order form picks from a list that
 * nothing could fill. The offline seed ships three customers, which hid it
 * completely.
 */
export function useCreateCustomer() {
  return useWrite<{ code: string; name: string; country?: string }>(
    async ({ code, name, country }) => {
      await rpc('create_customer', {
        p_code: code,
        p_name: name,
        p_country: country || null,
      })
    },
    { rerun: false },
  )
}

export type NewOrder = {
  erpOrderNo: string
  customerId: string
  articleId: string
  confidence: string
  qty: number
  stuffingDate: string
  deliveryDate?: string | null
  containerRef?: string | null
  materialReadyDate?: string | null
}

export function useCreateOrder() {
  return useWrite<NewOrder>(async (o) => {
    await rpc('create_order', {
      p_erp_order_no: o.erpOrderNo,
      p_customer_id: o.customerId,
      p_article_id: o.articleId,
      p_qty: o.qty,
      p_stuffing_date: o.stuffingDate,
      p_confidence: o.confidence,
      p_delivery_date: o.deliveryDate || null,
      p_container_ref: o.containerRef || null,
      p_material_ready_date: o.materialReadyDate || null,
    })
  })
}

export type NewShipmentLine = {
  orderId: string
  qty: number
  stuffingDate: string
  deliveryDate?: string | null
  containerRef?: string | null
  materialReadyDate?: string | null
}

export function useAddShipmentLine() {
  return useWrite<NewShipmentLine>(async (l) => {
    await rpc('add_shipment_line', {
      p_order_id: l.orderId,
      p_qty: l.qty,
      p_stuffing_date: l.stuffingDate,
      p_delivery_date: l.deliveryDate || null,
      p_container_ref: l.containerRef || null,
      p_material_ready_date: l.materialReadyDate || null,
    })
  })
}

export function useDeleteShipmentLine() {
  return useWrite<string>(async (id) => {
    await rpc('delete_shipment_line', {
      p_id: id,
    })
  })
}

export function useDeleteOrder() {
  return useWrite<string>(async (id) => {
    await rpc('delete_order', {
      p_id: id,
    })
  })
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

export function useSetDminus() {
  return useWrite<{
    articleCode: string
    departmentCode: string
    days: number | null
  }>(async ({ articleCode, departmentCode, days }) => {
    await rpc('set_dminus', {
      p_article_code: articleCode,
      p_department_code: departmentCode,
      p_days: days,
    })
  })
}

export function useSetRate() {
  return useWrite<{
    componentCode: string
    departmentCode: string
    shiftCode: string
    unitsPerDay: number
  }>(async ({ componentCode, departmentCode, shiftCode, unitsPerDay }) => {
    await rpc('set_component_rate', {
      p_component_code: componentCode,
      p_department_code: departmentCode,
      p_shift_code: shiftCode,
      p_units_per_day: unitsPerDay,
    })
  })
}

export function useUpdateDepartment() {
  return useWrite<{
    id: string
    name?: string
    yieldPct?: number
    routePosition?: number
  }>(async ({ id, name, yieldPct, routePosition }) => {
    await rpc('update_department', {
      p_id: id,
      p_name: name ?? null,
      p_yield_pct: yieldPct ?? null,
      p_route_position: routePosition ?? null,
    })
  })
}

export function useSetHeadcount() {
  return useWrite<{
    departmentCode: string
    shiftCode: string
    headcount: number
  }>(
    async ({ departmentCode, shiftCode, headcount }) => {
      await rpc('set_headcount', {
      p_department_code: departmentCode,
      p_shift_code: shiftCode,
      p_headcount: headcount,
    })
    },
    // Headcount does not feed capacity directly — component rates do. It is the
    // denominator in the overtime maths, which is Phase 4.
    { rerun: false },
  )
}

export function useCreateDepartment() {
  return useWrite<{
    code: string
    name: string
    routePosition: number
    yieldPct: number
  }>(async ({ code, name, routePosition, yieldPct }) => {
    await rpc('create_department', {
      p_code: code,
      p_name: name,
      p_route_position: routePosition,
      p_yield_pct: yieldPct,
    })
  })
}

export function useSetDepartmentActive() {
  return useWrite<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      await rpc('set_department_active', {
      p_id: id,
      p_is_active: isActive,
    })
    },
  )
}

// ---------------------------------------------------------------------------
// Articles
//
// In the finished system these arrive from Panipuri. Until that export exists —
// and U&M say it will take time — somebody has to be able to add one, and the
// capacity sheet has been telling people to do it from Masters since before
// there was anything there to do it with.
// ---------------------------------------------------------------------------

export type ArticleMasterRow = {
  code: string
  name: string
  category: string | null
  is_active: boolean
  unit_cost: number | null
  departments_routed: number
  missing_dminus: number
  can_schedule: boolean
  open_orders: number
}

export function useArticleMaster() {
  return useQuery({
    queryKey: ['article-master'],
    queryFn: () => select<ArticleMasterRow>('article_master', { order: ['code'] }),
  })
}

export function useSetArticle() {
  return useWrite<{ code: string; name: string; category?: string | null }>(
    async ({ code, name, category }) => {
      await rpc('set_article', {
        p_code: code,
        p_name: name,
        p_category: category ?? null,
      })
    },
  )
}

export function useSetArticleActive() {
  return useWrite<{ code: string; isActive: boolean }>(
    async ({ code, isActive }) => {
      await rpc('set_article_active', { p_code: code, p_is_active: isActive })
    },
  )
}

// ---------------------------------------------------------------------------
// Machines
//
// A machine going down changes what its department can make that day, so unlike
// a stock count these do re-run the schedule.
// ---------------------------------------------------------------------------

export type MachineRow = {
  code: string
  name: string
  department_code: string
  department_name: string
  route_position: number
  machine_type: string | null
  asset_no: string | null
  is_active: boolean
  down_today: boolean
  down_reason: string | null
  next_down_on: string | null
}

export function useMachines() {
  return useQuery({
    queryKey: ['machines'],
    queryFn: () =>
      select<MachineRow>('machine_master', { order: ['route_position', 'code'] }),
  })
}

export type MachineStatusRow = {
  department_code: string
  department_name: string
  route_position: number
  machines: number
  available: number
  available_pct: number
}

export function useMachineStatus() {
  return useQuery({
    queryKey: ['machine-status'],
    queryFn: () =>
      select<MachineStatusRow>('machine_status', { order: ['route_position'] }),
  })
}

export type MachineDowntimeRow = {
  id: string
  machine_code: string
  machine_name: string
  department_code: string
  from_date: string
  to_date: string
  kind: string
  reason: string
  active_today: boolean
  upcoming: boolean
  days: number
}

export function useMachineDowntime() {
  return useQuery({
    queryKey: ['machine-downtime'],
    queryFn: () =>
      select<MachineDowntimeRow>('machine_downtime_list', { order: ['from_date'] }),
  })
}

export function useSetMachine() {
  return useWrite<{
    code: string
    name: string
    departmentCode: string
    machineType?: string | null
  }>(async ({ code, name, departmentCode, machineType }) => {
    await rpc('set_machine', {
      p_code: code,
      p_name: name,
      p_department_code: departmentCode,
      p_machine_type: machineType ?? null,
    })
  })
}

export function useSetMachineActive() {
  return useWrite<{ code: string; isActive: boolean }>(async ({ code, isActive }) => {
    await rpc('set_machine_active', { p_code: code, p_is_active: isActive })
  })
}

export function useSetMachineDowntime() {
  return useWrite<{
    machineCode: string
    fromDate: string
    toDate: string
    reason: string
    kind: string
  }>(async ({ machineCode, fromDate, toDate, reason, kind }) => {
    await rpc('set_machine_downtime', {
      p_machine_code: machineCode,
      p_from_date: fromDate,
      p_to_date: toDate,
      p_reason: reason,
      p_kind: kind,
    })
  })
}

export function useClearMachineDowntime() {
  return useWrite<{ id: string }>(async ({ id }) => {
    await rpc('clear_machine_downtime', { p_id: id })
  })
}

// ---------------------------------------------------------------------------
// Shifts
//
// Spec §2 calls the multi-shift model Rev B's structural correction: a
// department running two shifts has roughly double the daily capacity, and the
// overtime ceiling applies per person per shift rather than per day.
// ---------------------------------------------------------------------------

export function useUpdateShift() {
  return useWrite<{
    id: string
    name?: string
    netProductionHours?: number
    maxOtHours?: number
  }>(async ({ id, name, netProductionHours, maxOtHours }) => {
    await rpc('update_shift', {
      p_id: id,
      p_name: name ?? null,
      p_net_production_hours: netProductionHours ?? null,
      p_max_ot_hours: maxOtHours ?? null,
    })
  })
}

export function useSetShiftActive() {
  return useWrite<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      await rpc('set_shift_active', {
      p_id: id,
      p_is_active: isActive,
    })
    },
  )
}

/**
 * Turns a shift on or off for one department. The function copies the
 * department's rates and establishment across when switching one on, because a
 * pairing with no rates contributes exactly nothing while appearing to run.
 */
export function useSetDepartmentShift() {
  return useWrite<{
    departmentCode: string
    shiftCode: string
    isActive: boolean
    headcount?: number
  }>(async ({ departmentCode, shiftCode, isActive, headcount }) => {
    await rpc('set_department_shift', {
      p_department_code: departmentCode,
      p_shift_code: shiftCode,
      p_is_active: isActive,
      p_headcount: headcount ?? null,
    })
  })
}

/**
 * Adds or removes one edge of the route graph. Every date in every plan moves
 * with it, so the schedule reruns — which is why this goes through useWrite
 * rather than a bare rpc.
 *
 * An edge that would close a loop is refused by the database, not checked here.
 * The rule belongs where the data is, and a check in the browser would be a
 * second opinion that could disagree with it.
 */
export function useSetDependency() {
  return useWrite<{
    departmentCode: string
    feederCode: string
    feeds: boolean
  }>(async ({ departmentCode, feederCode, feeds }) => {
    await rpc('set_department_dependency', {
      p_department_code: departmentCode,
      p_depends_on_code: feederCode,
      p_enabled: feeds,
    })
  })
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type Holiday = { id: string; holiday_date: string; description: string }

export function useHolidays() {
  return useQuery({
    queryKey: ['holidays'],
    queryFn: () =>
      select<Holiday>('holiday_list', { order: ['holiday_date'] }),
  })
}

export function useAddHoliday() {
  return useWrite<{ date: string; description: string }>(
    async ({ date, description }) => {
      await rpc('add_holiday', {
      p_date: date,
      p_description: description,
    })
    },
  )
}

export function useDeleteHoliday() {
  return useWrite<string>(async (id) => {
    await rpc('remove_holiday', {
      p_id: id,
    })
  })
}

// ---------------------------------------------------------------------------
// Pins
//
// Spec §6: a pin is a decision about the factory and outlives the plan that
// prompted it. The reason is mandatory — a pin without one is indistinguishable
// from a mistake six weeks later.
// ---------------------------------------------------------------------------

export function useCreatePin() {
  return useWrite<{
    shipmentLineId: string
    departmentCode: string
    componentCode: string
    startDate: string
    reason: string
  }>(async (p) => {
    await rpc('create_pin', {
      p_shipment_line_id: p.shipmentLineId,
      p_department_code: p.departmentCode,
      p_component_code: p.componentCode,
      p_start_date: p.startDate,
      p_reason: p.reason,
    })
  })
}

export function useReleasePin() {
  return useWrite<{
    shipmentLineId: string
    departmentCode: string
    componentCode: string
  }>(async (p) => {
    // Released, never deleted: the record of who moved what, and why, is the
    // point of asking for a reason in the first place.
    await rpc('release_pin', {
      p_shipment_line_id: p.shipmentLineId,
      p_department_code: p.departmentCode,
      p_component_code: p.componentCode,
    })
  })
}

export type PinRow = {
  id: string
  shipment_line_id: string
  erp_order_no: string
  line_no: number
  department_code: string
  component_code: string
  pinned_start_date: string
  reason: string
}

export function usePins() {
  return useQuery({
    queryKey: ['pins'],
    queryFn: () =>
      select<PinRow>('pin_list', { order: ['pinned_start_date'] }),
  })
}
