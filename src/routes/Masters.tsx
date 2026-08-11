import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useBom,
  useDepartmentShiftGrid,
  useDepartments,
  useDminus,
  useRates,
  useShifts,
} from '@/data/planning'
import {
  useAddHoliday,
  useCreateDepartment,
  useDeleteHoliday,
  useHolidays,
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
import { formatDateLong, formatNumber, inputClass } from '@/components/format'
import { exec } from '@/lib/database'
import {
  downloadMasters,
  exportMasters,
  importMasters,
  readJsonFile,
} from '@/lib/masters-io'
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
        <p className="text-mid max-w-[70ch] text-[12px]">
          Underlined figures are editable — click one, type, press Enter. Every
          change re-runs the schedule.
        </p>
        <MastersFileControls />
      </div>

      <Panel
        title="Production route"
        meta={`${departments.data?.length ?? 0} departments`}
      >
        <p className="text-mid mb-3 max-w-[80ch] text-[12px]">
          Departments are a configurable master, not hardcoded. The route below
          is the illustrative one from the capacity-flagging prototype and is
          meant to be replaced — U&M's real route is around seven departments.
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
                    className="text-faint hover:text-flag text-[11px]"
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
          <span className="text-faint text-[11.5px]">
            Deactivating never deletes — a department with history keeps it.
          </span>
        </div>

        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
          Yield compounds backwards: a department must make the shipped quantity
          divided by its own yield and the yield of every department after it.
          Five departments at 98% each cost roughly a tenth of factory capacity.
        </p>
      </Panel>

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
        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
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
          <p className="text-faint mt-3 text-[11.5px]">
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
                      className="text-faint hover:text-flag text-[11px]"
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
          <p className="text-faint mt-3 text-[11.5px]">
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
        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
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
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
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

  async function onImport(file: File) {
    setBusy('import')
    setError(null)
    setMessage(null)
    try {
      const applied = await importMasters(await readJsonFile(file))
      await exec(`select run_schedule(p_note => 'Masters imported')`)
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
      </div>
      {message ? (
        <p className="text-clear mt-1.5 text-[11.5px]">{message}</p>
      ) : null}
      {error ? <p className="text-flag mt-1.5 text-[11.5px]">{error}</p> : null}
      <p className="text-faint mt-1.5 max-w-[40ch] text-[11px]">
        Loading merges by code — it never wipes what is already there.
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
      <p className="text-mid mb-3 max-w-[80ch] text-[12px]">
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
                {s.start_time}–{s.end_time}
                {s.end_time < s.start_time ? (
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
                  className="text-faint hover:text-blue text-[11px]"
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
      <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
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
      <p className="text-mid mb-3 max-w-[80ch] text-[12px]">
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
                            departmentId,
                            shiftId: cell.shift_id,
                            isActive: !cell.is_active,
                          })
                        }
                        className={`text-[11px] ${
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
                        <span className="text-[11px]">
                          <EditableNumber
                            value={cell.sanctioned_headcount}
                            suffix=" people"
                            min={0}
                            step={1}
                            width="w-24"
                            onCommit={(headcount) =>
                              headcount !== null &&
                              setHeadcount.mutate({
                                departmentId,
                                shiftId: cell.shift_id,
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
        <p className="text-flag mt-3 max-w-[80ch] text-[11.5px]">
          {missingRates.length} department-shift pairing
          {missingRates.length === 1 ? ' is' : 's are'} switched on with no
          component rates, so {missingRates.length === 1 ? 'it adds' : 'they add'}{' '}
          no capacity at all. Enter rates below, or switch the pairing off.
        </p>
      ) : null}

      <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
        Switching a shift on copies the department's existing rates across as a
        starting point, flagged estimated. They are almost certainly wrong if the
        headcount differs — a second shift with half the people does not make
        what the first one makes.
      </p>
    </Panel>
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

        <p className="text-mid mt-4 max-w-[60ch] text-[11.5px]">
          A new department gets a blank D-minus cell for every article, flagged
          incomplete. Those articles stop scheduling until the offsets are
          entered — which is the point: a missing value should be visible, not
          silently treated as zero.
        </p>

        {create.isError ? (
          <p className="text-flag mt-3 text-[11.5px]">{String(create.error)}</p>
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
