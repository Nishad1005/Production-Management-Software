import { useMemo } from 'react'
import { useBottlenecks, useCurrentRun, useRouteGraph } from '@/data/planning'
import { useMachineStatus } from '@/data/mutations'
import { Empty, Panel } from '@/components/ui'
import { formatNumber } from '@/components/format'

/**
 * Deck slide 3, first bullet: "digital factory map showing each production area
 * with live status and WIP counts".
 *
 * ---------------------------------------------------------------------------
 * This is a flow map, not a floor plan, and it says so on the screen.
 *
 * Nobody has given us a physical layout of U&M's factory. Drawing one from
 * imagination would produce a picture that is confidently wrong about where
 * things are — the worst kind of wrong, because a map is believed on sight and
 * nobody checks a diagram against a building.
 *
 * What Kram genuinely knows is the route graph: which department feeds which,
 * which start on their own, and which wait for more than one thing. That is a
 * real structure, it is the one the engine plans on, and it is worth seeing.
 * When U&M send a floor plan this can be laid over it; until then the drawing
 * claims only what the data supports.
 * ---------------------------------------------------------------------------
 *
 * Inline SVG, laid out by dependency depth rather than by a layout library:
 * fourteen nodes do not need three hundred kilobytes of graph engine.
 */
export function FactoryMap() {
  const graph = useRouteGraph()
  const run = useCurrentRun()
  const bottlenecks = useBottlenecks(run.data?.id)
  const machines = useMachineStatus()

  const model = useMemo(() => {
    const cells = graph.data ?? []
    if (!cells.length) return null

    // Every department, and what each waits for.
    const names = new Map<string, string>()
    const feeders = new Map<string, string[]>()
    for (const c of cells) {
      names.set(c.department_code, c.department_name)
      names.set(c.feeder_code, c.feeder_name)
      if (!feeders.has(c.department_code)) feeders.set(c.department_code, [])
      if (c.feeds) feeders.get(c.department_code)!.push(c.feeder_code)
    }
    for (const code of names.keys()) if (!feeders.has(code)) feeders.set(code, [])

    // Depth = how far down the chain a department sits. Everything with no
    // feeder is a starting point and sits in column zero; everything else sits
    // one past the furthest thing it waits for. That is the same walk the
    // engine does, so the picture and the plan agree by construction.
    const depth = new Map<string, number>()
    const resolve = (code: string, seen = new Set<string>()): number => {
      if (depth.has(code)) return depth.get(code)!
      if (seen.has(code)) return 0
      seen.add(code)
      const mine = feeders.get(code) ?? []
      const d = mine.length ? Math.max(...mine.map((f) => resolve(f, seen))) + 1 : 0
      depth.set(code, d)
      return d
    }
    for (const code of names.keys()) resolve(code)

    const columns = new Map<number, string[]>()
    for (const [code, d] of depth) {
      if (!columns.has(d)) columns.set(d, [])
      columns.get(d)!.push(code)
    }
    for (const list of columns.values()) list.sort()

    return { names, feeders, depth, columns }
  }, [graph.data])

  const worst = new Map(
    (bottlenecks.data ?? []).map((b) => [b.department_code, b]),
  )
  const machineOf = new Map(
    (machines.data ?? []).map((m) => [m.department_code, m]),
  )

  if (!model) {
    return (
      <Panel title="The factory, as it flows">
        <Empty>
          No route has been entered yet. This draws what feeds what, so it fills
          in once the route graph does — on Masters, under “What feeds what”.
        </Empty>
      </Panel>
    )
  }

  const COL_W = 210
  const ROW_H = 92
  const BOX_W = 168
  const BOX_H = 62
  const depths = [...model.columns.keys()].sort((a, b) => a - b)
  const rows = Math.max(...[...model.columns.values()].map((c) => c.length))
  const width = depths.length * COL_W + 40
  const height = rows * ROW_H + 40

  const position = (code: string) => {
    const d = model.depth.get(code)!
    const list = model.columns.get(d)!
    const i = list.indexOf(code)
    // Centred in its column, so a column of two does not hug the top.
    const offset = (rows - list.length) / 2
    return { x: 20 + d * COL_W, y: 20 + (i + offset) * ROW_H }
  }

  const tone = (code: string) => {
    const b = worst.get(code)
    if (!b) return { fill: 'var(--color-sheet)', stroke: 'var(--color-rule)' }
    if (b.peak_utilisation > 1.0001)
      return { fill: 'var(--color-flag-wash)', stroke: 'var(--color-flag)' }
    if (b.avg_utilisation > 0.85)
      return { fill: 'var(--color-amber-wash)', stroke: 'var(--color-amber)' }
    return { fill: 'var(--color-sheet)', stroke: 'var(--color-clear)' }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="The factory, as it flows"
        meta={`${model.names.size} departments`}
      >
        <p className="text-mid mb-4 max-w-[80ch] text-caption">
          <strong>This is a flow map, not a floor plan.</strong> Nobody has given
          us a layout of the building, and a drawing that guessed at one would be
          believed on sight. What this shows is what Kram actually knows: which
          department waits for which, laid out left to right by how far down the
          chain each sits. Columns run in parallel — nothing in one column waits
          for anything else in it.
        </p>

        <div className="border-rule overflow-x-auto border p-2" data-testid="factory-map">
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="min-w-max"
            role="img"
            aria-label="Departments and what feeds what"
          >
            {/* Edges first, so boxes sit on top of them. */}
            {[...model.feeders.entries()].flatMap(([code, list]) =>
              list.map((feeder) => {
                const from = position(feeder)
                const to = position(code)
                const x1 = from.x + BOX_W
                const y1 = from.y + BOX_H / 2
                const x2 = to.x
                const y2 = to.y + BOX_H / 2
                const mid = (x1 + x2) / 2
                return (
                  <path
                    key={`${feeder}->${code}`}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--color-rule)"
                    strokeWidth={1.5}
                  />
                )
              }),
            )}

            {[...model.names.entries()].map(([code, name]) => {
              const { x, y } = position(code)
              const t = tone(code)
              const b = worst.get(code)
              const m = machineOf.get(code)
              const entry = (model.feeders.get(code) ?? []).length === 0

              return (
                <g key={code} data-testid={`map-node-${code}`}>
                  <rect
                    x={x}
                    y={y}
                    width={BOX_W}
                    height={BOX_H}
                    fill={t.fill}
                    stroke={t.stroke}
                    strokeWidth={entry ? 2 : 1.2}
                  />
                  <text
                    x={x + 10}
                    y={y + 22}
                    className="fill-ink font-sans"
                    fontSize="14"
                    fontWeight="600"
                  >
                    {name.length > 20 ? name.slice(0, 19) + '…' : name}
                  </text>
                  <text x={x + 10} y={y + 39} fill="var(--color-mid)" fontSize="12">
                    {b
                      ? `peak ${formatNumber(b.peak_utilisation * 100, 0)}% · ${b.flagged_days} flagged`
                      : 'no plan yet'}
                  </text>
                  <text x={x + 10} y={y + 53} fill="var(--color-faint)" fontSize="11">
                    {m ? `${m.available}/${m.machines} machines` : ''}
                    {entry ? (m ? ' · starts on its own' : 'starts on its own') : ''}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>

        <div className="text-faint mt-3 flex flex-wrap gap-x-5 gap-y-1 text-caption">
          <span>Red — over capacity on at least one day</span>
          <span>Amber — running above 85%</span>
          <span>Thick border — starts on its own, waits for nothing</span>
        </div>
      </Panel>
    </div>
  )
}
