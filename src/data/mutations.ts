import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { exec, query } from '@/lib/database'

/**
 * Writes.
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
    const rows = await query<{ id: string }>(
      `insert into orders (erp_order_no, customer_id, article_id, total_qty, confidence, order_date)
       values ($1, $2, $3, $4, $5::order_confidence, current_date)
       returning id`,
      [o.erpOrderNo, o.customerId, o.articleId, o.qty, o.confidence],
    )
    await query(
      `insert into shipment_lines
         (order_id, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready_date)
       values ($1, 1, $2, $3, $4, $5, $6)`,
      [
        rows[0].id,
        o.qty,
        o.stuffingDate,
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
      `insert into shipment_lines
         (order_id, line_no, qty, stuffing_date, delivery_date, container_ref, material_ready_date)
       values ($1,
               (select coalesce(max(line_no), 0) + 1 from shipment_lines where order_id = $1),
               $2, $3, $4, $5, $6)`,
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
    await query(`delete from shipment_lines where id = $1`, [id])
  })
}

export function useDeleteOrder() {
  return useWrite<string>(async (id) => {
    await query(`delete from orders where id = $1`, [id])
  })
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

/**
 * Spec §5: is_complete is false until a value is entered, and a blank cell
 * blocks scheduling rather than defaulting to zero. Clearing the field has to
 * put the row back to incomplete, or a deleted value would silently become a
 * zero-day offset.
 */
export function useSetDminus() {
  return useWrite<{
    articleCode: string
    departmentCode: string
    days: number | null
  }>(async ({ articleCode, departmentCode, days }) => {
    // $3 is cast explicitly: Postgres cannot infer a parameter's type from
    // `$3 is not null` alone, and an untyped null fails the whole statement.
    await query(
      `update article_dept_dminus adm
          set dminus_days = $3::integer,
              is_complete = ($3::integer is not null)
         from articles a, departments d
        where a.id = adm.article_id and d.id = adm.department_id
          and a.code = $1 and d.code = $2`,
      [articleCode, departmentCode, days],
    )
  })
}

export function useSetRate() {
  return useWrite<{
    componentCode: string
    departmentCode: string
    shiftCode: string
    unitsPerDay: number
  }>(async ({ componentCode, departmentCode, shiftCode, unitsPerDay }) => {
    await query(
      `update component_rates cr
          set units_per_day = $4
         from components c, departments d, shifts s
        where c.id = cr.component_id and d.id = cr.department_id and s.id = cr.shift_id
          and c.code = $1 and d.code = $2 and s.code = $3`,
      [componentCode, departmentCode, shiftCode, unitsPerDay],
    )
  })
}

export function useUpdateDepartment() {
  return useWrite<{
    id: string
    name?: string
    yieldPct?: number
    routePosition?: number
  }>(async ({ id, name, yieldPct, routePosition }) => {
    await query(
      `update departments
          set name = coalesce($2, name),
              yield_pct = coalesce($3, yield_pct),
              route_position = coalesce($4, route_position)
        where id = $1`,
      [id, name ?? null, yieldPct ?? null, routePosition ?? null],
    )
  })
}

export function useSetHeadcount() {
  return useWrite<{ departmentId: string; headcount: number }>(
    async ({ departmentId, headcount }) => {
      await query(
        `update department_shifts set sanctioned_headcount = $2
          where department_id = $1 and is_active`,
        [departmentId, headcount],
      )
    },
    // Headcount does not feed capacity directly — component rates do. It is the
    // denominator in the overtime maths, which is Phase 4.
    { rerun: false },
  )
}

/**
 * Adding a department creates blank, incomplete D-minus rows for every active
 * article by trigger, so the new step is visibly unscheduled until someone
 * enters its offset — which is the intended behaviour, not an obstacle.
 */
export function useCreateDepartment() {
  return useWrite<{
    code: string
    name: string
    routePosition: number
    yieldPct: number
  }>(async ({ code, name, routePosition, yieldPct }) => {
    await query(
      `insert into departments (code, name, route_position, yield_pct)
       values ($1, $2, $3, $4)`,
      [code, name, routePosition, yieldPct],
    )
  })
}

export function useSetDepartmentActive() {
  return useWrite<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      // Soft delete only — a department with history is never removed.
      await query(`update departments set is_active = $2 where id = $1`, [
        id,
        isActive,
      ])
    },
  )
}

export function useAddHoliday() {
  return useWrite<{ date: string; description: string }>(
    async ({ date, description }) => {
      await query(
        `insert into holidays (holiday_date, description) values ($1, $2)
         on conflict (holiday_date) do update set description = excluded.description`,
        [date, description],
      )
    },
  )
}

export function useDeleteHoliday() {
  return useWrite<string>(async (id) => {
    await query(`delete from holidays where id = $1`, [id])
  })
}

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
    await query(
      `insert into schedule_pins
         (shipment_line_id, department_id, component_id, pinned_start_date, reason)
       values ($1,
               (select id from departments where code = $2),
               (select id from components where code = $3),
               $4, $5)
       on conflict (shipment_line_id, department_id, component_id)
         where is_active
       do update set pinned_start_date = excluded.pinned_start_date,
                     reason = excluded.reason,
                     pinned_at = now()`,
      [
        p.shipmentLineId,
        p.departmentCode,
        p.componentCode,
        p.startDate,
        p.reason,
      ],
    )
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
    await query(
      `update schedule_pins
          set is_active = false
        where is_active
          and shipment_line_id = $1
          and department_id = (select id from departments where code = $2)
          and component_id = (select id from components where code = $3)`,
      [p.shipmentLineId, p.departmentCode, p.componentCode],
    )
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
        `select p.id, p.shipment_line_id, o.erp_order_no, sl.line_no::int,
                d.code as department_code, c.code as component_code,
                p.pinned_start_date::text, p.reason
           from schedule_pins p
           join shipment_lines sl on sl.id = p.shipment_line_id
           join orders o on o.id = sl.order_id
           join departments d on d.id = p.department_id
           join components c on c.id = p.component_id
          where p.is_active
          order by p.pinned_start_date`,
      ),
  })
}
