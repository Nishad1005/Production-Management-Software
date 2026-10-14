import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCurrentRun, useGantt, useOrders, type GanttRow } from '@/data/planning'
import { useCreatePin, usePins, useReleasePin } from '@/data/mutations'
import { Empty, Field, Panel, Table, Tag, Td, Th } from '@/components/ui'
import {
  BREACH_EXPLAINER,
  BREACH_LABEL,
  PULLED_EXPLAINER,
  formatDateLong,
  formatNumber,
  inputClass,
} from '@/components/format'
import { Modal, ModalActions } from '@/components/edit'
import { dayNumber as day, isoOf as iso, timelineMarks, todayIso } from '@/components/timeline'
import { componentLabel, useDepartmentNames } from '@/components/names'

type Scale = { from: number; to: number; span: number }
type Marks = ReturnType<typeof timelineMarks>

/*
 * The label column and the track, the same on every row so the ruler at the
 * top lines up with the bars beneath it. The label column is a CSS variable
 * set on the scroll container (narrower on a phone); the track is a fixed
 * width in pixels from the scale, so the rows are wider than the panel when
 * the horizon is long — and that is what scrolls, sideways, with the labels
 * held at the left and the ruler at the top. Until 14 Oct the track was a
 * percentage of the panel whatever the span: a year of orders at four pixels
 * a day.
 */
const cols = (trackW: number) => ({ gridTemplateColumns: `var(--gantt-label) ${trackW}px` })
const labelWidth = () => (window.innerWidth >= 640 ? 230 : 150)

/** Twenty pixels a day: a week is a readable 140px. A short horizon fills the panel instead. */
const PX_PER_DAY = 20
/** Days of track either side of the first and last date, so nothing sits on an edge. */
const MARGIN_DAYS = 3

