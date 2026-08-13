import { useEffect, useState } from 'react'
import {
  useDepartmentInbound,
  useDepartmentQueue,
  type InboundRow,
  type QueueRow,
} from '@/data/wip'
import { useDepartments } from '@/data/planning'
import { Empty, Panel, Tag } from '@/components/ui'
import { formatDateLong, formatNumber, inputClass } from '@/components/format'

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-none">
          <span className="text-faint text-[11px] tracking-wider uppercase">
            Department
          </span>
          <select
            className={`${inputClass} h-12 text-[15px] sm:h-auto sm:text-[13px]`}
            value={departmentCode ?? ''}
            onChange={(e) => setDepartmentCode(e.target.value)}
            data-testid="board-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
        </label>

        <p className="text-mid hidden max-w-[52ch] text-[12px] sm:block">
          Ordered by the container each job ships in, not by this department's
          own deadline. The container sails when it sails.
        </p>
      </div>

      <Panel
        title="Holding you up"
        meta={
          blocking.length ? `${blocking.length} to chase` : 'nothing to chase'
        }
      >
        <div data-testid="board-inbound">
          {inbound.data?.length === 0 ? (
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
            <p className="text-faint mt-3 text-[11.5px]">
              {notYetDue} more {notYetDue === 1 ? 'job is' : 'jobs are'} still
              to come from upstream, none of it due yet.
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="What you owe"
        meta={open.length ? `${open.length} still open` : 'all clear'}
      >
        <div data-testid="board-queue">
          {open.length === 0 ? (
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
    </div>
  )
}

function InboundCard({ row }: { row: InboundRow }) {
  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold">
            {row.from_department_name}
          </div>
          <div className="text-mid text-[12px]">
            for {row.erp_order_no} · {row.article_code}
          </div>
        </div>
        <Tag tone={row.state === 'part made' ? 'amber' : 'flag'}>
          {row.state}
        </Tag>
      </div>

      <div className="text-mid mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
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

      <div className="text-faint mt-1.5 text-[11.5px]">
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
          <div className="text-[14px] font-semibold">{row.erp_order_no}</div>
          <div className="text-mid text-[12px]">
            {row.article_code} · {row.customer_code}
          </div>
        </div>
        <div className="text-right">
          <div className="text-faint text-[10px] tracking-wider uppercase">
            Still to make
          </div>
          <div className="text-[19px] font-semibold">
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

      <div className="text-faint mt-1.5 text-[11.5px]">
        Yours by {formatDateLong(row.due_date)} · ships{' '}
        {formatDateLong(row.stuffing_date)}
      </div>
    </div>
  )
}
