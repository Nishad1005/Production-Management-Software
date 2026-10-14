import { useState } from 'react'
import { useDepartments } from '@/data/planning'
import {
  useClearMachineDowntime,
  useMachineDowntime,
  useMachines,
  useMachineStatus,
  useSetMachine,
  useSetMachineActive,
  useSetMachineDowntime,
} from '@/data/mutations'
import { Button, Empty, Field, Panel, Table, Tag, Td, Th, Waiting } from '@/components/ui'
import { Modal, ModalActions } from '@/components/edit'
import { formatDateLong, formatNumber, inputClass, todayIso } from '@/components/format'
import { stateOf, waiting } from '@/lib/query-state'

/**
 * Machines, as a screen of their own.
 *
 * Until 15 Oct this panel lived only on Masters, behind planner and admin, so
 * the maintenance role existed and had nowhere to go — a breakdown had to be
 * booked by a planner. The panel is unchanged and Masters still shows it under
 * its Machines tab; this route puts it in the Floor group for maintenance (and
 * for a HOD to read), which is who books a machine down and who is stood
 * beside it when it stops.
 */
export function Machines() {
  return (
    <div className="space-y-6">
      <MachinesPanel />
    </div>
  )
}

export function MachinesPanel() {
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

      <div data-testid="machines-master" data-state={stateOf(machines)}>
        {waiting(stateOf(machines)) ? (
          <Waiting state={stateOf(machines)} error={machines.error} />
        ) : rows.length === 0 ? (
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
                  {d.name}
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
