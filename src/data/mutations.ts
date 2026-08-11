import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { exec, query } from '@/lib/database'

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
  await exec(`select run_schedule(p_note => 'Recomputed after change')`)
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
      query<Customer>(
        // The acceptance check's internal customer is not a real one.
        `select id, code, name from customers
          where is_active and code <> '__ACCEPTANCE_CHECK__'
          order by name`,
      ),
  })
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
    await query(
      `select create_order($1, $2, $3, $4::numeric, $5::date,
                           $6::order_confidence, $7::date, $8, $9::date)`,
      [
        o.erpOrderNo,
        o.customerId,
        o.articleId,
        o.qty,
        o.stuffingDate,
        o.confidence,
        o.deliveryDate || null,
        o.containerRef || null,
        o.materialReadyDate || null,
      ],
    )
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
    await query(
      `select add_shipment_line($1, $2::numeric, $3::date, $4::date, $5, $6::date)`,
      [
        l.orderId,
        l.qty,
        l.stuffingDate,
        l.deliveryDate || null,
        l.containerRef || null,
        l.materialReadyDate || null,
      ],
    )
  })
}

export function useDeleteShipmentLine() {
  return useWrite<string>(async (id) => {
    await query(`select delete_shipment_line($1)`, [id])
  })
}

export function useDeleteOrder() {
  return useWrite<string>(async (id) => {
    await query(`select delete_order($1)`, [id])
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
    await query(`select set_dminus($1, $2, $3::integer)`, [
      articleCode,
      departmentCode,
      days,
    ])
  })
}

export function useSetRate() {
  return useWrite<{
    componentCode: string
    departmentCode: string
    shiftCode: string
    unitsPerDay: number
  }>(async ({ componentCode, departmentCode, shiftCode, unitsPerDay }) => {
    await query(`select set_component_rate($1, $2, $3, $4::numeric)`, [
      componentCode,
      departmentCode,
      shiftCode,
      unitsPerDay,
    ])
  })
}

export function useUpdateDepartment() {
  return useWrite<{
    id: string
    name?: string
    yieldPct?: number
    routePosition?: number
  }>(async ({ id, name, yieldPct, routePosition }) => {
    await query(`select update_department($1, $2, $3::numeric, $4::integer)`, [
      id,
      name ?? null,
      yieldPct ?? null,
      routePosition ?? null,
    ])
  })
}

export function useSetHeadcount() {
  return useWrite<{
    departmentCode: string
    shiftCode: string
    headcount: number
  }>(
    async ({ departmentCode, shiftCode, headcount }) => {
      await query(`select set_headcount($1, $2, $3::integer)`, [
        departmentCode,
        shiftCode,
        headcount,
      ])
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
    await query(`select create_department($1, $2, $3::integer, $4::numeric)`, [
      code,
      name,
      routePosition,
      yieldPct,
    ])
  })
}

export function useSetDepartmentActive() {
  return useWrite<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      await query(`select set_department_active($1, $2)`, [id, isActive])
    },
  )
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
    await query(`select update_shift($1, $2, $3::numeric, $4::numeric)`, [
      id,
      name ?? null,
      netProductionHours ?? null,
      maxOtHours ?? null,
    ])
  })
}

export function useSetShiftActive() {
  return useWrite<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      await query(`select set_shift_active($1, $2)`, [id, isActive])
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
    await query(`select set_department_shift($1, $2, $3, $4::integer)`, [
      departmentCode,
      shiftCode,
      isActive,
      headcount ?? null,
    ])
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
      query<Holiday>(
        `select id, holiday_date::text, description from holidays
          order by holiday_date`,
      ),
  })
}

export function useAddHoliday() {
  return useWrite<{ date: string; description: string }>(
    async ({ date, description }) => {
      await query(`select add_holiday($1::date, $2)`, [date, description])
    },
  )
}

export function useDeleteHoliday() {
  return useWrite<string>(async (id) => {
    await query(`select remove_holiday($1)`, [id])
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
    await query(`select create_pin($1, $2, $3, $4::date, $5)`, [
      p.shipmentLineId,
      p.departmentCode,
      p.componentCode,
      p.startDate,
      p.reason,
    ])
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
    await query(`select release_pin($1, $2, $3)`, [
      p.shipmentLineId,
      p.departmentCode,
      p.componentCode,
    ])
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
      query<PinRow>(
        `select id, shipment_line_id, erp_order_no, line_no::int,
                department_code, component_code, pinned_start_date::text, reason
           from pin_list order by pinned_start_date`,
      ),
  })
}
