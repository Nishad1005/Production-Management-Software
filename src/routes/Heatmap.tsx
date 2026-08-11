import { useMemo, useState } from 'react'
import {
  useCellDetail,
  useCurrentRun,
  useHeatmap,
  type HeatmapCell,
} from '@/data/planning'
import { Empty, Panel, Table, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'

const MS_PER_DAY = 86_400_000

function eachDay(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  const out: string[] = []
  for (let t = start; t <= end; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

function cellStyle(cell: HeatmapCell | undefined) {
  // A day with no row at all is a day the factory is closed — Sunday or a
  // declared holiday. Drawn, not skipped, so the week has its real shape.
  if (!cell) return { className: 'border border-dashed border-rule', style: {} }
  if (cell.status === 'over')
    return { className: 'bg-flag', style: {} }
  if (cell.status === 'idle')
    return { className: 'border border-rule-soft', style: {} }
  return {
    className: 'bg-clear',
    style: { opacity: Math.max(0.28, Math.min(1, cell.utilisation)) },
  }
}

export function Heatmap() {
  const run = useCurrentRun()
  const heatmap = useHeatmap(run.data?.id)
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

    // Month boundaries, for the strip above the grid.
    const months: { label: string; span: number }[] = []
    for (const day of days) {
      const label = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      })
      const last = months[months.length - 1]
      if (last?.label === label) last.span += 1
      else months.push({ label, span: 1 })
    }

    return { days, departments, byKey, months }
  }, [heatmap.data])

  const totals = useMemo(() => {
    const rows = heatmap.data ?? []
    return {
      over: rows.filter((r) => r.status === 'over').length,
      loaded: rows.filter((r) => r.status === 'loaded').length,
      idle: rows.filter((r) => r.status === 'idle').length,
    }
  }, [heatmap.data])

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
        <p className="text-mid mb-4 max-w-[85ch] text-[12px]">
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
            <div className="border-rule overflow-x-auto border">
              <div className="min-w-max">
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `140px repeat(${model.days.length}, 14px)`,
                  }}
                >
                  <div className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b" />
                  {model.months.map((m, i) => (
                    <div
                      key={`${m.label}-${i}`}
                      style={{ gridColumn: `span ${m.span}` }}
                      className="label border-rule-soft border-r border-b py-1 pl-1.5 text-[9.5px]"
                    >
                      {m.span > 3 ? m.label : ''}
                    </div>
                  ))}

                  {model.departments.map((dept) => (
                    <Row
                      key={dept.id}
                      dept={dept}
                      days={model.days}
                      byKey={model.byKey}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  ))}
                </div>
              </div>
            </div>

            <p className="text-faint mt-2 text-[11px]">
              {model.days.length} days across the horizon — scroll sideways for
              the rest. Hover any cell for its figure.
            </p>

            <div className="text-mid mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px]">
              <Legend className="bg-clear opacity-40" label="Part loaded" />
              <Legend className="bg-clear" label="At capacity" />
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
          title={`${selected.departmentCode} — ${formatDateLong(selected.date)}`}
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
                  <Td>{d.component_code}</Td>
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
        <p className="text-faint text-[11.5px]">
          Select a cell to see which orders and components are on that day.
        </p>
      )}
    </div>
  )
}

function Row({
  dept,
  days,
  byKey,
  selected,
  onSelect,
}: {
  dept: { id: string; code: string; position: number }
  days: string[]
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
      <div className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b px-2 py-1.5">
        <div className="font-sans text-[12px] font-semibold">{dept.code}</div>
      </div>
      {days.map((day) => {
        const cell = byKey.get(`${dept.id}|${day}`)
        const { className, style } = cellStyle(cell)
        const isSelected =
          selected?.departmentId === dept.id && selected?.date === day
        return (
          <button
            key={day}
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
                ? `${dept.code} · ${day} · ${cell.utilisation.toFixed(2)} of capacity`
                : `${day} — closed`
            }
            className={`m-[1px] h-[18px] ${className} ${
              isSelected ? 'outline-ink outline-2 outline-offset-1' : ''
            } ${cell ? 'cursor-pointer' : 'cursor-default'}`}
            style={style}
          />
        )
      })}
    </>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 ${className}`} />
      {label}
    </span>
  )
}
