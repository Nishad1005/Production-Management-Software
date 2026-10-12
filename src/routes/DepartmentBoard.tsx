import { useEffect, useState } from 'react'
import {
  useDepartmentInbound,
  useDepartmentQueue,
  useProductionVsPlan,
  type InboundRow,
  type QueueRow,
} from '@/data/wip'
import { useDepartments } from '@/data/planning'
import { Empty, Panel, Tag, Waiting } from '@/components/ui'
import { BarPairs } from '@/components/charts'
import { gridFromRows, workingDaysBack } from '@/lib/plan-vs-made'
import { stateOf, stateOfAll, waiting } from '@/lib/query-state'
import { formatDateLong, formatNumber, inputClass, todayIso } from '@/components/format'

/**
 * One department's board, specified by U&M in their own words: "what are the
 * pending remaining for that day, work order or according to their shipping
 * date, and from which department a component has to come so as to I can start
 * my work."
 *
 * Two questions, in the order a supervisor asks them. What am I waiting for —
 * because that decides whether today is even possible. Then what do I owe, and
 * by when.
 *
 * Built as cards throughout rather than tables. This is the screen most likely
 * to be read on a phone, standing up, and a card that reads the same on a desk
 * is a better trade than two layouts to keep in step.
 */
export function DepartmentBoard() {
  const departments = useDepartments()
  const [departmentCode, setDepartmentCode] = useState<string | null>(null)

  useEffect(() => {
    if (!departmentCode && departments.data?.length) {
      setDepartmentCode(departments.data[0].code)
    }
  }, [departments.data, departmentCode])

  const queue = useDepartmentQueue(departmentCode)
  const inbound = useDepartmentInbound(departmentCode)

  const open = (queue.data ?? []).filter((r) => r.qty_remaining > 0)

  // A feeder that has not started on work due in three months is not holding
  // anyone up — it is simply not due yet. Showing every one of those buries the
  // handful that are actually late under a wall of things nobody can act on.
  const outstanding = (inbound.data ?? []).filter((r) => r.state !== 'ready')
  const blocking = outstanding.filter(
    (r) => r.days_to_their_due !== null && r.days_to_their_due <= 7,
  )
  const notYetDue = outstanding.length - blocking.length

  // Until a department is chosen the two queries are not running at all,
  // which must read as loading rather than as "nothing is late".
  const state = !departmentCode ? 'loading' : stateOfAll(queue, inbound)

  // The department's own fortnight, planned against made, as bars. Read
  // from the same view the Dashboard uses and cut down to this department.
  const workingDays = workingDaysBack(todayIso(), 14)
  const fortnight = useProductionVsPlan(workingDays[0], todayIso())
  const fortnightState = !departmentCode ? 'loading' : stateOf(fortnight)
  const cells = departmentCode
    ? (gridFromRows(fortnight.data ?? [], workingDays).cells.get(departmentCode) ?? [])
    : []
  const anyDay = cells.some((c) => c.state !== 'none')
  const departmentName =
    departments.data?.find((d) => d.code === departmentCode)?.name ?? departmentCode ?? ''

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-none">
          <span className="text-faint text-caption tracking-wider uppercase">
            Department
          </span>
          <select
            className={`${inputClass} h-12 text-emphasis sm:h-auto sm:text-small`}
            value={departmentCode ?? ''}
            onChange={(e) => setDepartmentCode(e.target.value)}
            data-testid="board-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <p className="text-mid hidden max-w-[52ch] text-caption sm:block">
          Ordered by the container each job ships in, not by this department's
          own deadline. The container sails when it sails.
        </p>
      </div>

      <Panel
        title="Holding you up"
        meta={
          waiting(state)
            ? undefined
            : blocking.length
              ? `${blocking.length} to chase`
              : 'nothing to chase'
        }
      >
        <div data-testid="board-inbound" data-state={state}>
          {waiting(state) ? (
            <Waiting state={state} error={inbound.error} loading="Looking upstream…" />
          ) : inbound.data?.length === 0 ? (
            <Empty>
              Nothing feeds {departmentCode}. It starts on its own, so there is
              never anything to wait for.
            </Empty>
          ) : blocking.length === 0 ? (
            <Empty>
              Nothing is late into {departmentCode}. Anything still outstanding
              is not due yet.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {blocking.map((row) => (
                <InboundCard
                  key={`${row.shipment_line_id}-${row.from_department_code}`}
                  row={row}
                />
              ))}
            </div>
          )}

          {notYetDue > 0 ? (
            <p className="text-faint mt-3 text-caption">
              {notYetDue} more {notYetDue === 1 ? 'job is' : 'jobs are'} still
              to come from upstream, none of it due yet.
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="What you owe"
        meta={waiting(state) ? undefined : open.length ? `${open.length} still open` : 'all clear'}
      >
        <div data-testid="board-queue" data-state={state}>
          {waiting(state) ? (
            <Waiting state={state} error={queue.error} loading="Reading the plan…" />
          ) : open.length === 0 ? (
            <Empty>
              Nothing outstanding for {departmentCode} on the current plan.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {open.map((row) => (
                <QueueCard
                  key={`${row.shipment_line_id}-${row.component_code}`}
                  row={row}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="The last 14 days"
        meta={
          waiting(fortnightState)
            ? undefined
            : anyDay
              ? `${cells.filter((c) => c.state === 'met').length} of ${cells.filter((c) => c.planned > 0).length} planned days met`
              : 'nothing yet'
        }
      >
        <div data-testid="board-last-days" data-state={fortnightState}>
          {waiting(fortnightState) ? (
            <Waiting state={fortnightState} error={fortnight.error} loading="Reading the fortnight…" />
          ) : !anyDay ? (
            <Empty>
              Nothing was planned or declared for {departmentName} in the last 14 working days.
            </Empty>
          ) : (
            <>
              <BarPairs cells={cells} name={departmentName} code={departmentCode ?? ''} />
              <p className="text-faint mt-2 text-caption">
                Grey is what the plan asked for each day; the coloured bar beside it is what was
                declared — green when it met the plan, amber when it came close, red when it did
                not. Rejected pieces sit on top in pale amber.
              </p>
            </>
          )}
        </div>
      </Panel>
    </div>
  )
}

function InboundCard({ row }: { row: InboundRow }) {
  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-body font-semibold">
            {row.from_department_name}
          </div>
          <div className="text-mid text-caption">
            for {row.erp_order_no} · {row.article_code}
          </div>
        </div>
        <Tag tone={row.state === 'part made' ? 'amber' : 'flag'}>
          {row.state}
        </Tag>
      </div>

      <div className="text-mid mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-caption">
        <span>
          They owe <strong>{formatNumber(row.qty_required)}</strong>
        </span>
        <span>
          Made <strong>{formatNumber(row.qty_made)}</strong>
        </span>
        {/* Made and counted in are different problems with different people to
            talk to: one is a bench that is behind, the other is a handover that
            has not happened. */}
        <span>
          Reached you <strong>{formatNumber(row.qty_counted_in)}</strong>
        </span>
      </div>

      <div className="text-faint mt-1.5 text-caption">
        {row.days_to_their_due !== null && row.days_to_their_due < 0
          ? `${Math.abs(row.days_to_their_due)} days late — due ${formatDateLong(row.their_due_date)}`
          : `Due ${formatDateLong(row.their_due_date)}`}{' '}
        · container {formatDateLong(row.stuffing_date)}
      </div>
    </div>
  )
}

function QueueCard({ row }: { row: QueueRow }) {
  const late = row.days_to_stuffing < 0
  const soon = !late && row.days_to_stuffing <= 14

  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-body font-semibold">{row.erp_order_no}</div>
          <div className="text-mid text-caption">
            {row.article_code} · {row.customer_code}
          </div>
        </div>
        <div className="text-right">
          <div className="text-faint text-caption tracking-wider uppercase">
            Still to make
          </div>
          <div className="text-title font-semibold">
            {formatNumber(row.qty_remaining)}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Tag tone={late ? 'flag' : soon ? 'amber' : 'mid'}>
          {late
            ? `container sailed ${Math.abs(row.days_to_stuffing)}d ago`
            : `container in ${row.days_to_stuffing}d`}
        </Tag>
        {row.state === 'in progress' ? (
          <Tag tone="blue">
            {formatNumber(row.qty_done)} of {formatNumber(row.qty_required)} done
          </Tag>
        ) : null}
        {row.breach_reason ? (
          <Tag tone="flag">{row.breach_reason}</Tag>
        ) : null}
      </div>

      <div className="text-faint mt-1.5 text-caption">
        Yours by {formatDateLong(row.due_date)} · ships{' '}
        {formatDateLong(row.stuffing_date)}
      </div>
    </div>
  )
}
