import { Fragment, useEffect, useState } from 'react'
import {
  useAcceptProduction,
  useDeclareProduction,
  usePendingAcceptance,
  useProductionDays,
  useWorklist,
  type WorklistRow,
} from '@/data/wip'
import { useDepartments } from '@/data/planning'
import { Button, Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber, inputClass } from '@/components/format'

/**
 * The screen that replaces the daily production Google Sheet.
 *
 * Two jobs, in the order a supervisor does them: count in what arrived from the
 * bench before you, then write down what you made. Everything is scoped to one
 * department and one day, because that is the unit a person actually fills in.
 */
export function Production() {
  const departments = useDepartments()
  const [departmentCode, setDepartmentCode] = useState<string | null>(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))

  // First department in route order, once they load. A screen that opens on
  // nothing looks broken even when it is merely waiting.
  useEffect(() => {
    if (!departmentCode && departments.data?.length) {
      setDepartmentCode(departments.data[0].code)
    }
  }, [departments.data, departmentCode])

  const worklist = useWorklist(departmentCode, date)
  const pending = usePendingAcceptance(departmentCode)
  const days = useProductionDays(departmentCode)

  const rows = worklist.data ?? []
  const declared = rows.filter((r) => r.declaration_id).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-none">
          <span className="text-faint text-[11px] uppercase tracking-wider">
            Department
          </span>
          <select
            className={`${inputClass} h-12 text-[15px] sm:h-auto sm:text-[13px]`}
            value={departmentCode ?? ''}
            onChange={(e) => setDepartmentCode(e.target.value)}
            data-testid="production-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex shrink-0 flex-col gap-1">
          <span className="text-faint text-[11px] uppercase tracking-wider">
            Date
          </span>
          <input
            type="date"
            className={`${inputClass} h-12 text-[15px] sm:h-auto sm:text-[13px]`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="production-date"
          />
        </label>

        <p className="text-mid hidden max-w-[52ch] text-[12px] sm:block">
          Entering output does not move any dates. The plan stays where it is —
          it is what everyone is working to today.
        </p>
      </div>

      {pending.data?.length ? (
        <AcceptancePanel departmentCode={departmentCode!} rows={pending.data} />
      ) : null}

      <Panel
        title="What you were asked for"
        meta={
          rows.length
            ? `${declared} of ${rows.length} entered`
            : formatDateLong(date)
        }
      >
        {rows.length === 0 ? (
          <div data-testid="production-empty">
            <Empty>
              Nothing is planned for {departmentCode} on {formatDateLong(date)}.
            </Empty>
            {days.data?.length ? (
              <div className="mt-4">
                <p className="text-mid mb-2 text-[12px]">
                  Days this department is asked to work:
                </p>
                <div className="flex flex-wrap gap-2">
                  {days.data.slice(0, 12).map((d) => (
                    <button
                      key={d.work_date}
                      type="button"
                      onClick={() => setDate(d.work_date)}
                      className="border-rule hover:border-blue hover:text-blue rounded-[2px] border px-2.5 py-1 text-[11.5px]"
                      title={`${formatNumber(d.qty_planned)} planned across ${d.jobs} job${d.jobs === 1 ? '' : 's'}`}
                    >
                      {formatDateLong(d.work_date)}
                      {d.declared === d.jobs ? (
                        <span className="text-clear"> ·&nbsp;done</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
                The current schedule does not ask this department for anything at
                all. Either it has no component rates, or no open order passes
                through it.
              </p>
            )}
          </div>
        ) : (
          <div data-testid="production-worklist">
            <Table>
              <thead className="hidden sm:table-header-group">
                <tr>
                  <Th>Order</Th>
                  <Th>Component</Th>
                  <Th align="right">Planned</Th>
                  <Th align="right">Good</Th>
                  <Th align="right">Rejected</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <WorklistEntry
                    key={`${row.shipment_line_id}-${row.component_code}-${row.shift_code}`}
                    row={row}
                    date={date}
                  />
                ))}
              </tbody>
            </Table>
          </div>
        )}

        <p className="text-faint mt-3 hidden max-w-[80ch] text-[11.5px] sm:block">
          Good and rejected are counted separately rather than entered as a
          percentage. The two figures are things you can stand behind; the
          percentage is worked out from them, and is what the yield on Masters
          gets measured against.
        </p>
      </Panel>
    </div>
  )
}

function WorklistEntry({ row, date }: { row: WorklistRow; date: string }) {
  const declare = useDeclareProduction()
  const [good, setGood] = useState(String(row.qty_good))
  const [rejected, setRejected] = useState(String(row.qty_rejected))

  // Someone else's entry, or a correction made elsewhere, should show here.
  useEffect(() => {
    setGood(String(row.qty_good))
    setRejected(String(row.qty_rejected))
  }, [row.qty_good, row.qty_rejected])

  const dirty =
    good !== String(row.qty_good) || rejected !== String(row.qty_rejected)

  const save = () =>
    declare.mutate({
      shipmentLineId: row.shipment_line_id,
      departmentCode: row.department_code,
      componentCode: row.component_code,
      date,
      shiftCode: row.shift_code,
      good: Number(good) || 0,
      rejected: Number(rejected) || 0,
    })

  const status = dirty ? (
    <Button onClick={save} disabled={declare.isPending}>
      {declare.isPending ? 'Saving…' : 'Save'}
    </Button>
  ) : row.declaration_id ? (
    <Tag tone="clear">Entered</Tag>
  ) : (
    <span className="text-faint text-[11px]">Not yet entered</span>
  )

  return (
    <>
      {/* ---------------------------------------------------------------
          On a phone. The client's answer to "who enters production, and
          when" was: on a phone, on the floor, as it happens. A six-column
          table cannot do that — the Rejected field and the Save button sit
          off the right-hand edge, reachable only by a sideways scroll
          nobody knows is there.
          --------------------------------------------------------------- */}
      <tr className="sm:hidden">
        {/* A plain cell rather than <Td>: the card supplies its own frame, and
            the shared one's padding and rule would sit inside it. */}
        <td colSpan={6} className="pb-3">
          <div className="border-rule bg-sheet border p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[14px] font-semibold">
                  {row.erp_order_no}
                </div>
                <div className="text-mid text-[12px]">{row.article_code}</div>
              </div>
              <div className="text-right">
                <div className="text-faint text-[10px] tracking-wider uppercase">
                  Asked for
                </div>
                <div className="text-[17px] font-semibold">
                  {formatNumber(row.qty_planned)}
                </div>
              </div>
            </div>

            {row.breach_reason ? (
              <div className="mt-2">
                <Tag tone="flag">{row.breach_reason}</Tag>
              </div>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-faint text-[10px] tracking-wider uppercase">
                  Good
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step="any"
                  className={`${inputClass} h-12 w-full text-[17px]`}
                  value={good}
                  onChange={(e) => setGood(e.target.value)}
                  aria-label={`Good, ${row.erp_order_no} ${row.component_code}`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-faint text-[10px] tracking-wider uppercase">
                  Rejected
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step="any"
                  className={`${inputClass} h-12 w-full text-[17px]`}
                  value={rejected}
                  onChange={(e) => setRejected(e.target.value)}
                  aria-label={`Rejected, ${row.erp_order_no} ${row.component_code}`}
                />
              </label>
            </div>

            {/* Full width, and always in the card rather than appearing only
                once something is dirty — a button that materialises under
                your thumb moves everything below it. */}
            <button
              type="button"
              onClick={save}
              disabled={!dirty || declare.isPending}
              className="bg-ink disabled:bg-rule mt-3 h-12 w-full rounded-[2px] text-[15px] font-semibold text-white disabled:cursor-not-allowed"
            >
              {declare.isPending
                ? 'Saving…'
                : dirty
                  ? 'Save'
                  : row.declaration_id
                    ? 'Entered'
                    : 'Enter a figure'}
            </button>
          </div>
        </td>
      </tr>

      {/* On a desk, where the whole grid is worth seeing at once. */}
      <tr className="hidden sm:table-row">
        <Td>
          <span className="font-semibold">{row.erp_order_no}</span>
          <span className="text-faint"> · {row.article_code}</span>
          {row.breach_reason ? (
            <span className="ml-2">
              <Tag tone="flag">{row.breach_reason}</Tag>
            </span>
          ) : null}
        </Td>
        <Td>
          {row.component_code}
          <span className="text-faint"> · {row.shift_code}</span>
        </Td>
        <Td align="right">{formatNumber(row.qty_planned)}</Td>
        <Td align="right">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="any"
            className={`${inputClass} w-24 text-right`}
            value={good}
            onChange={(e) => setGood(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
            aria-label={`Good, ${row.erp_order_no} ${row.component_code}`}
          />
        </Td>
        <Td align="right">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="any"
            className={`${inputClass} w-24 text-right`}
            value={rejected}
            onChange={(e) => setRejected(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
            aria-label={`Rejected, ${row.erp_order_no} ${row.component_code}`}
          />
        </Td>
        <Td align="right">{status}</Td>
      </tr>
    </>
  )
}

/**
 * Rendered above the worklist because it is the first thing that happens in the
 * day, and because work sitting uncounted is the thing most worth chasing.
 */
function AcceptancePanel({
  departmentCode,
  rows,
}: {
  departmentCode: string
  rows: NonNullable<ReturnType<typeof usePendingAcceptance>['data']>
}) {
  const accept = useAcceptProduction()
  const [counts, setCounts] = useState<Record<string, string>>({})

  return (
    <Panel
      title="Handed to you, not yet counted in"
      meta={`${rows.length} waiting`}
    >
      <p className="text-mid mb-3 max-w-[80ch] text-[12px]">
        Count what actually arrived. If it does not match what they said, enter
        what you have — the difference is kept, not smoothed over.
      </p>

      <div data-testid="pending-acceptance">
        <Table>
          <thead className="hidden sm:table-header-group">
            <tr>
              <Th>From</Th>
              <Th>Order</Th>
              <Th>Component</Th>
              <Th align="right">They made</Th>
              <Th align="right">You received</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entered = counts[row.declaration_id]
              const value = entered ?? String(row.qty_declared)
              const short = Number(value) < row.qty_declared
              const countIn = () =>
                accept.mutate({
                  declarationId: row.declaration_id,
                  departmentCode,
                  qty: Number(value) || 0,
                })
              const onChange = (v: string) =>
                setCounts((c) => ({ ...c, [row.declaration_id]: v }))

              return (
                <Fragment key={row.declaration_id}>
                  {/* On a phone: one card, thumb-sized field, full-width
                      action. Counting in is the first thing that happens in a
                      shift and it happens standing up. */}
                  <tr className="sm:hidden">
                    <td colSpan={6} className="pb-3">
                      <div className="border-rule bg-sheet border p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[14px] font-semibold">
                              {row.erp_order_no}
                            </div>
                            <div className="text-mid text-[12px]">
                              from {row.from_department_name}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-faint text-[10px] tracking-wider uppercase">
                              They made
                            </div>
                            <div className="text-[17px] font-semibold">
                              {formatNumber(row.qty_declared)}
                            </div>
                          </div>
                        </div>

                        <label className="mt-3 flex flex-col gap-1">
                          <span className="text-faint text-[10px] tracking-wider uppercase">
                            You received
                          </span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step="any"
                            className={`${inputClass} h-12 w-full text-[17px]`}
                            value={value}
                            onChange={(e) => onChange(e.target.value)}
                            aria-label={`Received, ${row.erp_order_no} ${row.component_code}`}
                          />
                        </label>

                        {short ? (
                          <p
                            data-testid="shortfall"
                            className="text-amber mt-2 text-[12px] font-semibold"
                          >
                            {formatNumber(row.qty_declared - Number(value))}{' '}
                            short of what they declared
                          </p>
                        ) : null}

                        <button
                          type="button"
                          onClick={countIn}
                          disabled={accept.isPending}
                          className="bg-ink disabled:bg-rule mt-3 h-12 w-full rounded-[2px] text-[15px] font-semibold text-white disabled:cursor-not-allowed"
                        >
                          {accept.isPending ? 'Saving…' : 'Count in'}
                        </button>
                      </div>
                    </td>
                  </tr>

                <tr className="hidden sm:table-row">
                  <Td>
                    {row.from_department_name}
                    <span className="text-faint">
                      {' '}
                      · {formatDateLong(row.production_date)}
                    </span>
                  </Td>
                  <Td className="font-semibold">{row.erp_order_no}</Td>
                  <Td>{row.component_code}</Td>
                  <Td align="right">{formatNumber(row.qty_declared)}</Td>
                  <Td align="right">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      className={`${inputClass} w-24 text-right`}
                      value={value}
                      onChange={(e) =>
                        setCounts((c) => ({
                          ...c,
                          [row.declaration_id]: e.target.value,
                        }))
                      }
                      aria-label={`Received, ${row.erp_order_no} ${row.component_code}`}
                    />
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      {short ? (
                        <span data-testid="shortfall">
                          <Tag tone="amber">
                            {formatNumber(row.qty_declared - Number(value))} short
                          </Tag>
                        </span>
                      ) : null}
                      <Button
                        variant="quiet"
                        disabled={accept.isPending}
                        onClick={() =>
                          accept.mutate({
                            declarationId: row.declaration_id,
                            departmentCode,
                            qty: Number(value) || 0,
                          })
                        }
                      >
                        Count in
                      </Button>
                    </div>
                  </Td>
                </tr>
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      </div>

      {accept.isError ? (
        <p className="text-flag mt-3 max-w-[80ch] text-[11.5px]">
          {String(accept.error).includes('not fed by')
            ? 'This work was not handed to your department. Check What feeds what on Masters.'
            : String(accept.error)}
        </p>
      ) : null}
    </Panel>
  )
}