export function Gantt() {
  const run = useCurrentRun()
  const gantt = useGantt(run.data?.id)
  // An order taken against the plan says so on its header, from the book.
  const orders = useOrders(run.data?.id)
  const againstPlan = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of orders.data ?? []) {
      if (o.accepted_against_plan) map.set(o.erp_order_no, o.acceptance_note ?? '')
    }
    return map
  }, [orders.data])
  const pins = usePins()
  const releasePin = useReleasePin()
  const names = useDepartmentNames()

  const [department, setDepartment] = useState('')
  const [customer, setCustomer] = useState('')
  const [onlyBreaches, setOnlyBreaches] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
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

  /*
   * The track covers every date on the page — each task's start, end and
   * deadline, each order's container day — with a few days either side, so a
   * container day that has already passed is a point on the track to the left
   * of today. Before 14 Oct the track began at the earliest planned start,
   * which for late work is today, and the marker for a passed container day
   * was drawn at a negative position: off the left edge of the track and
   * across the order's label. (Before 9 Oct the right edge had the same
   * problem with the stuffing date.) The dates decide the track; the track
   * never decides which dates fit.
   */
  const scale = useMemo<Scale | null>(() => {
    let from = Infinity
    let to = -Infinity
    for (const r of rows) {
      for (const d of [r.start_date, r.end_date, r.due_date, r.stuffing_date]) {
        if (!d) continue
        const n = day(d)
        if (n < from) from = n
        if (n > to) to = n
      }
    }
    if (!Number.isFinite(from)) return null
    from -= MARGIN_DAYS
    to += MARGIN_DAYS
    return { from, to, span: Math.max(1, to - from) }
  }, [rows])

  // The panel's width, so a short horizon stretches to fill it rather than
  // sitting in its left third at twenty pixels a day.
  const scroller = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const el = scroller.current
      if (el) setAvail(Math.max(0, el.clientWidth - labelWidth()))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [scale])
  const trackW = scale ? Math.round(Math.max(PX_PER_DAY * scale.span, avail)) : 0

  // Opens with today a quarter of the way in: the past to the left, the
  // months ahead to the right.
  useEffect(() => {
    const el = scroller.current
    if (!el || !scale || !trackW) return
    const t = day(todayIso())
    if (t < scale.from || t > scale.to) return
    el.scrollLeft = Math.max(0, ((t - scale.from) / scale.span) * trackW - avail / 4)
  }, [scale, trackW, avail])

  const marks = useMemo(
    () => (scale ? timelineMarks(scale.from, scale.to) : null),
    [scale],
  )

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; header: GanttRow; tasks: GanttRow[] }>()
    for (const row of rows) {
      const key = `${row.erp_order_no}#${row.line_no}`
      const existing = map.get(key)
      if (existing) existing.tasks.push(row)
      else map.set(key, { key, header: row, tasks: [row] })
    }
    return [...map.values()]
  }, [rows])

  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const nameOf = (code: string) => names.get(code) ?? code

  return (
    <div className="space-y-6">
      <Panel
        title="Schedule"
        meta={`${rows.length} tasks${rows.length !== (gantt.data?.length ?? 0) ? ` of ${gantt.data?.length}` : ''} · ${groups.length} shipment lines`}
      >
        <p className="text-mid mb-4 max-w-[85ch] text-caption">
          One line per shipment line: its whole span, with the container day
          marked and anything that cannot be made in time in red. Open a line to
          see each department's bar, from the day it starts to the day it must
          be finished. <strong>Drag a bar</strong> to reschedule it — you will be
          asked why, and every later run will honour it. Hover any mark for
          what it is and its date. With hundreds of live orders this is always
          filtered; rendering the whole book helps nobody.
        </p>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label block pb-1">Department</span>
            <select
              className={`${inputClass} w-48`}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">All</option>
              {options.departments.map((d) => (
                <option key={d} value={d}>
                  {nameOf(d)}
                </option>
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
          <div className="flex gap-4 pb-2 sm:ml-auto">
            <button
              type="button"
              data-testid="gantt-expand-all"
              onClick={() => setOpen(new Set(groups.map((g) => g.key)))}
              className="text-blue min-h-11 text-small font-semibold hover:underline sm:min-h-0"
            >
              Expand all
            </button>
            <button
              type="button"
              data-testid="gantt-collapse-all"
              onClick={() => setOpen(new Set())}
              className="text-blue min-h-11 text-small font-semibold hover:underline sm:min-h-0"
            >
              Collapse all
            </button>
          </div>
        </div>

        <div className="text-mid mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption">
          <Swatch className="bg-clear" label="Fits in its days" />
          <Swatch className="bg-flag" label="Cannot be made in time — the reason is at the end of the row" />
          <Swatch className="bg-blue" label="Pinned by a planner" />
          <Swatch className="bg-ink h-3.5 w-0.5" label="Deadline, from the D-minus" />
          <Swatch className="bg-blue h-3.5 w-0.5" label="Today" />
        </div>

        {!scale || !marks ? (
          <Empty>Nothing to show for these filters.</Empty>
        ) : (
          <>
            <div
              ref={scroller}
              data-testid="gantt-scroll"
              data-from={iso(scale.from)}
              data-to={iso(scale.to)}
              data-px-per-day={(trackW / scale.span).toFixed(1)}
              className="border-rule max-h-[75vh] overflow-auto border [--gantt-label:150px] sm:[--gantt-label:230px]"
            >
              <div style={{ width: `calc(var(--gantt-label) + ${trackW}px)` }}>
                <Ruler marks={marks} trackW={trackW} />
                {groups.map((group) => (
                  <OrderGroup
                    key={group.key}
                    group={group}
                    againstPlan={againstPlan.get(group.header.erp_order_no) ?? null}
                    open={open.has(group.key)}
                    onToggle={() => toggle(group.key)}
                    scale={scale}
                    marks={marks}
                    trackW={trackW}
                    nameOf={nameOf}
                    onPropose={(task, startDate) => setProposed({ task, startDate })}
                    onRelease={(task) =>
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
            <p className="text-faint mt-2 text-caption">
              {formatDateLong(iso(scale.from))} to {formatDateLong(iso(scale.to))} —
              scroll sideways for the rest. The past is shaded, today is the blue
              line, and the department names and the dates stay where they are.
            </p>
          </>
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
                  <Td>{nameOf(p.department_code)}</Td>
                  <Td className="text-mid" title={p.component_code}>{componentLabel(p.component_code, names)}</Td>
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
          departmentName={nameOf(proposed.task.department_code)}
          startDate={proposed.startDate}
          onClose={() => setProposed(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * The dates, once, above every bar.
 *
 * Months as bands along the top, every Monday's date along the bottom, and
 * today as a blue line. It sticks to the top of the window while the list
 * scrolls, which is the whole point: a date axis that scrolls out of view is
 * an axis the reader has to remember.
 */
function Ruler({ marks, trackW }: { marks: Marks; trackW: number }) {
  return (
    <div
      style={cols(trackW)}
      className="bg-sheet border-rule sticky top-0 z-20 grid items-end border-b"
    >
      <div className="label bg-sheet border-rule-soft sticky left-0 z-30 self-stretch border-r pt-5 pb-1 pl-2">
        Department
      </div>
      <div className="relative h-10 overflow-hidden">
        {marks.months.map((m) => (
          <div
            key={`${m.label}-${m.left}`}
            className="label border-rule absolute top-0 h-5 overflow-hidden border-l pl-1 leading-5 whitespace-nowrap"
            style={{ left: `${m.left}%`, width: `${m.width}%` }}
          >
            {m.width >= 8 ? m.label : ''}
          </div>
        ))}
        {marks.weeks.map((w, i) => (
          <div
            key={w.iso}
            className="text-mid border-rule-soft absolute bottom-0 h-5 border-l pl-1 font-mono text-[10px] leading-5 whitespace-nowrap"
            style={{ left: `${w.pos}%` }}
          >
            {i % marks.labelEvery === 0 ? w.label : ''}
          </div>
        ))}
        {marks.today !== null ? (
          <Mark
            left={marks.today}
            title={`Today · ${formatDateLong(todayIso())}`}
            testId="gantt-today"
            line="bg-blue w-0.5"
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * A mark on a track that says what it is when hovered: the one-pixel line
 * inside an eight-pixel hit area, so the pointer can actually land on it.
 * Drawn before the bar in its row, so the bar — a later sibling — stays on
 * top and wins the drag where the two overlap; the deadline mark used to be
 * pointer-events-none for that reason, and said nothing.
 */
function Mark({
  left,
  title,
  testId,
  line,
}: {
  left: number
  title: string
  testId: string
  line: string
}) {
  return (
    <div
      data-testid={testId}
      className="absolute inset-y-0 w-2 -translate-x-1/2 cursor-help"
      style={{ left: `${left}%` }}
      title={title}
    >
      <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 ${line}`} />
    </div>
  )
}

/** The week lines and today, repeated faintly behind every track. */
function Gridlines({ marks }: { marks: Marks }) {
  // Everything left of today has either happened or has not; a container
  // day on this side of the line has gone. Shaded, so that reads at a glance
  // rather than from a date.
  const past = Math.min(100, Math.max(0, marks.pos(day(todayIso()))))
  return (
    <>
      {past > 0 ? (
        <div
          className="bg-ink/[0.045] pointer-events-none absolute inset-y-0 left-0"
          style={{ width: `${past}%` }}
        />
      ) : null}
      {marks.weeks.map((w) => (
        <div
          key={w.iso}
          className="bg-rule-soft pointer-events-none absolute inset-y-0 w-px"
          style={{ left: `${w.pos}%` }}
        />
      ))}
      {marks.today !== null ? (
        <div
          className="bg-blue/40 pointer-events-none absolute inset-y-0 w-px"
          style={{ left: `${marks.today}%` }}
        />
      ) : null}
    </>
  )
}

/**
 * One shipment line: a summary strip always, and the bars when opened.
 *
 * The strip is the whole order in one row — its span, the container day, and
 * a red mark wherever a department cannot make its part in time — so a page
 * of eleven orders is eleven rows rather than two hundred and twenty, and a
 * page of three hundred is still readable with the filters above.
 */
function OrderGroup({
  group,
  againstPlan,
  open,
  onToggle,
  scale,
  marks,
  trackW,
  nameOf,
  onPropose,
  onRelease,
}: {
  group: { key: string; header: GanttRow; tasks: GanttRow[] }
  /** The reason the order was taken against the plan; null when it was not. */
  againstPlan: string | null
  open: boolean
  onToggle: () => void
  scale: Scale
  marks: Marks
  trackW: number
  nameOf: (code: string) => string
  onPropose: (task: GanttRow, startDate: string) => void
  onRelease: (task: GanttRow) => void
}) {
  const tasks = group.tasks.slice().sort((a, b) => a.route_position - b.route_position)
  const breaches = tasks.filter((t) => !t.is_feasible).length
  const dated = tasks.filter((t) => t.start_date && t.end_date)
  const start = dated.length ? Math.min(...dated.map((t) => day(t.start_date!))) : null
  const end = dated.length ? Math.max(...dated.map((t) => day(t.end_date!))) : null
  const h = group.header
  // The container day has gone. The marker shows where; this says what, for
  // a reader who does not read charts.
  const passed = day(h.stuffing_date) < day(todayIso())

  return (
    <div
      data-testid="gantt-order"
      data-expanded={open ? 'yes' : 'no'}
      data-breaches={breaches}
      data-stuffing={h.stuffing_date}
      className="border-rule-soft border-b py-1"
    >
      <div style={cols(trackW)} className="grid items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="bg-sheet border-rule-soft sticky left-0 z-10 flex min-h-11 items-start gap-1.5 self-stretch border-r py-1 pr-3 text-left sm:min-h-0"
        >
          <span className="text-faint w-3 shrink-0 pt-0.5 text-caption">
            {open ? '▾' : '▸'}
          </span>
          <span className="min-w-0">
            <span className="block text-small font-semibold">
              {h.erp_order_no}
              <span className="text-faint font-normal"> line {h.line_no}</span>
            </span>
            {breaches || passed || againstPlan !== null ? (
              <span className="mt-0.5 flex flex-wrap gap-1">
                {breaches ? (
                  <Tag tone="flag">{breaches} cannot be made in time</Tag>
                ) : null}
                {passed ? (
                  <span
                    data-testid="gantt-passed"
                    title={`The container was to be stuffed on ${formatDateLong(h.stuffing_date)}. Work still planned after that day is late.`}
                  >
                    <Tag tone="flag">Container day passed</Tag>
                  </span>
                ) : null}
                {againstPlan !== null ? (
                  <span
                    data-testid="gantt-against-plan"
                    title={againstPlan ? `Taken against the plan: ${againstPlan}` : 'Taken against the plan'}
                  >
                    <Tag tone="mid">Taken against the plan</Tag>
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="text-mid block text-caption">
              {formatNumber(h.line_qty)} units · stuffing{' '}
              {formatDateLong(h.stuffing_date)} · {h.customer_name}
              {h.container_ref ? ` · ${h.container_ref}` : ''}
            </span>
          </span>
        </button>

        <div
          // overflow-hidden is the airtight part: a date that somehow fell
          // outside the track is cut off at its edge, never drawn across the
          // label column.
          className="relative h-7 overflow-hidden select-none"
          title={
            start !== null && end !== null
              ? `${formatDateLong(iso(start))} → ${formatDateLong(iso(end))} · stuffing ${formatDateLong(h.stuffing_date)}`
              : undefined
          }
        >
          <Gridlines marks={marks} />
          {start !== null && end !== null ? (
            <div
              className="bg-rule absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px]"
              style={{
                left: `${marks.pos(start)}%`,
                width: `${Math.max(0.6, marks.pos(end + 1) - marks.pos(start))}%`,
              }}
            />
          ) : null}
          {dated
            .filter((t) => !t.is_feasible || t.is_pinned)
            .map((t) => (
              <div
                key={t.task_id}
                className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px] ${
                  !t.is_feasible ? 'bg-flag' : 'bg-blue'
                }`}
                style={{
                  left: `${marks.pos(day(t.start_date!))}%`,
                  width: `${Math.max(0.6, marks.pos(day(t.end_date!) + 1) - marks.pos(day(t.start_date!)))}%`,
                }}
                title={`${nameOf(t.department_code)}: ${
                  !t.is_feasible
                    ? (BREACH_EXPLAINER[t.breach_reason ?? ''] ?? 'cannot be made in time')
                    : 'pinned'
                }`}
              />
            ))}
          <Mark
            left={marks.pos(day(h.stuffing_date))}
            title={`Container day · ${formatDateLong(h.stuffing_date)}`}
            testId="gantt-stuffing"
            line="bg-ink w-0.5"
          />
        </div>
      </div>

      {open ? (
        <div className="mt-1 space-y-1">
          {tasks.map((task) => (
            <Bar
              key={task.task_id}
              task={task}
              name={nameOf(task.department_code)}
              scale={scale}
              marks={marks}
              trackW={trackW}
              onPropose={(startDate) => onPropose(task, startDate)}
              onRelease={() => onRelease(task)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Bar({
  task,
  name,
  scale,
  marks,
  trackW,
  onPropose,
  onRelease,
}: {
  task: GanttRow
  name: string
  scale: Scale
  marks: Marks
  trackW: number
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
  // Where the words at the end of a row go: just past the bar's right end,
  // or past its deadline marker if that is further right — never the
  // track's right end, which is next spring once the timeline scrolls.
  const afterBar = { left: `calc(${Math.max(left + width, duePos ?? 0)}% + 4px)` }

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
    <div style={cols(trackW)} className="grid items-center select-none">
      <div
        className="bg-sheet border-rule-soft sticky left-0 z-10 flex items-center gap-1.5 self-stretch border-r pr-3 pl-[18px] text-caption"
        title={`${task.component_code} (${task.department_code})`}
      >
        <span className="truncate font-semibold">{name}</span>
        {!hasDates && task.qty_remaining === 0 ? (
          // Nothing left to place: the department has declared the whole job.
          // Not a breach, and not the flag colour. Said here rather than on
          // the track, whose left end is months back once the timeline
          // scrolls.
          <span
            data-testid="gantt-made"
            title={`${name}: ${formatNumber(task.qty_done, 0)} of ${formatNumber(task.qty_required, 0)} made`}
            className="text-mid shrink-0 font-medium"
          >
            · Made
          </span>
        ) : !hasDates ? (
          <span className="text-flag shrink-0 font-medium">
            · {BREACH_LABEL[task.breach_reason ?? ''] ?? 'Not scheduled'}
          </span>
        ) : null}
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

      <div ref={track} className="relative h-[18px] overflow-hidden">
        <Gridlines marks={marks} />
        <div className="bg-rule-soft pointer-events-none absolute inset-x-0 top-1/2 h-px" />
        {duePos !== null ? (
          <Mark
            left={duePos}
            title={`Deadline from the D-minus · ${formatDateLong(task.due_date)}`}
            testId="gantt-due"
            line="bg-ink w-px"
          />
        ) : null}
        {hasDates ? (
          <div
            onPointerDown={startDrag}
            data-testid="gantt-bar"
            className={`absolute top-1/2 h-3.5 min-w-[3px] -translate-y-1/2 cursor-grab touch-none rounded-[2px] active:cursor-grabbing ${tone} ${
              dragDays !== null ? 'ring-ink opacity-80 ring-2' : ''
            }`}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${name}: ${formatDateLong(task.start_date)} → ${formatDateLong(task.end_date)} · ${formatNumber(task.qty_required, 0)} units${
              task.breach_reason
                ? ` · ${BREACH_EXPLAINER[task.breach_reason] ?? task.breach_reason}`
                : task.pulled_days
                  ? ` · ${PULLED_EXPLAINER(task.pulled_days)}`
                  : ''
            } — drag to reschedule`}
          />
        ) : null}
        {dragDays !== null && dragDays !== 0 ? (
          <span
            className="text-blue pointer-events-none absolute top-1/2 -translate-y-1/2 bg-white pl-2 text-caption font-semibold whitespace-nowrap"
            style={afterBar}
          >
            {dragDays > 0 ? '+' : ''}
            {dragDays} days
          </span>
        ) : !task.is_feasible && task.breach_reason ? (
          <span
            className="text-flag pointer-events-none absolute top-1/2 -translate-y-1/2 bg-white pl-2 text-caption font-medium whitespace-nowrap"
            style={afterBar}
            title={BREACH_EXPLAINER[task.breach_reason]}
          >
            {BREACH_LABEL[task.breach_reason] ?? task.breach_reason}
          </span>
        ) : task.pulled_days ? (
          // Pulled earlier than its D-minus for the quantity the department
          // after it has to make. Not a breach, so not the flag colour; the
          // D-minus marker stays where it was, so the pull is visible.
          <span
            data-testid="gantt-pulled"
            data-days={task.pulled_days}
            className="text-mid pointer-events-none absolute top-1/2 -translate-y-1/2 bg-white pl-2 text-caption font-medium whitespace-nowrap"
            style={afterBar}
            title={PULLED_EXPLAINER(task.pulled_days)}
          >
            {task.pulled_days}d earlier
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded-[2px] ${className}`} />
      {label}
    </span>
  )
}

function PinDialog({
  task,
  departmentName,
  startDate,
  onClose,
}: {
  task: GanttRow
  departmentName: string
  startDate: string
  onClose: () => void
}) {
  const createPin = useCreatePin()
  const [reason, setReason] = useState('')

  const moved = day(startDate) - day(task.start_date!)

  return (
    <Modal
      title="Pin this task"
      subtitle={`${departmentName} · ${task.component_code}`}
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
