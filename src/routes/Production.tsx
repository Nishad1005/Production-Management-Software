import { Fragment, useEffect, useState, useMemo } from 'react'
import {
  useAcceptProduction,
  useAttributeDefect,
  useDeclareProduction,
  useDepartmentDay,
  usePendingAcceptance,
  useProductionDays,
  useSetAttendance,
  useSetDayCapacity,
  useWorklist,
  type DepartmentDay,
  type WorklistRow,
} from '@/data/wip'
import { useDepartments } from '@/data/planning'
import { Button, Empty, Panel, Table, Tag, Td, Th, Waiting } from '@/components/ui'
import { stateOf, waiting } from '@/lib/query-state'
import { componentLabel, useDepartmentNames } from '@/components/names'
import { useDefectTypes, useDefectsFor } from '@/data/quality'
import { formatDateLong, formatNumber, inputClass, todayIso } from '@/components/format'

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
  const [date, setDate] = useState(todayIso)

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
  // The header in pieces once anything is in: "made 19 of 19 planned" is the
  // end-of-day sentence a department head wants, and entries are not pieces.
  const plannedToday = rows.reduce((n, r) => n + r.qty_planned, 0)
  const madeToday = rows.reduce((n, r) => n + (r.declaration_id ? r.qty_good : 0), 0)
  // Before a department is chosen the worklist is not running, which must
  // read as loading rather than as "nothing is planned".
  const worklistState = !departmentCode ? 'loading' : stateOf(worklist)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-none">
          <span className="text-faint text-caption uppercase tracking-wider">
            Department
          </span>
          <select
            className={`${inputClass} h-12 text-emphasis sm:h-auto sm:text-small`}
            value={departmentCode ?? ''}
            onChange={(e) => setDepartmentCode(e.target.value)}
            data-testid="production-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex shrink-0 flex-col gap-1">
          <span className="text-faint text-caption uppercase tracking-wider">
            Date
          </span>
          <input
            type="date"
            className={`${inputClass} h-12 text-emphasis sm:h-auto sm:text-small`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="production-date"
          />
        </label>

        <p className="text-mid hidden max-w-[52ch] text-caption sm:block">
          Entering output does not move any dates today — the plan is what
          everyone is working to. The next run plans only what remains.
        </p>
      </div>

      {departmentCode ? (
        <TodaysCapacity departmentCode={departmentCode} date={date} />
      ) : null}

      {pending.data?.length ? (
        <AcceptancePanel departmentCode={departmentCode!} rows={pending.data} />
      ) : null}

      <Panel
        title="What you were asked for"
        meta={
          waiting(worklistState)
            ? undefined
            : rows.length
              ? declared
                ? `made ${formatNumber(madeToday)} of ${formatNumber(plannedToday)} planned · ${declared} of ${rows.length} entered`
                : `${declared} of ${rows.length} entered`
              : formatDateLong(date)
        }
      >
        {waiting(worklistState) ? (
          <div data-testid="production-waiting" data-state={worklistState}>
            <Waiting state={worklistState} error={worklist.error} loading="Reading the day's plan…" />
          </div>
        ) : rows.length === 0 ? (
          <div data-testid="production-empty" data-state={worklistState}>
            <Empty>
              Nothing is planned for {departmentCode} on {formatDateLong(date)}.
            </Empty>
            {days.isPending ? (
              <Waiting state="loading" loading="Looking for other days…" />
            ) : days.data?.length ? (
              <div className="mt-4">
                <p className="text-mid mb-2 text-caption">
                  Days this department is asked to work:
                </p>
                <div className="flex flex-wrap gap-2">
                  {days.data.slice(0, 12).map((d) => (
                    <button
                      key={d.work_date}
                      type="button"
                      onClick={() => setDate(d.work_date)}
                      className="border-rule hover:border-blue hover:text-blue min-h-11 rounded-[2px] border px-3 py-1 text-small sm:min-h-0 sm:px-2.5 sm:text-caption"
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
              <p className="text-faint mt-3 max-w-[80ch] text-caption">
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

        <p className="text-faint mt-3 hidden max-w-[80ch] text-caption sm:block">
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
  const names = useDepartmentNames()
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
    <span className="text-faint text-caption">Not yet entered</span>
  )
  // A save that did not take must say so: a figure typed and refused with
  // nothing on screen looks exactly like a figure saved (found 15 Oct).
  const failed = declare.isError ? (
    <p className="text-flag mt-1 text-caption" data-testid="declare-error">
      Not saved: {String(declare.error).replace(/^(\w*error:\s*)+/i, '')}
    </p>
  ) : null

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
                <div className="text-body font-semibold">
                  {row.erp_order_no}
                </div>
                <div className="text-mid text-caption">{row.article_code}</div>
              </div>
              <div className="text-right">
                <div className="text-faint text-caption tracking-wider uppercase">
                  Asked for
                </div>
                <div className="text-emphasis font-semibold">
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
                <span className="text-faint text-caption tracking-wider uppercase">
                  Good
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step="any"
                  className={`${inputClass} h-12 w-full text-emphasis`}
                  value={good}
                  onChange={(e) => setGood(e.target.value)}
                  aria-label={`Good, ${row.erp_order_no} ${row.component_code}`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-faint text-caption tracking-wider uppercase">
                  Rejected
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step="any"
                  className={`${inputClass} h-12 w-full text-emphasis`}
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
              className="bg-ink disabled:bg-rule mt-3 h-12 w-full rounded-[2px] text-emphasis font-semibold text-white disabled:cursor-not-allowed"
            >
              {declare.isPending
                ? 'Saving…'
                : dirty
                  ? 'Save'
                  : row.declaration_id
                    ? 'Entered'
                    : 'Enter a figure'}
            </button>
            {failed}
            {row.declaration_id && row.qty_rejected > 0 ? (
              <div className="mt-3">
                <WhyRejected row={row} date={date} />
              </div>
            ) : null}
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
        <Td title={row.component_code}>
          {componentLabel(row.component_code, names)}
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
        <Td align="right">
          {status}
          {failed}
        </Td>
      </tr>
      {row.declaration_id && row.qty_rejected > 0 ? (
        <tr className="hidden sm:table-row">
          <td colSpan={6} className="border-rule-soft border-b px-3 pt-1 pb-3">
            <WhyRejected row={row} date={date} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

/**
 * Why rejected.
 *
 * Rejections have been counted since production entry existed; the cause had
 * a function (attribute_defect, 17 Aug) and no screen, so the Quality Pareto
 * could only be fed from a test. It lives here, under the rejected figure,
 * because the HOD who counted the rejects is the one who knows why. Several
 * causes may share a day's rejects; the function refuses to account for more
 * than were rejected, which is arithmetic rather than a judgement, and
 * nobody is required to explain every one — the unexplained balance shows
 * on Quality at its real size.
 */
function WhyRejected({ row, date }: { row: WorklistRow; date: string }) {
  const types = useDefectTypes()
  const defects = useDefectsFor(row.department_code, date)
  const attribute = useAttributeDefect()
  const [code, setCode] = useState('')
  const [qty, setQty] = useState('')

  const mine = (defects.data ?? []).filter(
    (d) => d.erp_order_no === row.erp_order_no && d.component_code === row.component_code,
  )
  const accounted = mine.reduce((sum, d) => sum + d.qty, 0)
  const options = (types.data ?? []).filter((t) => t.is_active)
  const base = {
    shipmentLineId: row.shipment_line_id,
    departmentCode: row.department_code,
    componentCode: row.component_code,
    date,
    shiftCode: row.shift_code,
  }
  const key = `${row.erp_order_no} ${row.component_code}`
  const canAdd = Boolean(code) && Number(qty) > 0 && !attribute.isPending

  const add = () =>
    attribute.mutate(
      { ...base, defectCode: code, qty: Number(qty) },
      {
        onSuccess: () => {
          setCode('')
          setQty('')
        },
      },
    )

  return (
    <div
      data-testid={`why-rejected-${row.erp_order_no}-${row.component_code}`}
      data-accounted={accounted}
      className="text-caption"
    >
      <span className="text-faint tracking-wider uppercase">Why rejected</span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {mine.map((d) => (
          <span key={d.defect_code} className="inline-flex items-center gap-1">
            <Tag tone="mid">
              {d.defect_name} × {formatNumber(d.qty)}
            </Tag>
            <button
              type="button"
              className="text-faint hover:text-flag min-h-11 px-1 sm:min-h-0"
              title="Remove this cause"
              onClick={() => attribute.mutate({ ...base, defectCode: d.defect_code, qty: null })}
            >
              ×
            </button>
          </span>
        ))}
        <select
          className={`${inputClass} h-12 w-48 sm:h-auto`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label={`Cause, ${key}`}
        >
          <option value="">Cause…</option>
          {options.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step="any"
          className={`${inputClass} h-12 w-20 text-right sm:h-auto`}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canAdd && add()}
          placeholder={String(Math.max(0, row.qty_rejected - accounted))}
          aria-label={`How many, ${key}`}
        />
        <Button
          variant="quiet"
          onClick={add}
          disabled={!canAdd}
          testId={`defect-add-${row.erp_order_no}-${row.component_code}`}
        >
          Add
        </Button>
        <span className="text-faint">
          {formatNumber(accounted)} of {formatNumber(row.qty_rejected)} put down to a cause
        </span>
      </div>
      {attribute.isError ? (
        <p className="text-flag mt-1" data-testid="why-rejected-error">
          {String(attribute.error).replace(/^(\w*error:\s*)+/i, '')}
        </p>
      ) : null}
    </div>
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
  const names = useDepartmentNames()
  const accept = useAcceptProduction()
  const [counts, setCounts] = useState<Record<string, string>>({})

  return (
    <Panel
      title="Handed to you, not yet counted in"
      meta={`${rows.length} waiting`}
    >
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
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
                            <div className="text-body font-semibold">
                              {row.erp_order_no}
                            </div>
                            <div className="text-mid text-caption">
                              from {row.from_department_name}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-faint text-caption tracking-wider uppercase">
                              They made
                            </div>
                            <div className="text-emphasis font-semibold">
                              {formatNumber(row.qty_declared)}
                            </div>
                          </div>
                        </div>

                        <label className="mt-3 flex flex-col gap-1">
                          <span className="text-faint text-caption tracking-wider uppercase">
                            You received
                          </span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step="any"
                            className={`${inputClass} h-12 w-full text-emphasis`}
                            value={value}
                            onChange={(e) => onChange(e.target.value)}
                            aria-label={`Received, ${row.erp_order_no} ${row.component_code}`}
                          />
                        </label>

                        {short ? (
                          <p
                            data-testid="shortfall"
                            className="text-amber mt-2 text-caption font-semibold"
                          >
                            {formatNumber(row.qty_declared - Number(value))}{' '}
                            short of what they declared
                          </p>
                        ) : null}

                        <button
                          type="button"
                          onClick={countIn}
                          disabled={accept.isPending}
                          className="bg-ink disabled:bg-rule mt-3 h-12 w-full rounded-[2px] text-emphasis font-semibold text-white disabled:cursor-not-allowed"
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
                  <Td className="text-mid" title={row.component_code}>{componentLabel(row.component_code, names)}</Td>
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
        <p className="text-flag mt-3 max-w-[80ch] text-caption">
          {String(accept.error).includes('not fed by')
            ? 'This work was not handed to your department. Check What feeds what on Masters.'
            : String(accept.error)}
        </p>
      ) : null}
    </Panel>
  )
}

/**
 * What this department can do today, and why.
 *
 * The rate on the capacity sheet is what the department makes in a day with the
 * crew that rate was measured on. Two things move it, and U&M named both: how
 * many people came in, and someone looking at the day and saying otherwise.
 * The second beats the first — a person who saw the day beats a ratio.
 */
function TodaysCapacity({
  departmentCode,
  date,
}: {
  departmentCode: string
  date: string
}) {
  const day = useDepartmentDay(departmentCode)
  // One row per shift, for the date on the screen. The view has a row per
  // date anything was entered on; rendering them all showed day 1's crew
  // beside day 3's under one heading (found by the demo week, 15 Oct). A
  // shift with nothing entered for this date gets its standing figures with
  // nothing said, so the boxes are there to type into.
  const rows = useMemo(() => {
    const all = day.data ?? []
    const byShift = new Map<string, DepartmentDay>()
    for (const r of all) if (r.attendance_date === date) byShift.set(r.shift_code, r)
    for (const r of all) {
      if (byShift.has(r.shift_code)) continue
      byShift.set(r.shift_code, {
        ...r,
        present: null,
        attendance_note: null,
        attendance_date: null,
        attendance_fraction: null,
        ot_person_hours: null,
        ot_fraction: null,
        ot_over_limit: null,
        man_hours: null,
        override_units: null,
        override_reason: null,
      })
    }
    return [...byShift.values()]
  }, [day.data, date])

  return (
    <Panel title="What you can do today" meta={formatDateLong(date)}>
      <div data-testid="todays-capacity" className="space-y-4">
        {rows.map((row) => (
          <ShiftCapacity
            key={row.shift_code}
            row={row}
            departmentCode={departmentCode}
            date={date}
          />
        ))}
      </div>

      <p className="text-faint mt-3 hidden max-w-[80ch] text-caption sm:block">
        The standing rate assumes the crew it was measured with. Entering who
        came in moves the day in proportion; entering a figure overrides it
        outright, and needs a reason because someone will ask in six weeks.
        Either one re-runs the plan.
      </p>
    </Panel>
  )
}

function ShiftCapacity({
  row,
  departmentCode,
  date,
}: {
  row: DepartmentDay
  departmentCode: string
  date: string
}) {
  const setAttendance = useSetAttendance()
  const setDayCapacity = useSetDayCapacity()

  const [present, setPresent] = useState(
    row.present === null ? '' : String(row.present),
  )
  const [ot, setOt] = useState(row.ot_person_hours ? String(row.ot_person_hours) : '')
  const [units, setUnits] = useState(
    row.override_units === null ? '' : String(row.override_units),
  )
  const [reason, setReason] = useState(row.override_reason ?? '')

  useEffect(() => {
    setPresent(row.present === null ? '' : String(row.present))
    setOt(row.ot_person_hours ? String(row.ot_person_hours) : '')
    setUnits(row.override_units === null ? '' : String(row.override_units))
    setReason(row.override_reason ?? '')
  }, [row.present, row.ot_person_hours, row.override_units, row.override_reason])

  // Who came in and the overtime hours are one entry: a blank overtime box is
  // no overtime, not "keep what was there".
  const saveAttendance = () =>
    setAttendance.mutate({
      departmentCode,
      shiftCode: row.shift_code,
      date,
      present: present === '' ? null : Number(present),
      otPersonHours: ot === '' ? 0 : Number(ot),
    })

  const saveOverride = () =>
    setDayCapacity.mutate({
      departmentCode,
      shiftCode: row.shift_code,
      date,
      units: units === '' ? null : Number(units),
      reason: reason.trim() || null,
    })

  // A rate with no crew size against it cannot be scaled, so saying who came in
  // would change nothing. Better to say so than to let someone type into a
  // field that does not do anything.
  const scalable = row.rates_with_crew > 0
  const partial = scalable && row.rates_with_crew < row.rates

  return (
    <div className="border-rule border p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-small font-semibold">
          Shift {row.shift_code}
        </span>
        <span className="text-faint text-caption">
          {row.sanctioned} on the books
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[130px_150px_auto_1fr]">
        <label className="flex flex-col gap-1">
          <span className="text-faint text-caption tracking-wider uppercase">
            Who came in
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="1"
            disabled={!scalable}
            placeholder={String(row.sanctioned)}
            className={`${inputClass} h-12 text-emphasis disabled:opacity-50 sm:h-auto sm:text-small`}
            value={present}
            onChange={(e) => setPresent(e.target.value)}
            aria-label={`People present, shift ${row.shift_code}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-faint text-caption tracking-wider uppercase">
            Overtime hours, all people
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            disabled={!scalable}
            placeholder="0"
            className={`${inputClass} h-12 text-emphasis disabled:opacity-50 sm:h-auto sm:text-small`}
            value={ot}
            onChange={(e) => setOt(e.target.value)}
            aria-label={`Overtime hours, shift ${row.shift_code}`}
          />
        </label>
        <button
          type="button"
          onClick={saveAttendance}
          disabled={!scalable || setAttendance.isPending}
          data-testid={`crew-save-${row.shift_code}`}
          className="border-rule hover:border-blue hover:text-blue h-12 shrink-0 self-end rounded-[2px] border px-3 text-small font-semibold disabled:opacity-40 sm:h-auto sm:py-2"
        >
          {setAttendance.isPending ? '…' : 'Save'}
        </button>

        <div className="text-caption sm:self-end" data-testid={`crew-day-${row.shift_code}`}>
          {!scalable ? (
            <p className="text-amber">
              No crew size recorded against this department's rates, so who came
              in cannot change the day. Enter the manpower figures on the
              capacity sheet, or override the units below.
            </p>
          ) : row.present === null ? (
            <p className="text-mid">
              Nobody has said. The plan is using the standing rate.
            </p>
          ) : (
            <p className="text-mid">
              <strong>{row.present}</strong> of {row.sanctioned} in
              {row.attendance_fraction !== null ? (
                <> — the day is running at {Math.round(row.attendance_fraction * 100)}% of the rate</>
              ) : null}
              {row.ot_person_hours ? (
                <>
                  {' '}· <strong>{formatNumber(row.ot_person_hours, 1)}</strong> overtime hours
                  {row.ot_fraction !== null ? <> add {Math.round(row.ot_fraction * 100)}%</> : null}
                </>
              ) : null}
              {row.man_hours !== null ? <> · {formatNumber(row.man_hours, 0)} man-hours</> : null}
              .{' '}
              {row.ot_over_limit ? (
                <span className="text-amber">
                  More than the shift allows ({formatNumber(row.max_ot_hours, 1)} h a person);
                  the plan counts the maximum.{' '}
                </span>
              ) : null}
              {partial ? (
                <span className="text-amber">
                  {row.rates - row.rates_with_crew} of {row.rates} rates have no
                  crew size and are unaffected.
                </span>
              ) : null}
            </p>
          )}
        </div>
      </div>

      <details className="mt-3" open={row.override_units !== null}>
        <summary className="text-blue cursor-pointer text-caption font-semibold">
          Override the figure instead
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-[140px_1fr_auto]">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="any"
            placeholder="Units"
            className={`${inputClass} h-12 text-emphasis sm:h-auto sm:text-small`}
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            aria-label={`Units for the day, shift ${row.shift_code}`}
          />
          <input
            type="text"
            placeholder="Why — a machine down, new operators, a difficult fabric"
            className={`${inputClass} h-12 text-emphasis sm:h-auto sm:text-small`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label={`Reason, shift ${row.shift_code}`}
          />
          <button
            type="button"
            onClick={saveOverride}
            disabled={setDayCapacity.isPending}
            className="bg-ink h-12 rounded-[2px] px-4 text-small font-semibold text-white disabled:opacity-40 sm:h-auto sm:py-2"
          >
            {setDayCapacity.isPending ? 'Saving…' : 'Apply'}
          </button>
        </div>
        {setDayCapacity.isError ? (
          <p className="text-flag mt-2 text-caption">
            {String(setDayCapacity.error).includes('needs a reason')
              ? 'An override needs a reason — somebody will ask in six weeks.'
              : String(setDayCapacity.error)}
          </p>
        ) : null}
      </details>
    </div>
  )
}
