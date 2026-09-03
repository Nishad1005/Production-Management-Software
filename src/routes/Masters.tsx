import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useBom,
  useDepartmentShiftGrid,
  useDepartments,
  useDminus,
  useRates,
  useRouteGraph,
  useShifts,
} from '@/data/planning'
import {
  useAddHoliday,
  useArticleMaster,
  useCreateDepartment,
  useDeleteHoliday,
  useHolidays,
  useClearMachineDowntime,
  useMachineDowntime,
  useMachines,
  useMachineStatus,
  useSetArticle,
  useSetArticleActive,
  useSetMachine,
  useSetMachineActive,
  useSetMachineDowntime,
  useSetDependency,
  useSetDepartmentActive,
  useSetDminus,
  useSetDepartmentShift,
  useSetHeadcount,
  useSetRate,
  useSetShiftActive,
  useUpdateDepartment,
  useUpdateShift,
} from '@/data/mutations'
import { Button, Empty, Field, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber, inputClass, todayIso } from '@/components/format'
import { rpc } from '@/lib/backend'
import {
  downloadMasters,
  exportMasters,
  importMasters,
  readJsonFile,
} from '@/lib/masters-io'
import { downloadBackup, exportBackup, summarise } from '@/lib/backup-io'
import {
  EditableNumber,
  EditableText,
  Modal,
  ModalActions,
} from '@/components/edit'

/**
 * The numbers every schedule run depends on. Editing any of them re-runs the
 * schedule, so the effect of a change is visible on the next screen rather than
 * waiting for someone to remember to recompute.
 */
