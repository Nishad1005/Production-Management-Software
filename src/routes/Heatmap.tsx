import { useMemo, useState } from 'react'
import {
  useCellDetail,
  useCurrentRun,
  useHeatmap,
  type HeatmapCell,
} from '@/data/planning'
import { Empty, Panel, Table, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'
import {
  eachDay,
  isFirstOfMonth,
  isMonday,
  monthBands,
  todayIso,
} from '@/components/timeline'
import { componentLabel, useDepartmentNames } from '@/components/names'

/*
 * Five steps of green rather than a continuous fade.
 *
 * This used to set `opacity` on a solid green, which lightened the cell
 * towards whatever was behind it and made a quarter-full day and an empty one
 * hard to tell apart at a glance. Mixing towards white instead keeps the
 * colour honest at every step, and stepping it means neighbouring days read as
 * different rather than as a gradient.
 */
const RAMP = [25, 45, 65, 85, 100]

function loadFill(utilisation: number) {
  const step = RAMP[Math.min(RAMP.length - 1, Math.floor(utilisation * RAMP.length))]
  return `color-mix(in oklab, var(--color-clear) ${step}%, white)`
}

function cellStyle(cell: HeatmapCell | undefined) {
  // A day with no row at all is a day the factory is closed — Sunday or a
  // declared holiday. Drawn, not skipped, so the week has its real shape.
  if (!cell) return { className: 'border border-dashed border-rule', style: {} }
  if (cell.status === 'over') return { className: 'bg-flag', style: {} }
  if (cell.status === 'idle')
    return { className: 'border border-rule-soft', style: {} }
  return {
    className: '',
    style: { backgroundColor: loadFill(Math.min(1, cell.utilisation)) },
  }
}

/*
 * The week and today, drawn as inset shadows rather than borders.
 *
 * A border changes a cell's width, and the header above would then drift out
 * of line with the cells below it. An inset shadow draws inside the box and
 * moves nothing, so the Monday line in the header and the Monday line in the
 * row are the same line.
 */
const WEEK_LINE = 'shadow-[inset_1px_0_0_var(--color-rule)]'
const TODAY_LINE = 'shadow-[inset_2px_0_0_var(--color-blue)]'
const columnLine = (day: string, today: string) =>
  day === today ? TODAY_LINE : isMonday(day) ? WEEK_LINE : ''

export function Heatmap() {
  const run = useCurrentRun()
  const heatmap = useHeatmap(run.data?.id)
  const names = useDepartmentNames()
  const [selected, setSelected] = useState<{
    departmentId: string
    departmentCode: string
    date: string
  } | null>(null)

  const detail = useCellDetail(
    run.data?.id,
    selected?.departmentId,
    selected?.date,
  )

  const model = useMemo(() => {
    const rows = heatmap.data ?? []
    if (!rows.length) return null

    const dates = rows.map((r) => r.load_date).sort()
    const days = eachDay(dates[0], dates[dates.length - 1])

    const departments = [
      ...new Map(
        rows.map((r) => [
          r.department_id,
          {
            id: r.department_id,
            code: r.department_code,
            position: r.route_position,
          },
        ]),
      ).values(),
    ].sort((a, b) => a.position - b.position)

    const byKey = new Map(
      rows.map((r) => [`${r.department_id}|${r.load_date}`, r]),
    )

    const today = todayIso()
    return { days, departments, byKey, months: monthBands(days), today }
  }, [heatmap.data])

  const totals = useMemo(() => {
    const rows = heatmap.data ?? []
    return {
      over: rows.filter((r) => r.status === 'over').length,
      loaded: rows.filter((r) => r.status === 'loaded').length,
      idle: rows.filter((r) => r.status === 'idle').length,
    }
  }, [heatmap.data])

  const nameOf = (code: string) => names.get(code) ?? code

  return (
    <div className="space-y-6">
      <Panel
        title="Load heatmap"
        meta={
          model
            ? `${formatDateLong(model.days[0])} — ${formatDateLong(model.days[model.days.length - 1])}`
            : undefined
        }
      >
        <p className="text-mid mb-4 max-w-[85ch] text-caption">
          Each cell is one department on one day, shaded by how much of the day
          the planned work consumes. Because a department can be making several
          components at once, the figure is the sum of the fractions of the day
          each one takes — units of legs and units of covers cannot be added, but
          the time they take can. Anything over 1.00 is flagged.
        </p>

        {!model ? (
          <Empty>No schedule run yet. Run one from the command centre.</Empty>
        ) : (
          <>
            {/* Declared dense, not accidentally so. Every cell here is at
                least 14px wide because the point of a heatmap is the shape of
                a month at once; thumb-sized cells would show a week. The
                browser check reads this attribute and skips what is inside
                it, so the exception is visible in the source rather than
                hidden in a selector. The columns grow to fill the panel when
                the horizon is short, and the grid scrolls when it is long. */}
            <div
              data-dense-grid="a heatmap is an overview; 44px cells would show a week"
              data-testid="heatmap-grid"
              // What arrived, so a check against the hosted backend can tell a
              // whole factory from the first thousand cells of one. PostgREST
              // caps a response and does not say it has: the grid rendered six
              // of fourteen departments and looked perfectly normal.
              data-departments={model.departments.length}
              data-days={model.days.length}
              data-over={totals.over}
              className="border-rule overflow-x-auto border"
            >
              <div
                className="grid"
                style={{
                  gridTemplateColumns: `160px repeat(${model.days.length}, minmax(14px, 1fr))`,
                }}
              >
                {/* Months. */}
                <div className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b" />
                {model.months.map((m) => (
                  <div
                    key={`${m.label}-${m.start}`}
                    style={{ gridColumn: `span ${m.span}` }}
                    className="label border-rule border-b border-l py-1 pl-1.5 whitespace-nowrap"
                  >
                    {m.span >= 4 ? m.label : ''}
                  </div>
                ))}

                {/* Days: the date on each Monday and on the first of the
                    month, today in blue. The rest stay blank so the eye can
                    count weeks rather than read sixty-seven numbers. */}
                <div className="label bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b px-2 py-1">
                  Department
                </div>
                {model.days.map((day, i) => {
                  // The first of the month is labelled unless a Monday label
                  // sits in the column beside it, where "31 1" reads as one
                  // number.
                  const besideMonday =
                    (i > 0 && isMonday(model.days[i - 1])) ||
                    (i + 1 < model.days.length && isMonday(model.days[i + 1]))
                  const show =
                    day === model.today ||
                    isMonday(day) ||
                    (isFirstOfMonth(day) && !besideMonday)
                  return (
                    <div
                      key={day}
                      title={formatDateLong(day)}
                      className={`border-rule-soft border-b text-center font-mono text-[10px] leading-5 ${
                        day === model.today
                          ? 'text-blue font-semibold'
                          : 'text-faint'
                      } ${columnLine(day, model.today)}`}
                    >
                      {show ? Number(day.slice(8)) : ''}
                    </div>
                  )
                })}

                {model.departments.map((dept) => (
                  <Row
                    key={dept.id}
                    dept={dept}
                    name={nameOf(dept.code)}
                    days={model.days}
                    today={model.today}
                    byKey={model.byKey}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ))}
              </div>
            </div>

            <p className="text-faint mt-2 text-caption">
              {model.days.length} days across the horizon
              {model.days.length > 60 ? ' — scroll sideways for the rest' : ''}.
              The number above a column is the date; every Monday is marked, and
              today is in blue. Tap or hover any cell for its figure.
            </p>

            <div className="text-mid mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption">
              <Legend
                style={{ backgroundColor: loadFill(0.3) }}
                label="Part loaded"
              />
              <Legend
                style={{ backgroundColor: loadFill(1) }}
                label="At capacity"
              />
              <Legend className="bg-flag" label={`Over capacity · ${totals.over}`} />
              <Legend
                className="border-rule-soft border"
                label={`Idle · ${totals.idle}`}
              />
              <Legend
                className="border-rule border border-dashed"
                label="Closed — Sunday or holiday"
              />
            </div>
          </>
        )}
      </Panel>

      {selected ? (
        <Panel
          title={`${nameOf(selected.departmentCode)} — ${formatDateLong(selected.date)}`}
          meta="What is on this day"
        >
          <Table>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th>Component</Th>
                <Th align="right">Planned</Th>
                <Th align="right">Capacity</Th>
                <Th align="right">Share of day</Th>
              </tr>
            </thead>
            <tbody>
              {detail.data?.map((d) => (
                <tr key={`${d.erp_order_no}-${d.component_code}`}>
                  <Td>{d.erp_order_no}</Td>
                  <Td>{d.customer_name}</Td>
                  <Td className="text-mid" title={d.component_code}>{componentLabel(d.component_code, names)}</Td>
                  <Td align="right">{formatNumber(d.qty_planned, 1)}</Td>
                  <Td align="right">{formatNumber(d.capacity, 0)}</Td>
                  <Td align="right">
                    {d.capacity
                      ? `${((d.qty_planned / d.capacity) * 100).toFixed(0)}%`
                      : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!detail.data?.length ? (
            <Empty>Nothing planned on this day — the department is idle.</Empty>
          ) : null}
        </Panel>
      ) : (
        <p className="text-faint text-caption">
          Select a cell to see which orders and components are on that day. The
          grid stays dense on a phone on purpose — a heatmap is for seeing the
          shape of a month at once, and thumb-sized cells would show a week.
        </p>
      )}
    </div>
  )
}

function Row({
  dept,
  name,
  days,
  today,
  byKey,
  selected,
  onSelect,
}: {
  dept: { id: string; code: string; position: number }
  name: string
  days: string[]
  today: string
  byKey: Map<string, HeatmapCell>
  selected: { departmentId: string; date: string } | null
  onSelect: (s: {
    departmentId: string
    departmentCode: string
    date: string
  }) => void
}) {
  return (
    <>
      <div
        className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b px-2 py-1.5"
        title={dept.code}
      >
        <div className="truncate text-caption font-semibold">{name}</div>
      </div>
      {days.map((day) => {
        const cell = byKey.get(`${dept.id}|${day}`)
        const { className, style } = cellStyle(cell)
        const isSelected =
          selected?.departmentId === dept.id && selected?.date === day
        return (
          <div key={day} className={`flex h-[20px] ${columnLine(day, today)}`}>
            <button
              type="button"
              disabled={!cell}
              onClick={() =>
                onSelect({
                  departmentId: dept.id,
                  departmentCode: dept.code,
                  date: day,
                })
              }
              title={
                cell
                  ? `${name} · ${formatDateLong(day)} · ${Math.round(cell.utilisation * 100)}% of capacity`
                  : `${formatDateLong(day)} — closed`
              }
              // For the checks and the capture scripts, which read these
              // rather than parse the title: the title is for people, and
              // the day it changed wording, every script parsing it broke.
              data-department={dept.code}
              data-date={day}
              data-utilisation={cell ? cell.utilisation.toFixed(2) : undefined}
              className={`m-[1px] flex-1 rounded-[2px] ${className} ${
                isSelected ? 'outline-ink outline-2 outline-offset-1' : ''
              } ${cell ? 'cursor-pointer' : 'cursor-default'}`}
              style={style}
            />
          </div>
        )
      })}
    </>
  )
}

function Legend({
  className = '',
  style,
  label,
}: {
  className?: string
  style?: React.CSSProperties
  label: string
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`inline-block h-3 w-3 rounded-[2px] ${className}`}
        style={style}
      />
      {label}
    </span>
  )
}
