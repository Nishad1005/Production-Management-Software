import { Link } from 'react-router'
import { useAttention, type Finding } from '@/data/attention'
import { Empty, Panel, Tag } from '@/components/ui'

/**
 * Everything the software has noticed, in one place.
 *
 * Until this existed, every finding Kram made required somebody to open the
 * right screen and look — fine on the day they think to look, useless on the
 * day they do not. That is deck slide 2's fifth objective, and it was the
 * largest gap between what was asked for and what had been built.
 *
 * **There is no dismiss.** An alert somebody can silence while it is still true
 * becomes wallpaper. The list stays readable by being short and ordered, and
 * every row links to the screen that makes it go away — which is the difference
 * between an alert and a complaint.
 */
export function Attention() {
  const attention = useAttention()
  const rows = attention.data ?? []

  const critical = rows.filter((r) => r.severity === 'critical')
  const warning = rows.filter((r) => r.severity === 'warning')
  const info = rows.filter((r) => r.severity === 'info')

  return (
    <div className="space-y-6">
      <Panel
        title="Needs an answer today"
        meta={critical.length ? `${critical.length} critical` : 'nothing critical'}
      >
        <div data-testid="attention-critical" data-count={critical.length}>
          {critical.length === 0 ? (
            <Empty>
              Nothing the software can see needs deciding today. That is a real
              finding rather than an empty screen — every check below has run.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {critical.map((r) => (
                <FindingCard key={r.key} row={r} />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Worth knowing"
        meta={warning.length ? `${warning.length} warnings` : 'nothing'}
      >
        <div data-testid="attention-warning" data-count={warning.length}>
          {warning.length === 0 ? (
            <Empty>Nothing outstanding.</Empty>
          ) : (
            <div className="space-y-2.5">
              {warning.map((r) => (
                <FindingCard key={r.key} row={r} />
              ))}
            </div>
          )}
        </div>
      </Panel>

      {info.length ? (
        <Panel title="For the record" meta={`${info.length}`}>
          <div data-testid="attention-info" className="space-y-2.5">
            {info.map((r) => (
              <FindingCard key={r.key} row={r} />
            ))}
          </div>
        </Panel>
      ) : null}

      <p className="text-faint max-w-[85ch] text-[11.5px]">
        Nothing here is computed twice. Every line is a conclusion another screen
        already reaches — the schedule's breaches, the capacity sheet's
        contradictions, the material shortages, the machines that are down — put
        in one place and sorted by how soon it bites. There is deliberately no
        way to dismiss one: an alert you can silence while it is still true stops
        being read.
      </p>
    </div>
  )
}

const TONE: Record<Finding['severity'], 'flag' | 'amber' | 'mid'> = {
  critical: 'flag',
  warning: 'amber',
  info: 'mid',
}

function FindingCard({ row }: { row: Finding }) {
  return (
    <div
      className="border-rule bg-sheet border p-3.5"
      data-testid={`finding-${row.kind}`}
      data-severity={row.severity}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{row.title}</div>
          <div className="text-mid mt-0.5 text-[12px]">{row.detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.days_out > 0 ? (
            <span className="text-faint text-[11.5px]">in {row.days_out}d</span>
          ) : null}
          <Tag tone={TONE[row.severity]}>{row.severity}</Tag>
        </div>
      </div>
      <Link
        to={row.route}
        className="text-blue mt-2 inline-block min-h-11 text-[12px] font-semibold hover:underline sm:min-h-0"
      >
        Go to the screen that fixes this →
      </Link>
    </div>
  )
}
