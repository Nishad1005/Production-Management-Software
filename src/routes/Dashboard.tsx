import { useMemo, useState } from 'react'
import { useMdDashboard, type Kpi } from '@/data/planning'
import { useProductionVsPlan, type ProductionVsPlan } from '@/data/wip'
import { Empty, Panel, Table, Td, Th, Waiting } from '@/components/ui'
import { BarPairs, PlanVsMadeGrid, PlanVsMadeLegend } from '@/components/charts'
import { gridFromRows, workingDaysBack } from '@/lib/plan-vs-made'
import { stateOf, waiting } from '@/lib/query-state'
import { formatDate, formatNumber, todayIso } from '@/components/format'

/**
 * The MD's dashboard, slide 6 of the concept deck.
 *
 * Built last of the planning screens rather than first, which was deliberate:
 * six of its nine figures need actuals from the floor, and until the WIP ledger
 * existed there were none. A dashboard is believed — six invented numbers
 * standing beside three real ones would have made all nine worthless.
 */
export function Dashboard() {
  const kpis = useMdDashboard()
  const rows = kpis.data ?? []
  const kpiState = stateOf(kpis)

  const missing = rows.filter((r) => !r.available)
  const bad = rows.filter((r) => r.status === 'bad')

  return (
    <div className="space-y-6">
      <Panel
        title="Is the factory on track today?"
        meta={
          waiting(kpiState)
            ? undefined
            : bad.length
              ? `${bad.length} off target`
              : rows.length
                ? 'nothing off target'
                : ''
        }
      >
        <div
          data-testid="md-kpis"
          data-state={kpiState}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {waiting(kpiState) ? (
            <div className="col-span-full">
              <Waiting state={kpiState} error={kpis.error} loading="Computing the ten figures…" />
            </div>
          ) : (
            rows.map((kpi) => <KpiCard key={kpi.key} kpi={kpi} />)
          )}
        </div>

        {missing.length ? (
          <p className="text-faint mt-4 max-w-[80ch] text-caption">
            {missing.length} of {rows.length} cannot be computed yet, and say so
            rather than showing a zero. Each names what it is waiting for.
          </p>
        ) : null}
      </Panel>

      <ProductionAgainstPlan />
    </div>
  )
}

/**
 * Deck slide 11. Planned against declared, per department per day.
 *
 * A full join in SQL, which is the interesting part: a department that made
 * something nobody planned appears here as plainly as one that made nothing it
 * was asked for. The KPIs above say whether the factory is on track; this says
 * where it came apart.
 */