export function Masters() {
  const departments = useDepartments()
  const rates = useRates()
  const dminus = useDminus()
  const bom = useBom()
  const holidays = useHolidays()

  const setDminus = useSetDminus()
  const setRate = useSetRate()
  const updateDepartment = useUpdateDepartment()
  const setActive = useSetDepartmentActive()
  const addHoliday = useAddHoliday()
  const deleteHoliday = useDeleteHoliday()

  const [addingDepartment, setAddingDepartment] = useState(false)
  const [addingHoliday, setAddingHoliday] = useState(false)

  const articles = [...new Set(dminus.data?.map((d) => d.article_code) ?? [])]
  const routeCodes = [
    ...new Map(
      (dminus.data ?? []).map((d) => [d.department_code, d.route_position]),
    ),
  ]
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code)

  const incomplete = dminus.data?.filter((d) => !d.is_complete).length ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="text-mid max-w-[70ch] text-caption">
          Underlined figures are editable — click one, type, press Enter. Every
          change re-runs the schedule.
        </p>
        <MastersFileControls />
      </div>

      <Panel
        title="Production route"
        meta={`${departments.data?.length ?? 0} departments`}
      >
        <p className="text-mid mb-3 max-w-[80ch] text-caption">
          Departments are a configurable master, not hardcoded. The number on the
          left is only the order they are listed in — what has to finish before
          what is the next panel down, and that is the one the engine reads.
        </p>
        <Table>
          <thead>
            <tr>
              <Th align="right">#</Th>
              <Th>Code</Th>
              <Th>Department</Th>
              <Th align="right">Yield</Th>
              <Th>Shifts running</Th>
              <Th align="right">Total headcount</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {departments.data?.map((d) => (
              <tr key={d.id}>
                <Td align="right">
                  <EditableNumber
                    value={d.route_position}
                    min={1}
                    step={1}
                    width="w-16"
                    onCommit={(routePosition) =>
                      routePosition !== null &&
                      updateDepartment.mutate({ id: d.id, routePosition })
                    }
                  />
                </Td>
                <Td className="font-semibold">{d.code}</Td>
                <Td>
                  <EditableText
                    value={d.name}
                    onCommit={(name) =>
                      updateDepartment.mutate({ id: d.id, name })
                    }
                  />
                </Td>
                <Td align="right">
                  <EditableNumber
                    value={d.yield_pct}
                    suffix="%"
                    min={1}
                    max={100}
                    onCommit={(yieldPct) =>
                      yieldPct !== null &&
                      updateDepartment.mutate({ id: d.id, yieldPct })
                    }
                  />
                </Td>
                <Td>{d.shifts ?? <span className="text-flag">none</span>}</Td>
                <Td align="right">{formatNumber(d.headcount)}</Td>
                <Td align="right">
                  <button
                    type="button"
                    className="text-faint hover:text-flag text-caption"
                    onClick={() =>
                      setActive.mutate({ id: d.id, isActive: false })
                    }
                    title="Switch off — history is kept"
                  >
                    Deactivate
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="quiet" onClick={() => setAddingDepartment(true)}>
            Add a department
          </Button>
          <span className="text-faint text-caption">
            Deactivating never deletes — a department with history keeps it.
          </span>
        </div>

        <p className="text-faint mt-3 max-w-[80ch] text-caption">
          Yield compounds backwards: a department must make the shipped quantity
          divided by its own yield and the yield of every department the material
          passes through after it — the path below, not everything further down
          this list. Five departments at 98% each cost roughly a tenth of factory
          capacity.
        </p>
      </Panel>

      <RouteDependencyGrid />
      <ArticlesPanel />
      <MachinesPanel />
      <ShiftsPanel />
      <DepartmentShiftGrid />

      <Panel
        title="D-minus matrix"
        meta={
          incomplete
            ? `${incomplete} cells still blank`
            : 'Complete — every article schedulable'
        }
      >
        <Table>
          <thead>
            <tr>
              <Th>Article</Th>
              {routeCodes.map((code) => (
                <Th key={code} align="right">
                  {code}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {articles.map((article) => (
              <tr key={article}>
                <Td className="font-semibold">{article}</Td>
                {routeCodes.map((code) => {
                  const cell = dminus.data?.find(
                    (d) =>
                      d.article_code === article && d.department_code === code,
                  )
                  return (
                    <Td key={code} align="right">
                      <EditableNumber
                        value={cell?.is_complete ? cell.dminus_days : null}
                        prefix="D-"
                        placeholder="blank"
                        allowEmpty
                        min={0}
                        step={1}
                        onCommit={(days) =>
                          setDminus.mutate({
                            articleCode: article,
                            departmentCode: code,
                            days,
                          })
                        }
                      />
                    </Td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-faint mt-3 max-w-[80ch] text-caption">
          Each article takes a different time through each department, so the
          offset is held per pair and entered by hand. Clearing a cell puts it
          back to blank and stops that article scheduling — deliberately, because
          a silent zero would produce an impossible schedule that looks entirely
          normal.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Component rates" meta="Units per day, per shift">
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>Component</Th>
                <Th>Shift</Th>
                <Th align="right">Per day</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {rates.data?.map((r) => (
                <tr
                  key={`${r.department_code}-${r.component_code}-${r.shift_code}`}
                >
                  <Td>{r.department_code}</Td>
                  <Td>{r.component_code}</Td>
                  <Td>{r.shift_code}</Td>
                  <Td align="right">
                    <EditableNumber
                      value={r.units_per_day}
                      min={0.001}
                      onCommit={(unitsPerDay) =>
                        unitsPerDay !== null &&
                        setRate.mutate({
                          componentCode: r.component_code,
                          departmentCode: r.department_code,
                          shiftCode: r.shift_code,
                          unitsPerDay,
                        })
                      }
                    />
                  </Td>
                  <Td>
                    {r.is_measured ? (
                      <Tag tone="clear">Measured</Tag>
                    ) : (
                      <Tag tone="amber">Estimated</Tag>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-faint mt-3 text-caption">
            A rate is what the department makes in a day{' '}
            <em>doing nothing else</em>. That is what lets utilisation be added
            across components, and it is the convention real figures must be
            entered against. Rates become measured once derived from actuals.
          </p>
        </Panel>

        <Panel title="Holidays" meta="Sundays are derived, not listed">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {holidays.data?.map((h) => (
                <tr key={h.id}>
                  <Td>{formatDateLong(h.holiday_date)}</Td>
                  <Td>{h.description}</Td>
                  <Td align="right">
                    <button
                      type="button"
                      className="text-faint hover:text-flag text-caption"
                      onClick={() => deleteHoliday.mutate(h.id)}
                    >
                      Remove
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!holidays.data?.length ? <Empty>No holidays declared.</Empty> : null}
          <div className="mt-4">
            <Button variant="quiet" onClick={() => setAddingHoliday(true)}>
              Add a holiday
            </Button>
          </div>
          <p className="text-faint mt-3 text-caption">
            Declaring a holiday closes that day and renumbers the working-day
            calendar, so every schedule shifts to accommodate it.
          </p>
        </Panel>
      </div>

      <Panel title="Bill of materials" meta="From the ERP — read only">
        <Table>
          <thead>
            <tr>
              <Th>Article</Th>
              <Th>Component</Th>
              <Th>Description</Th>
              <Th align="right">Per unit</Th>
            </tr>
          </thead>
          <tbody>
            {bom.data?.map((b) => (
              <tr key={`${b.article_code}-${b.component_code}`}>
                <Td>{b.article_code}</Td>
                <Td className="font-semibold">{b.component_code}</Td>
                <Td className="text-mid">{b.component_name}</Td>
                <Td align="right">{formatNumber(b.qty_per_unit, 0)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-faint mt-3 max-w-[80ch] text-caption">
          Departments produce components, not chairs. A chair is ready only when
          the scarcest component is: everything else is stranded stock — real
          material and real labour producing nothing shippable. The BOM arrives
          from Panipuri, so it is not edited here.
        </p>
      </Panel>

      {addingDepartment ? (
        <AddDepartment
          nextPosition={
            Math.max(
              0,
              ...(departments.data?.map((d) => d.route_position) ?? [0]),
            ) + 10
          }
          onClose={() => setAddingDepartment(false)}
        />
      ) : null}

      {addingHoliday ? (
        <AddHoliday
          onSubmit={(input) => {
            addHoliday.mutate(input)
            setAddingHoliday(false)
          }}
          onClose={() => setAddingHoliday(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * Save the masters to a file and load them back.
 *
 * The offline build keeps everything in one browser, so a real route and
 * D-minus matrix entered here is one cleared cache away from gone. The file uses
 * codes rather than internal ids, so it also applies cleanly to a different
 * database — which is how real data will reach Supabase.
 */
function MastersFileControls() {
  const client = useQueryClient()
  const [busy, setBusy] = useState<'export' | 'import' | 'backup' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function onExport() {
    setBusy('export')
    setError(null)
    try {
      downloadMasters(await exportMasters())
      setMessage('Masters saved to a file.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * The masters file carries what can be re-entered. This carries what cannot.
   *
   * A rate typed wrongly can be typed again from a spreadsheet; what a
   * department declared it made on a Tuesday exists in one database and nowhere
   * else. Until now there was no way to get it out — every view either
   * aggregates the ledger or slices it by day.
   */
  async function onBackup() {
    setBusy('backup')
    setError(null)
    setMessage(null)
    try {
      const file = await exportBackup()
      downloadBackup(file)
      const n = summarise(file)
      setMessage(
        `Saved — ${n.orders} orders, ${n.lines} shipment lines, ` +
          `${n.ledger} ledger entries, ${n.rows} rows in all.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onImport(file: File) {
    setBusy('import')
    setError(null)
    setMessage(null)
    try {
      const applied = await importMasters(await readJsonFile(file))
      await rpc('run_schedule', { p_note: 'Masters imported' })
      await client.invalidateQueries()
      setMessage(`${applied} rows applied, and the schedule re-run.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="text-right">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" onClick={onExport} disabled={busy !== null}>
          {busy === 'export' ? 'Saving…' : 'Save masters to a file'}
        </Button>
        <Button
          variant="quiet"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== null}
        >
          {busy === 'import' ? 'Loading…' : 'Load from a file'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-testid="masters-import"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onImport(file)
          }}
        />
        <Button
          variant="quiet"
          onClick={onBackup}
          disabled={busy !== null}
          testId="backup-everything"
        >
          {busy === 'backup' ? 'Copying…' : 'Save everything to a file'}
        </Button>
      </div>
      {message ? (
        <p className="text-clear mt-1.5 text-caption">{message}</p>
      ) : null}
      {error ? <p className="text-flag mt-1.5 text-caption">{error}</p> : null}
      <p className="text-faint mt-1.5 max-w-[40ch] text-caption">
        Loading merges by code — it never wipes what is already there. The file
        moves between the offline and hosted systems unchanged.
      </p>
      {/* Said plainly, because the difference between a copy and a restore is
          exactly the thing people assume in the wrong direction. */}
      <p className="text-faint mt-1.5 max-w-[40ch] text-caption">
        <strong>Save everything</strong> also takes the order book and the
        production ledger — the figures nobody can type again. Keep it somewhere
        other than this machine. It is a copy to hold, not something the software
        loads back on its own.
      </p>
    </div>
  )
}

/**
 * Spec §2 lists the multi-shift model as one of Rev B's two structural
 * corrections: with a single headcount field every capacity figure in the system
 * would have been wrong, and wrong in a way that looks entirely normal.
 */
function ShiftsPanel() {
  const shifts = useShifts()
  const updateShift = useUpdateShift()
  const setShiftActive = useSetShiftActive()

  return (
    <Panel
      title="Shifts"
      meta={`${shifts.data?.filter((s) => s.is_active).length ?? 0} running`}
    >
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
        A department running two shifts has roughly double the daily capacity,
        and the overtime ceiling applies per person per shift rather than per
        day. Net production hours exclude breaks, setup and cleanup — the
        capacity maths uses this figure, never the clock span.
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Code</Th>
            <Th>Shift</Th>
            <Th>Hours</Th>
            <Th align="right">Net production</Th>
            <Th align="right">Overtime ceiling</Th>
            <Th align="right">Departments</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {shifts.data?.map((s) => (
            <tr key={s.id} className={s.is_active ? '' : 'text-faint'}>
              <Td className="font-semibold">{s.code}</Td>
              <Td>
                <EditableText
                  value={s.name}
                  onCommit={(name) => updateShift.mutate({ id: s.id, name })}
                />
              </Td>
              <Td>
                {s.start_label}–{s.end_label}
                {s.end_label < s.start_label ? (
                  <span className="text-faint"> (overnight)</span>
                ) : null}
              </Td>
              <Td align="right">
                <EditableNumber
                  value={s.net_production_hours}
                  suffix=" h"
                  min={1}
                  max={24}
                  onCommit={(netProductionHours) =>
                    netProductionHours !== null &&
                    updateShift.mutate({ id: s.id, netProductionHours })
                  }
                />
              </Td>
              <Td align="right">
                <EditableNumber
                  value={s.max_ot_hours}
                  suffix=" h"
                  min={0}
                  max={12}
                  onCommit={(maxOtHours) =>
                    maxOtHours !== null &&
                    updateShift.mutate({ id: s.id, maxOtHours })
                  }
                />
              </Td>
              <Td align="right">{s.departments_running}</Td>
              <Td align="right">
                <button
                  type="button"
                  className="text-faint hover:text-blue text-caption"
                  onClick={() =>
                    setShiftActive.mutate({ id: s.id, isActive: !s.is_active })
                  }
                >
                  {s.is_active ? 'Switch off' : 'Switch on'}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-faint mt-3 max-w-[80ch] text-caption">
        Five hours of overtime on top of an eight-hour net shift is a long day
        under the Factories Act's daily and quarterly limits, and multi-shift
        working adds its own provisions. The ceiling is configurable and the
        default is what the specification states; it is not a legal opinion and
        should be confirmed independently before go-live.
      </p>
    </Panel>
  )
}

/**
 * Which shifts each department actually works, and with how many people.
 * Capacity is the sum across the shifts switched on here.
 */
/**
 * What must finish before what. The route position above only decides the order
 * departments are listed in; this is the part the engine walks, and it is the
 * difference between a factory that runs in a line and one that does not.
 */
function RouteDependencyGrid() {
  const graph = useRouteGraph()
  const setDependency = useSetDependency()

  const cells = graph.data ?? []
  const departments = [
    ...new Map(cells.map((c) => [c.department_code, c.department_position])),
  ]
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code)

  const feeds = new Map(
    cells.map((c) => [`${c.department_code}|${c.feeder_code}`, c.feeds]),
  )
  const entryPoints = departments.filter(
    (d) => !departments.some((f) => feeds.get(`${d}|${f}`)),
  )

  return (
    <Panel
      title="What feeds what"
      meta={
        entryPoints.length === 1
          ? '1 department starts the route'
          : `${entryPoints.length} departments start the route`
      }
    >
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
        Read a row as “this department cannot start until…”, and tick the columns
        it waits for. A row with nothing ticked is an entry point — it waits for
        no one, which is what a feeder like metal finishing or fibre processing
        is. Departments not connected to each other run alongside each other.
      </p>

      <div data-testid="route-dependency-grid">
        <Table>
          <thead>
            <tr>
              <Th>Cannot start until…</Th>
              {departments.map((code) => (
                <Th key={code} align="right">
                  {code}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {departments.map((department) => (
              <tr key={department}>
                <Td className="font-semibold">
                  {department}
                  {entryPoints.includes(department) ? (
                    <span className="ml-2">
                      <Tag tone="blue">Entry point</Tag>
                    </span>
                  ) : null}
                </Td>
                {departments.map((feeder) => {
                  if (feeder === department)
                    return (
                      <Td key={feeder} align="right">
                        <span className="text-faint">—</span>
                      </Td>
                    )
                  const on = feeds.get(`${department}|${feeder}`) ?? false
                  return (
                    <Td key={feeder} align="right">
                      <button
                        type="button"
                        onClick={() =>
                          setDependency.mutate({
                            departmentCode: department,
                            feederCode: feeder,
                            feeds: !on,
                          })
                        }
                        className={
                          on
                            ? 'text-clear text-small font-semibold'
                            : 'text-faint hover:text-blue text-small'
                        }
                        title={
                          on
                            ? `${feeder} must finish before ${department} starts — click to remove`
                            : `Make ${department} wait for ${feeder}`
                        }
                      >
                        {on ? '●' : '·'}
                      </button>
                    </Td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {setDependency.isError ? (
        <p className="text-flag mt-3 max-w-[80ch] text-caption">
          {String(setDependency.error).includes('cycle')
            ? 'That would make two departments wait for each other. One of them already runs after the other, so it cannot also run before it.'
            : String(setDependency.error)}
        </p>
      ) : null}

      <p className="text-faint mt-3 max-w-[80ch] text-caption">
        This drives two things. A department is held back until everything
        feeding it is due — so a feeder wired into the wrong place produces
        runway breaches that are not real. And yield compounds along these edges,
        so a component is only inflated by the losses of the departments its
        material actually passes through.
      </p>
    </Panel>
  )
}

function DepartmentShiftGrid() {
  const grid = useDepartmentShiftGrid()
  const setDepartmentShift = useSetDepartmentShift()
  const setHeadcount = useSetHeadcount()

  const rows = grid.data ?? []
  const shiftCodes = [
    ...new Map(rows.map((r) => [r.shift_code, r.shift_is_active])),
  ]
  const departments = [
    ...new Map(rows.map((r) => [r.department_id, r.department_code])),
  ]

  const missingRates = rows.filter((r) => r.is_active && r.rate_count === 0)

  return (
    <Panel title="Who works which shift" meta="Capacity is the sum of these">
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
        Switch a shift on for a department and its capacity is added to that
        department's day. The number beneath is the sanctioned headcount for that
        department on that shift — the establishment the overtime maths divides
        by.
      </p>

      <Table>
        <thead>
          <tr>
            <Th>Department</Th>
            {shiftCodes.map(([code, active]) => (
              <Th key={code} align="right">
                {code}
                {active ? '' : ' (off)'}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {departments.map(([departmentId, departmentCode]) => (
            <tr key={departmentId}>
              <Td className="font-semibold">{departmentCode}</Td>
              {shiftCodes.map(([code]) => {
                const cell = rows.find(
                  (r) =>
                    r.department_id === departmentId && r.shift_code === code,
                )
                if (!cell) return <Td key={code} align="right">—</Td>
                return (
                  <Td key={code} align="right">
                    <div className="flex flex-col items-end gap-0.5">
                      <button
                        type="button"
                        disabled={!cell.shift_is_active}
                        onClick={() =>
                          setDepartmentShift.mutate({
                            departmentCode,
                            shiftCode: code,
                            isActive: !cell.is_active,
                          })
                        }
                        className={`text-caption ${
                          cell.is_active
                            ? 'text-clear font-semibold'
                            : 'text-faint hover:text-blue'
                        } disabled:hover:text-faint disabled:cursor-not-allowed`}
                        title={
                          cell.shift_is_active
                            ? cell.is_active
                              ? 'Switch this shift off for this department'
                              : 'Switch this shift on for this department'
                            : 'This shift is switched off entirely'
                        }
                      >
                        {cell.is_active ? 'Running' : 'Not running'}
                      </button>
                      {cell.is_active ? (
                        <span className="text-caption">
                          <EditableNumber
                            value={cell.sanctioned_headcount}
                            suffix=" people"
                            min={0}
                            step={1}
                            width="w-24"
                            onCommit={(headcount) =>
                              headcount !== null &&
                              setHeadcount.mutate({
                                departmentCode,
                                shiftCode: code,
                                headcount,
                              })
                            }
                          />
                        </span>
                      ) : null}
                      {cell.is_active && cell.rate_count === 0 ? (
                        <Tag tone="flag">No rates</Tag>
                      ) : null}
                    </div>
                  </Td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Table>

      {missingRates.length ? (
        <p className="text-flag mt-3 max-w-[80ch] text-caption">
          {missingRates.length} department-shift pairing
          {missingRates.length === 1 ? ' is' : 's are'} switched on with no
          component rates, so {missingRates.length === 1 ? 'it adds' : 'they add'}{' '}
          no capacity at all. Enter rates below, or switch the pairing off.
        </p>
      ) : null}

      <p className="text-faint mt-3 max-w-[80ch] text-caption">
        Switching a shift on copies the department's existing rates across as a
        starting point, flagged estimated. They are almost certainly wrong if the
        headcount differs — a second shift with half the people does not make
        what the first one makes.
      </p>
    </Panel>
  )
}

/**
 * Articles.
 *
 * The last master that needed a developer. Everything downstream hangs off an
 * article — its route, its offsets, its rates, its orders — so the one thing
 * nobody could do without SQL was the first thing anybody entering real data
 * would have to do. The capacity sheet's empty state has been pointing here for
 * days.
 *
 * The panel leads with what is *stopping* each article being planned rather
 * than with the fields, because that is the question somebody has after adding
 * one: a new article is inert until it has a route and its D-minus offsets, and
 * silence about that reads as the software being broken.
 */
function ArticlesPanel() {
  const articles = useArticleMaster()
  const setArticle = useSetArticle()
  const setActive = useSetArticleActive()
  const [adding, setAdding] = useState(false)

  const rows = articles.data ?? []
  const active = rows.filter((a) => a.is_active)
  const blocked = active.filter((a) => !a.can_schedule)

  return (
    <Panel
      title="Articles"
      meta={
        active.length
          ? `${active.length} active${blocked.length ? `, ${blocked.length} not schedulable` : ''}`
          : 'none yet'
      }
    >
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
        In the finished system these arrive from Panipuri. Until then they are
        entered here, and the route and rates go on the capacity sheet. A new
        article cannot be planned until it passes through at least one department
        and every one of those has a D-minus — a blank offset blocks scheduling
        rather than being read as zero.
      </p>

      <div data-testid="articles-master">
        {rows.length === 0 ? (
          <Empty>No articles yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Category</Th>
                <Th align="right">Departments</Th>
                <Th>Can be planned</Th>
                <Th align="right">Orders</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.code}
                  className={a.is_active ? '' : 'opacity-50'}
                  data-testid={`article-${a.code}`}
                  data-routed={a.departments_routed}
                  data-missing-dminus={a.missing_dminus}
                  data-can-schedule={a.can_schedule ? 'yes' : 'no'}
                >
                  <Td>{a.code}</Td>
                  <Td>
                    <EditableText
                      value={a.name}
                      width="w-56"
                      onCommit={(name) =>
                        setArticle.mutate({
                          code: a.code,
                          name,
                          category: a.category,
                        })
                      }
                    />
                  </Td>
                  <Td>
                    {a.category ?? <span className="text-faint">—</span>}
                  </Td>
                  <Td align="right">{a.departments_routed}</Td>
                  <Td>
                    {!a.is_active ? (
                      <Tag tone="mid">switched off</Tag>
                    ) : a.can_schedule ? (
                      <Tag tone="clear">yes</Tag>
                    ) : a.departments_routed === 0 ? (
                      <Tag tone="amber">no route</Tag>
                    ) : (
                      <Tag tone="flag">
                        {a.missing_dminus} D-minus missing
                      </Tag>
                    )}
                  </Td>
                  <Td align="right">{a.open_orders || '—'}</Td>
                  <Td align="right">
                    <button
                      type="button"
                      className="text-faint hover:text-flag text-caption"
                      onClick={() =>
                        setActive.mutate({
                          code: a.code,
                          isActive: !a.is_active,
                        })
                      }
                      title={
                        a.is_active
                          ? 'Switch off — orders already placed keep their plan'
                          : 'Switch back on'
                      }
                    >
                      {a.is_active ? 'Deactivate' : 'Restore'}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="quiet" onClick={() => setAdding(true)}>
          Add an article
        </Button>
        <span className="text-faint text-caption">
          Switching one off stops it being offered for new orders. Anything
          already ordered keeps its plan and its history.
        </span>
      </div>

      {adding ? <AddArticle onClose={() => setAdding(false)} /> : null}
    </Panel>
  )
}

/**
 * Machines.
 *
 * The panel leads with what is *down*, not with the list. A machine master is
 * something you enter once and read rarely; a machine being down is why a
 * department made forty instead of fifty today, and it is the only part of this
 * that changes a number anywhere else in the software.
 */
function MachinesPanel() {
  const machines = useMachines()
  const status = useMachineStatus()
  const downtime = useMachineDowntime()
  const setActive = useSetMachineActive()
  const clearDowntime = useClearMachineDowntime()
  const [adding, setAdding] = useState(false)
  const [booking, setBooking] = useState(false)

  const rows = machines.data ?? []
  const active = rows.filter((m) => m.is_active)
  const downNow = active.filter((m) => m.down_today)
  const shortToday = (status.data ?? []).filter((s) => s.available < s.machines)

  return (
    <Panel
      title="Machines"
      meta={
        active.length
          ? `${active.length} on the floor${downNow.length ? `, ${downNow.length} down` : ''}`
          : 'none recorded'
      }
    >
      <p className="text-mid mb-3 max-w-[80ch] text-caption">
        A department's day is scaled by the fraction of its machines running —
        four machines with one under maintenance is three quarters of a day. A
        department with <strong>no machines recorded</strong> is left exactly as
        it is: that is not a department with none, it is one nobody has told us
        about.
      </p>

      {shortToday.length ? (
        <div className="mb-4 space-y-2" data-testid="machines-down-today">
          {shortToday.map((s) => (
            <div
              key={s.department_code}
              className="border-rule bg-sheet border p-3"
              data-testid={`machines-short-${s.department_code}`}
              data-available={s.available}
              data-machines={s.machines}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-small font-semibold">
                  {s.department_name}
                </span>
                <Tag tone={s.available_pct < 60 ? 'flag' : 'amber'}>
                  {s.available} of {s.machines} running ·{' '}
                  {formatNumber(s.available_pct, 0)}% of the day
                </Tag>
              </div>
              <div className="text-mid mt-1 text-caption">
                {active
                  .filter((m) => m.department_code === s.department_code && m.down_today)
                  .map((m) => `${m.name} — ${m.down_reason}`)
                  .join(' · ')}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div data-testid="machines-master">
        {rows.length === 0 ? (
          <Empty>
            No machines recorded. Every department's capacity is exactly its
            standing rate until they are.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Machine</Th>
                <Th>Department</Th>
                <Th>Type</Th>
                <Th>Today</Th>
                <Th>Next down</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.code}
                  className={m.is_active ? '' : 'opacity-50'}
                  data-testid={`machine-${m.code}`}
                  data-down={m.down_today ? 'yes' : 'no'}
                >
                  <Td className="font-semibold">{m.code}</Td>
                  <Td>{m.name}</Td>
                  <Td>{m.department_name}</Td>
                  <Td>{m.machine_type ?? <span className="text-faint">—</span>}</Td>
                  <Td>
                    {!m.is_active ? (
                      <Tag tone="mid">retired</Tag>
                    ) : m.down_today ? (
                      <Tag tone="flag">{m.down_reason ?? 'down'}</Tag>
                    ) : (
                      <Tag tone="clear">running</Tag>
                    )}
                  </Td>
                  <Td>
                    {m.next_down_on ? (
                      formatDateLong(m.next_down_on)
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td align="right">
                    <button
                      type="button"
                      className="text-faint hover:text-flag text-caption"
                      onClick={() =>
                        setActive.mutate({ code: m.code, isActive: !m.is_active })
                      }
                      title={
                        m.is_active
                          ? 'Retire — it stops counting towards the department'
                          : 'Bring it back'
                      }
                    >
                      {m.is_active ? 'Retire' : 'Restore'}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="quiet" onClick={() => setAdding(true)} testId="add-machine">
          Add a machine
        </Button>
        <Button
          variant="quiet"
          onClick={() => setBooking(true)}
          testId="book-downtime"
          disabled={!active.length}
        >
          Book downtime
        </Button>
        <span className="text-faint text-caption">
          Retiring never deletes. A retired machine stops counting; a machine
          that is down still counts, and is simply not available.
        </span>
      </div>

      {downtime.data?.length ? (
        <div className="mt-4">
          <p className="label mb-1.5">Downtime booked</p>
          <div className="space-y-1" data-testid="downtime-list">
            {downtime.data.map((d) => (
              <div
                key={d.id}
                className="text-mid flex flex-wrap items-baseline gap-x-3 text-caption"
              >
                <span className="font-semibold">{d.machine_code}</span>
                <span>
                  {formatDateLong(d.from_date)}
                  {d.days > 1 ? ` — ${formatDateLong(d.to_date)}` : ''}
                </span>
                <span className="text-faint">{d.kind}</span>
                <span>{d.reason}</span>
                {d.active_today ? <Tag tone="flag">today</Tag> : null}
                <button
                  type="button"
                  className="text-faint hover:text-flag min-h-11 px-1 sm:min-h-0"
                  onClick={() => clearDowntime.mutate({ id: d.id })}
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {adding ? <AddMachine onClose={() => setAdding(false)} /> : null}
      {booking ? (
        <BookDowntime
          machines={active.map((m) => m.code)}
          onClose={() => setBooking(false)}
        />
      ) : null}
    </Panel>
  )
}

function AddMachine({ onClose }: { onClose: () => void }) {
  const departments = useDepartments()
  const create = useSetMachine()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [departmentCode, setDepartmentCode] = useState('')
  const [machineType, setMachineType] = useState('')

  return (
    <Modal title="Add a machine" subtitle="Machine master" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate(
            {
              code: code.trim(),
              name: name.trim(),
              departmentCode: departmentCode || departments.data?.[0]?.code || '',
              machineType: machineType.trim() || null,
            },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="STITCH-09"
              required
            />
          </Field>
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lockstitch 9"
              required
            />
          </Field>
          <Field label="Department">
            <select
              className={inputClass}
              value={departmentCode}
              onChange={(e) => setDepartmentCode(e.target.value)}
              required
            >
              <option value="">Choose…</option>
              {departments.data?.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <input
              className={inputClass}
              value={machineType}
              onChange={(e) => setMachineType(e.target.value)}
              placeholder="Juki DDL-8700"
            />
          </Field>
        </div>

        <p className="text-mid mt-4 max-w-[60ch] text-caption">
          Adding the first machine to a department changes what that department
          can make on any day one of them is down. Until then its capacity is
          the standing rate, untouched.
        </p>

        {create.isError ? (
          <p className="text-flag mt-3 text-caption">{String(create.error)}</p>
        ) : null}

        <ModalActions
          onCancel={onClose}
          submitLabel="Add machine"
          busy={create.isPending}
        />
      </form>
    </Modal>
  )
}

function BookDowntime({
  machines,
  onClose,
}: {
  machines: string[]
  onClose: () => void
}) {
  const book = useSetMachineDowntime()
  const today = todayIso()
  const [machineCode, setMachineCode] = useState(machines[0] ?? '')
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [kind, setKind] = useState('maintenance')
  const [reason, setReason] = useState('')

  return (
    <Modal title="Book downtime" subtitle="Machine out of service" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          book.mutate(
            { machineCode, fromDate, toDate, reason: reason.trim(), kind },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Machine">
            <select
              className={inputClass}
              value={machineCode}
              onChange={(e) => setMachineCode(e.target.value)}
              required
            >
              {machines.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kind">
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="maintenance">Maintenance</option>
              <option value="breakdown">Breakdown</option>
              <option value="changeover">Changeover</option>
            </select>
          </Field>
          <Field label="From">
            <input
              className={inputClass}
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              required
            />
          </Field>
          <Field label="To">
            <input
              className={inputClass}
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              required
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Reason">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Hook timing gone — spares ordered"
              required
            />
          </Field>
        </div>

        <p className="text-mid mt-4 max-w-[60ch] text-caption">
          A reason is required, as it is on a capacity override. A machine down
          for no stated reason is a number nobody can argue with or learn from.
          The schedule re-runs when this is saved.
        </p>

        {book.isError ? (
          <p className="text-flag mt-3 text-caption">{String(book.error)}</p>
        ) : null}

        <ModalActions onCancel={onClose} submitLabel="Book it" busy={book.isPending} />
      </form>
    </Modal>
  )
}

function AddArticle({ onClose }: { onClose: () => void }) {
  const setArticle = useSetArticle()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')

  return (
    <Modal title="Add an article" subtitle="Product master" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setArticle.mutate(
            {
              code: code.trim(),
              name: name.trim(),
              category: category.trim() || null,
            },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="UD354 SPPL WAL"
              required
            />
          </Field>
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Betsy Chair — Specter Pearl"
              required
            />
          </Field>
          <Field label="Category">
            <input
              className={inputClass}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Dining"
            />
          </Field>
        </div>

        <p className="text-mid mt-4 max-w-[60ch] text-caption">
          The code is what orders and the capacity sheet refer to, so it is worth
          matching whatever Panipuri calls it. Adding one that already exists
          corrects its name rather than creating a second.
        </p>

        {setArticle.isError ? (
          <p className="text-flag mt-3 text-caption">
            {String(setArticle.error)}
          </p>
        ) : null}

        <ModalActions
          onCancel={onClose}
          submitLabel="Add article"
          busy={setArticle.isPending}
        />
      </form>
    </Modal>
  )
}

function AddDepartment({
  nextPosition,
  onClose,
}: {
  nextPosition: number
  onClose: () => void
}) {
  const create = useCreateDepartment()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [routePosition, setRoutePosition] = useState(String(nextPosition))
  const [yieldPct, setYieldPct] = useState('98')

  return (
    <Modal title="Add a department" subtitle="Route master" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate(
            {
              code: code.trim().toUpperCase(),
              name: name.trim(),
              routePosition: Number(routePosition),
              yieldPct: Number(yieldPct),
            },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="POLISH"
              required
            />
          </Field>
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Polishing"
              required
            />
          </Field>
          <Field label="Route position">
            <input
              className={inputClass}
              type="number"
              value={routePosition}
              onChange={(e) => setRoutePosition(e.target.value)}
              required
            />
          </Field>
          <Field label="Yield %">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={100}
              value={yieldPct}
              onChange={(e) => setYieldPct(e.target.value)}
              required
            />
          </Field>
        </div>

        <p className="text-mid mt-4 max-w-[60ch] text-caption">
          A new department gets a blank D-minus cell for every article, flagged
          incomplete. Those articles stop scheduling until the offsets are
          entered — which is the point: a missing value should be visible, not
          silently treated as zero.
        </p>

        {create.isError ? (
          <p className="text-flag mt-3 text-caption">{String(create.error)}</p>
        ) : null}

        <ModalActions
          onCancel={onClose}
          submitLabel="Add department"
          busy={create.isPending}
        />
      </form>
    </Modal>
  )
}

function AddHoliday({
  onSubmit,
  onClose,
}: {
  onSubmit: (input: { date: string; description: string }) => void
  onClose: () => void
}) {
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')

  return (
    <Modal title="Add a holiday" subtitle="Working calendar" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit({ date, description: description.trim() })
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <input
              className={inputClass}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Description">
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Diwali"
              required
            />
          </Field>
        </div>
        <ModalActions onCancel={onClose} submitLabel="Add holiday" />
      </form>
    </Modal>
  )
}
