import { useState } from 'react'
import {
  useWipByOrder,
  useWipLines,
  type WipLine,
  type WipRow,
} from '@/data/wip'
import { Empty, Panel, Tag } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'

/**
 * Where everything is.
 *
 * Deliberately holds no money. U&M asked to leave rupee value aside for now
 * because "the main thing we want to do is WIP" — and none of this needs it:
 * every figure here is a count of things made against things owed.
 */
export function Wip() {
  const lines = useWipLines()
  const detail = useWipByOrder()
  const [open, setOpen] = useState<string | null>(null)

  const all = lines.data ?? []
  const running = all.filter((l) => l.started && !l.complete)
  const ready = all.filter((l) => l.complete)
  const waiting = all.filter((l) => !l.started)

  return (
    <div className="space-y-6">
      <Panel
        title="In progress"
        meta={
          running.length
            ? `${formatNumber(running.reduce((n, l) => n + l.line_qty, 0))} units across ${running.length}`
            : 'nothing started'
        }
      >
        <div data-testid="wip-running">
          {running.length === 0 ? (
            <Empty>
              Nothing has been started and left unfinished. {waiting.length}{' '}
              {waiting.length === 1 ? 'line is' : 'lines are'} still to begin.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {running.map((line) => (
                <LineCard
                  key={line.shipment_line_id}
                  line={line}
                  rows={detail.data ?? []}
                  open={open === line.shipment_line_id}
                  onToggle={() =>
                    setOpen(
                      open === line.shipment_line_id
                        ? null
                        : line.shipment_line_id,
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Ready to stuff"
        meta={ready.length ? `${ready.length} complete` : 'none yet'}
      >
        <div data-testid="wip-ready">
          {ready.length === 0 ? (
            <Empty>
              No shipment line has been through every department yet.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {ready.map((line) => (
                <LineCard
                  key={line.shipment_line_id}
                  line={line}
                  rows={detail.data ?? []}
                  open={open === line.shipment_line_id}
                  onToggle={() =>
                    setOpen(
                      open === line.shipment_line_id
                        ? null
                        : line.shipment_line_id,
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <p className="text-faint max-w-[80ch] text-[11.5px]">
        Counted, not valued. Every figure here is what was declared against what
        the plan asked for; rupee value needs a cost per article and is not in
        yet.
      </p>
    </div>
  )
}

function LineCard({
  line,
  rows,
  open,
  onToggle,
}: {
  line: WipLine
  rows: WipRow[]
  open: boolean
  onToggle: () => void
}) {
  const late = line.days_to_stuffing < 0
  const soon = !late && line.days_to_stuffing <= 14
  const route = rows
    .filter((r) => r.shipment_line_id === line.shipment_line_id)
    .sort((a, b) => a.route_position - b.route_position)

  return (
    <div className="border-rule bg-sheet border">
      <button
        type="button"
        onClick={onToggle}
        className="block w-full p-3.5 text-left"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold">
              {line.erp_order_no}
              {line.line_no > 1 ? (
                <span className="text-faint"> · line {line.line_no}</span>
              ) : null}
            </div>
            <div className="text-mid text-[12px]">
              {line.article_code} · {line.customer_code} ·{' '}
              {formatNumber(line.line_qty)} units
            </div>
          </div>
          <div className="text-right">
            <div className="text-faint text-[10px] tracking-wider uppercase">
              Through the route
            </div>
            <div className="text-[19px] font-semibold">
              {Math.round(line.fraction_done * 100)}%
            </div>
          </div>
        </div>

        {/* One segment per department, in route order. The shape of the strip
            says where the work has got to faster than any number does. */}
        <div className="mt-3 flex gap-0.5">
          {route.map((r) => (
            <span
              key={r.department_code}
              title={`${r.department_name}: ${formatNumber(r.qty_good)} of ${formatNumber(r.qty_required)}`}
              className={`h-2 flex-1 ${
                r.state === 'complete'
                  ? 'bg-clear'
                  : r.state === 'in progress'
                    ? 'bg-amber'
                    : 'bg-rule'
              }`}
            />
          ))}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Tag tone={late ? 'flag' : soon ? 'amber' : 'mid'}>
            {late
              ? `container sailed ${Math.abs(line.days_to_stuffing)}d ago`
              : `container in ${line.days_to_stuffing}d`}
          </Tag>
          <Tag tone="mid">
            {line.departments_done} of {line.departments} departments
          </Tag>
          {line.last_declared ? (
            <span className="text-faint text-[11.5px]">
              last entry {formatDateLong(line.last_declared)}
            </span>
          ) : null}
        </div>
      </button>

      {open ? (
        <div className="border-rule-soft border-t px-3.5 pt-2.5 pb-3.5">
          {route.map((r) => (
            <div
              key={r.department_code}
              className="border-rule-soft flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0"
            >
              <span className="text-[12.5px] font-semibold">
                {r.department_name}
              </span>
              <span className="text-mid text-[12px]">
                {formatNumber(r.qty_good)} of {formatNumber(r.qty_required)}
                {r.qty_rejected > 0 ? (
                  <span className="text-amber">
                    {' '}
                    · {formatNumber(r.qty_rejected)} rejected
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
