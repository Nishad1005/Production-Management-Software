import { useMemo, useState } from 'react'
import { useCurrentRun, useGantt, type GanttRow } from '@/data/planning'
import { Empty, Panel, Tag } from '@/components/ui'
import { BREACH_EXPLAINER, BREACH_LABEL, formatDateLong, formatNumber, inputClass } from '@/components/format'

const MS_PER_DAY = 86_400_000
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY

export function Gantt() {
  const run = useCurrentRun()
  const gantt = useGantt(run.data?.id)
  const [department, setDepartment] = useState('')
  const [customer, setCustomer] = useState('')
  const [onlyBreaches, setOnlyBreaches] = useState(false)

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

  const scale = useMemo(() => {
    const dated = rows.filter((r) => r.start_date && r.end_date)
    if (!dated.length) return null
    const from = Math.min(...dated.map((r) => day(r.start_date!)))
    const to = Math.max(
      ...dated.map((r) => Math.max(day(r.end_date!), day(r.due_date ?? r.end_date!))),
    )
    return { from, to, span: Math.max(1, to - from) }
  }, [rows])

  // Grouped by shipment line, since that is the unit anyone thinks in.
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
        <p className="text-mid mb-4 max-w-[80ch] text-[12px]">
          Each bar is one component in one department, running from its start
          date to the day it must be finished. The marker is the department's
          own deadline. With hundreds of live orders this is always filtered —
          rendering the whole book helps nobody.
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
          <label className="flex items-center gap-2 pb-2 text-[12.5px]">
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
                  <span className="font-sans text-[13px] font-semibold">
                    {group.header.erp_order_no}
                    <span className="text-faint font-normal">
                      {' '}
                      line {group.header.line_no}
                    </span>
                  </span>
                  <span className="text-mid text-[11.5px]">
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
                      <Bar key={task.task_id} task={task} scale={scale} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function Bar({
  task,
  scale,
}: {
  task: GanttRow
  scale: { from: number; to: number; span: number }
}) {
  const hasDates = Boolean(task.start_date && task.end_date)
  const left = hasDates ? ((day(task.start_date!) - scale.from) / scale.span) * 100 : 0
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

  return (
    <div className="grid grid-cols-[190px_1fr] items-center gap-3">
      <div className="flex items-center gap-1.5 text-[11.5px]">
        <span className="w-16 font-semibold">{task.department_code}</span>
        <span className="text-mid truncate">{task.component_code}</span>
        {task.is_pinned ? <Tag tone="blue">Pin</Tag> : null}
      </div>

      <div className="relative h-[18px]">
        <div className="bg-rule-soft absolute inset-x-0 top-1/2 h-px" />
        {hasDates ? (
          <div
            className={`absolute top-1/2 h-[11px] -translate-y-1/2 rounded-[1px] ${tone}`}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${task.component_code}: ${formatDateLong(task.start_date)} → ${formatDateLong(task.end_date)} · ${formatNumber(task.qty_required, 0)} units${
              task.breach_reason
                ? ` · ${BREACH_EXPLAINER[task.breach_reason] ?? task.breach_reason}`
                : ''
            }`}
          />
        ) : (
          <span className="text-flag absolute top-1/2 left-0 -translate-y-1/2 bg-white pr-2 text-[11px]">
            {BREACH_LABEL[task.breach_reason ?? ''] ?? 'Not scheduled'}
          </span>
        )}
        {duePos !== null ? (
          <div
            className="bg-ink absolute inset-y-0 w-px"
            style={{ left: `${duePos}%` }}
            title={`Due ${formatDateLong(task.due_date)}`}
          />
        ) : null}
        {!task.is_feasible && task.breach_reason ? (
          <span className="text-flag absolute top-1/2 right-0 -translate-y-1/2 bg-white pl-2 text-[10px] tracking-[0.05em] uppercase">
            {BREACH_LABEL[task.breach_reason] ?? task.breach_reason}
          </span>
        ) : null}
      </div>
    </div>
  )
}
