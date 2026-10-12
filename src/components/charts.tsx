import { Fragment } from 'react'
import type { DayCell, DayState, PlanVsMadeGrid as Grid } from '@/lib/plan-vs-made'
import { formatDateLong, formatNumber } from '@/components/format'

/**
 * Two pictures of planned against made, drawn by hand because the application
 * carries no chart library and these are the only charts in it.
 *
 * Units are not additive across departments, so there is no factory-wide bar:
 * the grid gives every department its own row, each cell its own made ÷
 * planned, and the bars show one department at a time. Colour means what it
 * means everywhere else here — green met, amber behind, red short — and a day
 * with output and no plan is striped, because it is neither.
 */

const CELL: Record<DayState, string> = {
  none: 'bg-rule-soft',
  met: 'bg-clear',
  behind: 'bg-amber',
  short: 'bg-flag',
  unplanned: 'bg-sheet',
}
const STRIPES = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--color-amber) 0 3px, transparent 3px 7px)',
}

function describe(name: string, c: DayCell) {
  const day = formatDateLong(c.date)
  if (c.state === 'none') return `${name}, ${day}: nothing planned, nothing made`
  if (c.state === 'unplanned')
    return `${name}, ${day}: ${formatNumber(c.made)} made, nothing planned`
  return `${name}, ${day}: made ${formatNumber(c.made)} of ${formatNumber(c.planned)} planned (${Math.round((c.ratio ?? 0) * 100)}%)${
    c.rejected ? ` · ${formatNumber(c.rejected)} rejected` : ''
  }`
}

export function PlanVsMadeGrid({
  grid,
  selected,
  onSelect,
}: {
  grid: Grid
  selected: string | null
  onSelect: (code: string | null) => void
}) {
  return (
    <div
      data-testid="plan-vs-made-grid"
      data-dense-grid="a fortnight by department is an overview; 44px rows would show three departments"
      data-days={grid.days.length}
      data-departments={grid.departments.length}
      className="border-rule overflow-x-auto border"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `minmax(8rem, auto) repeat(${grid.days.length}, minmax(1.6rem, 1fr))`,
        }}
      >
        <div className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b" />
        {grid.days.map((d) => (
          <div
            key={d}
            title={formatDateLong(d)}
            className="border-rule-soft text-faint border-b text-center font-mono text-[10px] leading-5"
          >
            {Number(d.slice(8))}
          </div>
        ))}
        {grid.departments.map((dept) => (
          <Fragment key={dept.code}>
            <button
              type="button"
              data-code={dept.code}
              aria-pressed={selected === dept.code}
              onClick={() => onSelect(selected === dept.code ? null : dept.code)}
              className={`bg-sheet border-rule-soft sticky left-0 z-10 min-h-6 border-r border-b px-2 text-left text-caption hover:underline ${
                selected === dept.code ? 'font-semibold' : 'text-mid'
              }`}
            >
              {dept.name}
            </button>
            {grid.cells.get(dept.code)!.map((c) => (
              <div
                key={c.date}
                data-state={c.state}
                data-ratio={c.ratio === null ? undefined : c.ratio.toFixed(2)}
                title={describe(dept.name, c)}
                className={`border-rule-soft h-6 border-b border-l ${CELL[c.state]}`}
                style={c.state === 'unplanned' ? STRIPES : undefined}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export function PlanVsMadeLegend() {
  const swatch = (cls: string, style?: React.CSSProperties) => (
    <span className={`inline-block h-3 w-3 align-[-2px] ${cls}`} style={style} />
  )
  return (
    <p className="text-mid flex flex-wrap gap-x-4 gap-y-1 text-caption">
      <span>{swatch('bg-clear')} made what was planned</span>
      <span>{swatch('bg-amber')} 70% or more</span>
      <span>{swatch('bg-flag')} under 70%</span>
      <span>{swatch('bg-sheet border-rule border', STRIPES)} made, nothing planned</span>
      <span>{swatch('bg-rule-soft')} nothing either way</span>
    </p>
  )
}

/**
 * One department's fortnight: a grey bar for what was planned beside a
 * coloured one for what was made, with rejected pieces stacked on top in
 * amber. The scale is the department's own, so it is never compared to
 * another's.
 */
export function BarPairs({ cells, name, code }: { cells: DayCell[]; name: string; code: string }) {
  const W = 900
  const H = 170
  const padL = 44
  const padR = 6
  const padT = 8
  const padB = 22
  const max = Math.max(1, ...cells.map((c) => Math.max(c.planned, c.made + c.rejected)))
  const slot = (W - padL - padR) / Math.max(1, cells.length)
  const bar = Math.max(3, Math.min(14, slot * 0.36))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const base = y(0)
  const made = (c: DayCell) =>
    c.state === 'short'
      ? 'var(--color-flag)'
      : c.state === 'behind' || c.state === 'unplanned'
        ? 'var(--color-amber)'
        : 'var(--color-clear)'

  return (
    <svg
      data-testid="plan-vs-made-bars"
      data-department={code}
      data-days={cells.length}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label={`${name}: planned against made, last ${cells.length} working days`}
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(max * f)}
            y2={y(max * f)}
            style={{ stroke: 'var(--color-rule-soft)' }}
            strokeWidth={1}
          />
          <text
            x={padL - 6}
            y={y(max * f) + 3}
            textAnchor="end"
            fontSize={9}
            fontFamily="var(--font-mono)"
            style={{ fill: 'var(--color-faint)' }}
          >
            {formatNumber(Math.round(max * f))}
          </text>
        </g>
      ))}
      {cells.map((c, i) => {
        const x0 = padL + i * slot + (slot - 2 * bar - 2) / 2
        return (
          <g key={c.date}>
            <title>{describe(name, c)}</title>
            <rect
              x={x0}
              y={y(c.planned)}
              width={bar}
              height={Math.max(0, base - y(c.planned))}
              style={{ fill: 'var(--color-rule)' }}
            />
            <rect
              x={x0 + bar + 2}
              y={y(c.made)}
              width={bar}
              height={Math.max(0, base - y(c.made))}
              style={{ fill: made(c) }}
            />
            {c.rejected > 0 ? (
              <rect
                x={x0 + bar + 2}
                y={y(c.made + c.rejected)}
                width={bar}
                height={Math.max(0, y(c.made) - y(c.made + c.rejected))}
                style={{ fill: 'var(--color-amber)', opacity: 0.55 }}
              />
            ) : null}
            <text
              x={x0 + bar + 1}
              y={H - 8}
              textAnchor="middle"
              fontSize={9}
              fontFamily="var(--font-mono)"
              style={{ fill: 'var(--color-faint)' }}
            >
              {Number(c.date.slice(8))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
