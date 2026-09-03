import { useMemo, useRef, useState } from 'react'
import { useCurrentRun, useGantt, type GanttRow } from '@/data/planning'
import { useCreatePin, usePins, useReleasePin } from '@/data/mutations'
import { Empty, Field, Panel, Table, Tag, Td, Th } from '@/components/ui'
import {
  BREACH_EXPLAINER,
  BREACH_LABEL,
  formatDateLong,
  formatNumber,
  inputClass,
} from '@/components/format'
import { Modal, ModalActions } from '@/components/edit'

const MS_PER_DAY = 86_400_000
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY
const iso = (dayNumber: number) =>
  new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10)

type Scale = { from: number; to: number; span: number }

export function Gantt() {
  const run = useCurrentRun()
  const gantt = useGantt(run.data?.id)
  const pins = usePins()
  const releasePin = useReleasePin()

  const [department, setDepartment] = useState('')
  const [customer, setCustomer] = useState('')
  const [onlyBreaches, setOnlyBreaches] = useState(false)
  const [proposed, setProposed] = useState<{
    task: GanttRow
    startDate: string
  } | null>(null)

  const options = useMemo(() => {
    const rows = gantt.data ?? []
    return {
      departments: [...new Set(rows.map((r) => r.department_code))].sort(),
      customers: [...new Set(rows.map((r) => r.customer_name))].sort(),
    }
  }, [gantt.data])

  const rows = useMemo(() => {
    let out = gantt.data ?? []
    if (department) out = out.filter((r) => r.department_code === department)
    if (customer) out = out.filter((r) => r.customer_name === customer)
    if (onlyBreaches) out = out.filter((r) => !r.is_feasible)
    return out
  }, [gantt.data, department, customer, onlyBreaches])

  const scale = useMemo<Scale | null>(() => {
    const dated = rows.filter((r) => r.start_date && r.end_date)
    if (!dated.length) return null
    const from = Math.min(...dated.map((r) => day(r.start_date!)))
    const to = Math.max(
      ...dated.map((r) =>
        Math.max(day(r.end_date!), day(r.due_date ?? r.end_date!)),
      ),
    )
    return { from, to, span: Math.max(1, to - from) }
  }, [rows])

  const groups = useMemo(() => {
    const map = new Map<string, { header: GanttRow; tasks: GanttRow[] }>()
    for (const row of rows) {
      const key = `${row.erp_order_no}#${row.line_no}`
      const existing = map.get(key)
      if (existing) existing.tasks.push(row)
      else map.set(key, { header: row, tasks: [row] })
    }
    return [...map.values()]
  }, [rows])

  return (
    <div className="space-y-6">
      <Panel
        title="Schedule"
        meta={`${rows.length} tasks${rows.length !== (gantt.data?.length ?? 0) ? ` of ${gantt.data?.length}` : ''}`}
      >
        <p className="text-mid mb-4 max-w-[85ch] text-caption">
          Each bar is one component in one department, running from its start
          date to the day it must be finished; the marker is the department's own
          deadline. <strong>Drag a bar</strong> to reschedule it — you will be
          asked why, and every later run will honour it. With hundreds of live
          orders this is always filtered; rendering the whole book helps nobody.
        </p>

        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label block pb-1">Department</span>
            <select
              className={`${inputClass} w-44`}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">All</option>
              {options.departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label block pb-1">Customer</span>
            <select
              className={`${inputClass} w-56`}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            >
              <option value="">All</option>
              {options.customers.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 pb-2 text-small sm:min-h-0 sm:pb-2 sm:text-small">
            <input
              type="checkbox"
              checked={onlyBreaches}
              onChange={(e) => setOnlyBreaches(e.target.checked)}
            />
            Breaches only
          </label>
        </div>

        {!scale ? (
          <Empty>Nothing to show for these filters.</Empty>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={`${group.header.erp_order_no}#${group.header.line_no}`}>
                <div className="border-rule-soft flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-1.5">
                  <span className="text-small font-semibold">
                    {group.header.erp_order_no}
                    <span className="text-faint font-normal">
                      {' '}
                      line {group.header.line_no}
                    </span>
                  </span>
                  <span className="text-mid text-caption">
                    {group.header.customer_name} ·{' '}
                    {formatNumber(group.header.line_qty)} units · stuffing{' '}
                    {formatDateLong(group.header.stuffing_date)}
                    {group.header.container_ref
                      ? ` · ${group.header.container_ref}`
                      : ''}
                  </span>
                </div>

                <div className="mt-2 space-y-1">
                  {group.tasks
                    .slice()
                    .sort((a, b) => a.route_position - b.route_position)
                    .map((task) => (
                      <Bar
                        key={task.task_id}
                        task={task}
                        scale={scale}
                        onPropose={(startDate) =>
                          setProposed({ task, startDate })
                        }
                        onRelease={() =>
                          releasePin.mutate({
                            shipmentLineId: task.shipment_line_id,
                            departmentCode: task.department_code,
                            componentCode: task.component_code,
                          })
                        }
                      />
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {pins.data?.length ? (
        <Panel title="Manual pins" meta={`${pins.data.length} active`}>
          <p className="text-mid mb-3 max-w-[80ch] text-caption">
            A planner who moves a task has made a decision the engine cannot see
            the reasons for. Every run schedules around these and reports any
            breach they cause, rather than quietly undoing them.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Department</Th>
                <Th>Component</Th>
                <Th>Starts</Th>
                <Th>Reason</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {pins.data.map((p) => (
                <tr key={p.id}>
                  <Td>
                    {p.erp_order_no}
                    <span className="text-faint"> line {p.line_no}</span>
                  </Td>
                  <Td>{p.department_code}</Td>
                  <Td>{p.component_code}</Td>
                  <Td>{formatDateLong(p.pinned_start_date)}</Td>
                  <Td className="text-mid">{p.reason}</Td>
                  <Td align="right">
                    <button
                      type="button"
                      className="text-faint hover:text-flag text-caption"
                      onClick={() =>
                        releasePin.mutate({
                          shipmentLineId: p.shipment_line_id,
                          departmentCode: p.department_code,
                          componentCode: p.component_code,
                        })
                      }
                    >
                      Release
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}

      {proposed ? (
        <PinDialog
          task={proposed.task}
          startDate={proposed.startDate}
          onClose={() => setProposed(null)}
        />
      ) : null}
    </div>
  )
}

function Bar({
  task,
  scale,
  onPropose,
  onRelease,
}: {
  task: GanttRow
  scale: Scale
  onPropose: (startDate: string) => void
  onRelease: () => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [dragDays, setDragDays] = useState<number | null>(null)

  const hasDates = Boolean(task.start_date && task.end_date)
  const shift = dragDays ?? 0

  const left = hasDates
    ? ((day(task.start_date!) + shift - scale.from) / scale.span) * 100
    : 0
  const width = hasDates
    ? Math.max(
        0.6,
        ((day(task.end_date!) - day(task.start_date!) + 1) / scale.span) * 100,
      )
    : 0
  const duePos = task.due_date
    ? ((day(task.due_date) - scale.from) / scale.span) * 100
    : null

  const tone = !task.is_feasible
    ? 'bg-flag'
    : task.is_pinned
      ? 'bg-blue'
      : 'bg-clear'

  /**
   * Dragging works in whole days rather than pixels: the planner is choosing a
   * date, and letting the bar settle between two of them would be a lie about
   * the precision on offer.
   */
  function startDrag(e: React.PointerEvent) {
    if (!hasDates || !track.current) return
    // Text selection is prevented by `select-none` on the row rather than by
    // preventDefault here: preventing the default on pointerdown also
    // suppresses the pointermove stream this drag depends on.
    const width = track.current.getBoundingClientRect().width
    const pxPerDay = width / scale.span
    const originX = e.clientX
    e.currentTarget.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) =>
      setDragDays(Math.round((ev.clientX - originX) / pxPerDay))

    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const days = Math.round((ev.clientX - originX) / pxPerDay)
      setDragDays(null)
      if (days !== 0) onPropose(iso(day(task.start_date!) + days))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="grid grid-cols-[190px_1fr] items-center gap-3 select-none">
      <div className="flex items-center gap-1.5 text-caption">
        <span className="w-16 font-semibold">{task.department_code}</span>
        <span className="text-mid truncate">{task.component_code}</span>
        {task.is_pinned ? (
          <button
            type="button"
            onClick={onRelease}
            title="Release this pin"
            className="flex min-h-11 shrink-0 items-center sm:min-h-0"
          >
            <Tag tone="blue">Pin ×</Tag>
          </button>
        ) : null}
      </div>

      <div ref={track} className="relative h-[18px]">
        <div className="bg-rule-soft pointer-events-none absolute inset-x-0 top-1/2 h-px" />
        {hasDates ? (
          <div
            onPointerDown={startDrag}
            data-testid="gantt-bar"
            className={`absolute top-1/2 h-3.5 min-w-[3px] -translate-y-1/2 cursor-grab touch-none rounded-[3px] active:cursor-grabbing ${tone} ${
              dragDays !== null ? 'ring-ink opacity-80 ring-2' : ''
            }`}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${task.component_code}: ${formatDateLong(task.start_date)} → ${formatDateLong(task.end_date)} · ${formatNumber(task.qty_required, 0)} units${
              task.breach_reason
                ? ` · ${BREACH_EXPLAINER[task.breach_reason] ?? task.breach_reason}`
                : ''
            } — drag to reschedule`}
          />
        ) : (
          <span className="text-flag bg-sheet text-caption absolute top-1/2 left-0 -translate-y-1/2 pr-2 font-medium">
            {BREACH_LABEL[task.breach_reason ?? ''] ?? 'Not scheduled'}
          </span>
        )}
        {duePos !== null ? (
          // pointer-events-none matters: this marker is one pixel wide and
          // frequently lands inside the bar it belongs to. Without it, the
          // deadline line swallows the drag and the bar simply refuses to move
          // — for exactly the tasks whose dates most need adjusting.
          <div
            className="bg-ink pointer-events-none absolute inset-y-0 w-px"
            style={{ left: `${duePos}%` }}
            title={`Due ${formatDateLong(task.due_date)}`}
          />
        ) : null}
        {dragDays !== null && dragDays !== 0 ? (
          <span className="text-blue pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 bg-white pl-2 text-caption font-semibold">
            {dragDays > 0 ? '+' : ''}
            {dragDays} days
          </span>
        ) : !task.is_feasible && task.breach_reason ? (
          <span className="text-flag pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 bg-white pl-2 text-caption tracking-[0.05em] uppercase">
            {BREACH_LABEL[task.breach_reason] ?? task.breach_reason}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function PinDialog({
  task,
  startDate,
  onClose,
}: {
  task: GanttRow
  startDate: string
  onClose: () => void
}) {
  const createPin = useCreatePin()
  const [reason, setReason] = useState('')

  const moved = day(startDate) - day(task.start_date!)

  return (
    <Modal
      title="Pin this task"
      subtitle={`${task.department_code} · ${task.component_code}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          createPin.mutate(
            {
              shipmentLineId: task.shipment_line_id,
              departmentCode: task.department_code,
              componentCode: task.component_code,
              startDate,
              reason: reason.trim(),
            },
            { onSuccess: onClose },
          )
        }}
      >
        <dl className="border-rule-soft grid grid-cols-[130px_1fr] gap-y-1 border-b pb-4 text-small">
          <dt className="text-faint">Order</dt>
          <dd>
            {task.erp_order_no} line {task.line_no} — {task.customer_name}
          </dd>
          <dt className="text-faint">Was starting</dt>
          <dd>{formatDateLong(task.start_date)}</dd>
          <dt className="text-faint">Now starting</dt>
          <dd className="font-semibold">
            {formatDateLong(startDate)}{' '}
            <span className="text-mid font-normal">
              ({moved > 0 ? '+' : ''}
              {moved} days)
            </span>
          </dd>
          <dt className="text-faint">Must finish by</dt>
          <dd>{formatDateLong(task.due_date)}</dd>
        </dl>

        <div className="mt-4">
          <Field label="Why (required)">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Line free after the Nordic run"
              required
              autoFocus
            />
          </Field>
        </div>

        <p className="text-mid mt-3 max-w-[65ch] text-caption">
          The reason is required because a pin without one is indistinguishable
          from a mistake six weeks later. Every later run honours this date and
          schedules around it; if it pushes the work past the deadline, that is
          reported rather than corrected.
        </p>

        {createPin.isError ? (
          <p className="text-flag mt-3 text-caption">
            {String(createPin.error)}
          </p>
        ) : null}

        <ModalActions
          onCancel={onClose}
          submitLabel="Pin it"
          busy={createPin.isPending}
        />
      </form>
    </Modal>
  )
}