function ProductionAgainstPlan() {
  // Fourteen working days, Sundays out. Local, not UTC: the production screen
  // records against the local date, and a range ending on UTC-today drops
  // everything entered after midnight here — which reads on screen as a
  // factory that made nothing.
  const to = todayIso()
  const workingDays = useMemo(() => workingDaysBack(to, 14), [to])
  const days = workingDays.length
  const from = workingDays[0]

  const vsPlan = useProductionVsPlan(from, to)
  const rows = (vsPlan.data ?? []).filter(
    (r) => r.qty_planned > 0 || r.qty_good > 0 || r.qty_rejected > 0,
  )
  const behind = rows.filter((r) => r.variance < 0)
  const state = stateOf(vsPlan)

  // The picture: one row per department, one cell per day, and one
  // department's bars when a row is chosen. Units are not additive across
  // departments, so there is no factory-wide bar.
  const grid = useMemo(() => gridFromRows(vsPlan.data ?? [], workingDays), [vsPlan.data, workingDays])
  const [selected, setSelected] = useState<string | null>(null)
  const chosen = selected ? grid.departments.find((d) => d.code === selected) : undefined
  const shown = chosen ? rows.filter((r) => r.department_code === chosen.code) : rows

  return (
    <Panel
      title="Planned against made"
      meta={
        waiting(state)
          ? undefined
          : rows.length
            ? `${behind.length} of ${rows.length} short, last ${days} days`
            : `last ${days} days`
      }
    >
      <div data-testid="production-vs-plan" data-state={state}>
        {waiting(state) ? (
          <Waiting state={state} error={vsPlan.error} loading="Comparing the fortnight…" />
        ) : rows.length === 0 ? (
          <Empty>
            Nothing was planned or declared in the last {days} days. Output is
            entered on the Production screen, by the department that made it.
          </Empty>
        ) : (
          <div className="space-y-4">
            <PlanVsMadeGrid grid={grid} selected={selected} onSelect={setSelected} />
            <PlanVsMadeLegend />
            {chosen ? (
              <div data-testid="plan-vs-made-chosen" data-code={chosen.code} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-small font-semibold">{chosen.name}, the last {days} working days</span>
                  <button
                    type="button"
                    className="text-blue text-caption hover:underline"
                    onClick={() => setSelected(null)}
                  >
                    Every department
                  </button>
                </div>
                <BarPairs cells={grid.cells.get(chosen.code) ?? []} name={chosen.name} code={chosen.code} />
              </div>
            ) : (
              <p className="text-faint text-caption">Click a department for its bars and its days alone.</p>
            )}
            <Table>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th>Department</Th>
                  <Th align="right">Planned</Th>
                  <Th align="right">Made</Th>
                  <Th align="right">Rejected</Th>
                  <Th align="right">Variance</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <Row key={`${r.work_date}-${r.department_code}`} row={r} />
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Panel>
  )
}

function Row({ row }: { row: ProductionVsPlan }) {
  // Planned nothing and made something is not a variance to be praised for —
  // it is work that arrived off-plan, and it reads differently.
  const unplanned = row.qty_planned === 0 && row.qty_good > 0

  return (
    <tr>
      <Td>{formatDate(row.work_date)}</Td>
      <Td>{row.department_name}</Td>
      <Td align="right">{row.qty_planned ? formatNumber(row.qty_planned) : '—'}</Td>
      <Td align="right">{row.qty_good ? formatNumber(row.qty_good) : '—'}</Td>
      <Td align="right">
        {row.qty_rejected ? (
          <span className="text-amber">{formatNumber(row.qty_rejected)}</span>
        ) : (
          '—'
        )}
      </Td>
      <Td align="right">
        {unplanned ? (
          <span className="text-mid">not planned</span>
        ) : (
          <span className={row.variance < 0 ? 'text-flag' : 'text-clear'}>
            {row.variance > 0 ? '+' : ''}
            {formatNumber(row.variance)}
          </span>
        )}
      </Td>
    </tr>
  )
}

/*
 * The same card as `Metric` in ui.tsx — a left accent in the load vocabulary,
 * a caption, a large tabular figure. Kept as its own component because a KPI
 * carries things a metric does not: a target, a unit, a caveat, and the
 * possibility of having no answer at all.
 */
const TONE: Record<Kpi['status'], string> = {
  good: 'border-l-clear',
  warn: 'border-l-amber',
  bad: 'border-l-flag',
  none: 'border-l-rule',
  unavailable: 'border-l-rule',
}

const LABEL: Record<Kpi['status'], string> = {
  good: 'text-clear',
  warn: 'text-amber',
  bad: 'text-flag',
  none: 'text-faint',
  unavailable: 'text-faint',
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const money = kpi.unit === '₹'
  const suffix = kpi.unit === '%' ? '%' : ''

  return (
    <div
      className={`bg-sheet border-rule rounded-card shadow-card border border-l-[3px] p-4 ${TONE[kpi.status]}`}
    >
      <div className="label">{kpi.label}</div>

      {kpi.available ? (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`font-display nums text-display font-bold tracking-[-0.02em] ${LABEL[kpi.status]}`}
            >
              {money ? '₹' : ''}
              {formatNumber(kpi.actual, kpi.unit === '%' ? 1 : 0)}
              {suffix}
            </span>
            {kpi.target > 0 ? (
              <span className="text-faint text-caption">
                target {formatNumber(kpi.target, 0)}
                {suffix}
              </span>
            ) : null}
          </div>
          {kpi.unit !== '%' && kpi.unit !== '₹' ? (
            <div className="text-faint text-caption">{kpi.unit}</div>
          ) : null}
          {/* A total that quietly omits part of the floor is worse than no
              total, so the caveat sits with the number rather than in a
              footnote nobody reads. */}
          {kpi.note ? (
            <div className="text-mid mt-1 text-caption">{kpi.note}</div>
          ) : null}
        </>
      ) : (
        <>
          <div className="text-faint font-display text-display mt-1 font-bold">—</div>
          {/* The reason, not a dash on its own. An empty figure with no
              explanation reads as a bug; with one it reads as a next step. */}
          <p className="text-mid mt-1 text-caption">
            {kpi.unavailable_because}
          </p>
        </>
      )}
    </div>
  )
}
