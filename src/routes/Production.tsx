import { useEffect, useState } from 'react'
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
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-faint text-[11px] uppercase tracking-wider">
            Department
          </span>
          <select
            className={inputClass}
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

        <label className="flex flex-col gap-1">
          <span className="text-faint text-[11px] uppercase tracking-wider">
            Date
          </span>
          <input
            type="date"
            className={inputClass}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="production-date"
          />
        </label>

        <p className="text-mid max-w-[52ch] text-[12px]">
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
              <thead>
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

        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
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

  return (
    <tr>
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
        {dirty ? (
          <Button variant="quiet" onClick={save} disabled={declare.isPending}>
            {declare.isPending ? 'Saving…' : 'Save'}
          </Button>
        ) : row.declaration_id ? (
          <Tag tone="clear">Entered</Tag>
        ) : (
          <span className="text-faint text-[11px]">Not yet entered</span>
        )}
      </Td>
    </tr>
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
        The department before you has said what it made. Count what actually
        arrived. If the two disagree, enter what you have — the difference is
        kept rather than smoothed over, and that is the whole point of counting.
      </p>

      <div data-testid="pending-acceptance">
        <Table>
          <thead>
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
              return (
                <tr key={row.declaration_id}>
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
                        <Tag tone="amber">
                          {formatNumber(row.qty_declared - Number(value))} short
                        </Tag>
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
