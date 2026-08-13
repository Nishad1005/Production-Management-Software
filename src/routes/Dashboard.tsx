import { useMdDashboard, type Kpi } from '@/data/planning'
import { Panel } from '@/components/ui'
import { formatNumber } from '@/components/format'

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

  const missing = rows.filter((r) => !r.available)
  const bad = rows.filter((r) => r.status === 'bad')

  return (
    <div className="space-y-6">
      <Panel
        title="Is the factory on track today?"
        meta={
          bad.length
            ? `${bad.length} off target`
            : rows.length
              ? 'nothing off target'
              : ''
        }
      >
        <div
          data-testid="md-kpis"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {rows.map((kpi) => (
            <KpiCard key={kpi.key} kpi={kpi} />
          ))}
        </div>

        {missing.length ? (
          <p className="text-faint mt-4 max-w-[80ch] text-[11.5px]">
            {missing.length} of {rows.length} cannot be computed yet, and say so
            rather than showing a zero. Each names what it is waiting for.
          </p>
        ) : null}
      </Panel>
    </div>
  )
}

const TONE: Record<Kpi['status'], string> = {
  good: 'border-clear',
  warn: 'border-amber',
  bad: 'border-flag',
  none: 'border-rule',
  unavailable: 'border-rule',
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
    <div className={`bg-sheet border-l-2 border p-3.5 ${TONE[kpi.status]}`}>
      <div className="text-faint text-[10px] tracking-wider uppercase">
        {kpi.label}
      </div>

      {kpi.available ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className={`text-[26px] font-semibold ${LABEL[kpi.status]}`}>
              {money ? '₹' : ''}
              {formatNumber(kpi.actual, kpi.unit === '%' ? 1 : 0)}
              {suffix}
            </span>
            {kpi.target > 0 ? (
              <span className="text-faint text-[12px]">
                target {formatNumber(kpi.target, 0)}
                {suffix}
              </span>
            ) : null}
          </div>
          {kpi.unit !== '%' && kpi.unit !== '₹' ? (
            <div className="text-faint text-[11.5px]">{kpi.unit}</div>
          ) : null}
          {/* A total that quietly omits part of the floor is worse than no
              total, so the caveat sits with the number rather than in a
              footnote nobody reads. */}
          {kpi.note ? (
            <div className="text-mid mt-1 text-[11.5px]">{kpi.note}</div>
          ) : null}
        </>
      ) : (
        <>
          <div className="text-faint mt-1.5 text-[22px] font-semibold">—</div>
          {/* The reason, not a dash on its own. An empty figure with no
              explanation reads as a bug; with one it reads as a next step. */}
          <p className="text-mid mt-1 text-[11.5px]">
            {kpi.unavailable_because}
          </p>
        </>
      )}
    </div>
  )
}
