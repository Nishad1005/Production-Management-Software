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

  /*
   * Loading, failed and empty are three different things.
   *
   * This screen read `attention.data ?? []` and rendered, on a factory with a
   * hundred and seven findings in it, "Nothing the software can see needs
   * deciding today — every check below has run." It had not run; it was still
   * in flight. The header badge, which is a separate and faster query, said 72
   * at the same moment on the same page.
   *
   * A sentence that asserts the checks have run must only appear once they
   * have. The panels below therefore never claim quiet until the query has
   * actually come back.
   */
  const state: 'loading' | 'failed' | 'ready' = attention.isPending
    ? 'loading'
    : attention.isError
      ? 'failed'
      : 'ready'

  const critical = rows.filter((r) => r.severity === 'critical')
  const warning = rows.filter((r) => r.severity === 'warning')
  const info = rows.filter((r) => r.severity === 'info')

  return (
    <div className="space-y-6">
      <Panel
        title="Needs an answer today"
        meta={
          state !== 'ready'
            ? undefined
            : critical.length
              ? `${critical.length} critical`
              : 'nothing critical'
        }
      >
        <div
          data-testid="attention-critical"
          data-count={critical.length}
          data-state={state}
        >
          {state !== 'ready' ? (
            <Waiting state={state} error={attention.error} />
          ) : critical.length === 0 ? (
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
        meta={
          state !== 'ready'
            ? undefined
            : warning.length
              ? `${warning.length} warnings`
              : 'nothing'
        }
      >
        <div
          data-testid="attention-warning"
          data-count={warning.length}
          data-state={state}
        >
          {state !== 'ready' ? (
            <Waiting state={state} error={attention.error} />
          ) : warning.length === 0 ? (
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

      <p className="text-faint max-w-[85ch] text-caption">
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

/* The severity, carried as a left accent as well as a chip — so a list of
   findings has a readable shape before any of it is read. */
const ACCENT: Record<Finding['severity'], string> = {
  critical: 'border-l-flag',
  warning: 'border-l-amber',
  info: 'border-l-rule',
}

function FindingCard({ row }: { row: Finding }) {
  return (
    <div
      className={`border-rule bg-sheet rounded-card shadow-card border border-l-[3px] p-4 ${ACCENT[row.severity]}`}
      data-testid={`finding-${row.kind}`}
      data-severity={row.severity}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-body font-semibold">{row.title}</div>
          <div className="text-mid text-small mt-1">{row.detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.days_out > 0 ? (
            <span className="text-faint text-caption">in {row.days_out}d</span>
          ) : null}
          <Tag tone={TONE[row.severity]}>{row.severity}</Tag>
        </div>
      </div>
      <Link
        to={row.route}
        className="text-blue text-small mt-2.5 inline-block min-h-11 font-semibold hover:underline sm:min-h-0"
      >
        Go to the screen that fixes this →
      </Link>
    </div>
  )
}

/**
 * What to say before the answer is known.
 *
 * Deliberately not a spinner that fades into an empty list: on this screen the
 * difference between "checked, nothing wrong" and "not checked yet" is the
 * whole point, so both are stated in words.
 */
function Waiting({ state, error }: { state: 'loading' | 'failed'; error: unknown }) {
  if (state === 'loading') {
    return <Empty>Running every check…</Empty>
  }
  return (
    <div className="border-flag bg-sheet border-l-2 p-3.5 text-small">
      <div className="text-flag font-semibold">The checks did not run.</div>
      <div className="text-mid mt-1">
        Nothing here is a statement about the factory — it is a statement about
        this screen. {String(error)}
      </div>
    </div>
  )
}
