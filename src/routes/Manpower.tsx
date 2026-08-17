import { useEffect, useState } from 'react'
import {
  useEmployeeDay,
  useManpowerDay,
  useOvertimeAndHeadcount,
  useSetEmployeeAttendance,
  type EmployeeDay,
  type OvertimeRow,
} from '@/data/manpower'
import { useCurrentRun, useDepartments } from '@/data/planning'
import { Empty, Panel, Tag } from '@/components/ui'
import { formatDateLong, formatNumber, inputClass } from '@/components/format'

/**
 * Phase 4 — deck slide 13, "manpower real-time status".
 *
 * Answers the two questions the deck and the prototype between them ask: how
 * many people are actually here, and where a day is short, would overtime close
 * it or does it need bodies. The second is the client's own Module 2 arithmetic,
 * which Kram's documentation has claimed for weeks and only now performs.
 */
export function Manpower() {
  const run = useCurrentRun()
  const departments = useDepartments()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [departmentCode, setDepartmentCode] = useState<string | null>(null)

  useEffect(() => {
    if (!departmentCode && departments.data?.length) {
      setDepartmentCode(departments.data[0].code)
    }
  }, [departments.data, departmentCode])

  const today = useManpowerDay(date)
  const overtime = useOvertimeAndHeadcount(run.data?.id)
  const people = useEmployeeDay(departmentCode, date)

  const rows = today.data ?? []
  const gaps = overtime.data ?? []
  // Nobody can work overtime on a day that has gone. Those days are real
  // overload and they are why the plan is late, but they are a scheduling
  // problem now, not a staffing one — offering to staff them would be advice
  // that cannot be taken.
  const past = gaps.filter((g) => g.days_out < 0)
  const ahead = gaps.filter((g) => g.days_out >= 0)
  const needBodies = ahead.filter((g) => !g.covered_by_overtime)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <label className="flex shrink-0 flex-col gap-1">
          <span className="text-faint text-[11px] tracking-wider uppercase">
            Date
          </span>
          <input
            type="date"
            className={inputClass}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="manpower-date"
          />
        </label>
        <p className="text-mid hidden max-w-[56ch] text-[12px] sm:block">
          Marking somebody present or absent changes what their department can
          make that day, so the plan re-runs. Overtime here is hours actually
          worked.
        </p>
      </div>

      <Panel
        title="Where overtime would close the gap"
        meta={
          ahead.length
            ? `${needBodies.length} of ${ahead.length} need people`
            : 'no day ahead over capacity'
        }
      >
        <div data-testid="manpower-overtime">
          {ahead.length === 0 ? (
            <Empty>
              No department is asked for more than it can make on any day still
              to come, so there is no overtime to consider.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {ahead.slice(0, 20).map((g) => (
                <OvertimeCard key={`${g.department_code}-${g.load_date}`} row={g} />
              ))}
            </div>
          )}
        </div>
        {ahead.length > 20 ? (
          <p className="text-faint mt-3 text-[11.5px]">
            Showing the 20 soonest of {ahead.length}.
          </p>
        ) : null}
        {past.length ? (
          <p className="text-amber mt-3 text-[11.5px]">
            {past.length} overloaded {past.length === 1 ? 'day has' : 'days have'}{' '}
            already gone by. No amount of overtime reaches them — that work is
            late, and it moves on the schedule rather than here.
          </p>
        ) : null}
        <p className="text-faint mt-3 hidden max-w-[85ch] text-[11.5px] sm:block">
          An overtime hour is worth less than a normal one — the efficiency
          figure on each shift says how much less. Where the ceiling is reached,
          the balance is reported as people instead. This is the arithmetic from
          your own capacity prototype, and the tests prove it matches.
        </p>
      </Panel>

      <Panel
        title="Who is in"
        meta={rows.length ? formatDateLong(date) : 'nothing recorded'}
      >
        <div data-testid="manpower-today" className="space-y-2.5">
          {rows.length === 0 ? (
            <Empty>
              Nobody has been marked in or out on {formatDateLong(date)}. Until
              somebody is, every department plans on its full establishment.
            </Empty>
          ) : (
            rows.map((r) => (
              <div
                key={`${r.department_code}-${r.shift_code}`}
                className="border-rule bg-sheet border p-3.5"
                data-testid={`manpower-dept-${r.department_code}`}
                data-present={r.present}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-semibold">
                    {r.department_name}
                  </span>
                  <span className="text-faint text-[11.5px]">
                    {r.sanctioned} on the books · shift {r.shift_code}
                  </span>
                </div>
                <div className="text-mid mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
                  <span>
                    <strong>{r.present}</strong> in
                  </span>
                  {r.absent > 0 ? <span>{r.absent} out</span> : null}
                  {r.on_leave > 0 ? <span>{r.on_leave} on leave</span> : null}
                  {r.ot_hours > 0 ? (
                    <span>
                      {formatNumber(r.ot_hours, 1)} OT hours across{' '}
                      {r.people_on_ot}
                    </span>
                  ) : null}
                  {r.unrecorded > 0 ? (
                    <span className="text-amber">
                      {r.unrecorded} not marked
                    </span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel title="Deployment" meta={`${people.data?.length ?? 0} people`}>
        <label className="mb-3 flex max-w-xs flex-col gap-1">
          <span className="text-faint text-[11px] tracking-wider uppercase">
            Department
          </span>
          <select
            className={inputClass}
            value={departmentCode ?? ''}
            onChange={(e) => setDepartmentCode(e.target.value)}
            data-testid="manpower-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
        </label>

        <div data-testid="manpower-people">
          {people.data?.length === 0 ? (
            <Empty>
              No one is on the books for {departmentCode}. Employees are a master
              — add them and they appear here.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {(people.data ?? []).map((p) => (
                <PersonCard key={p.emp_code} person={p} date={date} />
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}

function OvertimeCard({ row }: { row: OvertimeRow }) {
  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold">{row.department_name}</div>
          <div className="text-mid text-[12px]">
            {formatDateLong(row.load_date)} ·{' '}
            {row.days_out === 0 ? 'today' : `in ${row.days_out}d`}
          </div>
        </div>
        <Tag tone={row.covered_by_overtime ? 'amber' : 'flag'}>
          {row.covered_by_overtime
            ? 'overtime covers it'
            : `needs ${row.extra_people} more`}
        </Tag>
      </div>

      <div className="text-mid mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        <span>
          Over by <strong>{Math.round(row.over_fraction * 100)}%</strong>
        </span>
        <span>
          <strong>{formatNumber(row.ot_hours_per_person, 1)}</strong> OT
          hours each
        </span>
        <span className="text-faint">
          ceiling {formatNumber(row.ot_ceiling, 1)}h · {row.people} people
        </span>
      </div>

      {!row.covered_by_overtime ? (
        <p className="text-faint mt-1.5 text-[11.5px]">
          Overtime alone runs out. {row.people_instead} extra people would cover
          it without any.
        </p>
      ) : null}
    </div>
  )
}

const STATUSES = ['present', 'absent', 'leave'] as const

function PersonCard({ person, date }: { person: EmployeeDay; date: string }) {
  const mark = useSetEmployeeAttendance()
  const [ot, setOt] = useState(String(person.ot_hours))

  useEffect(() => setOt(String(person.ot_hours)), [person.ot_hours])

  const set = (status: (typeof STATUSES)[number], otHours = Number(ot) || 0) =>
    mark.mutate({ empCode: person.emp_code, date, status, otHours })

  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold">{person.name}</div>
          <div className="text-mid text-[12px]">
            {person.emp_code} · {person.skill_level.replace('_', ' ')}
          </div>
        </div>
        {person.status === 'unrecorded' ? (
          <Tag tone="amber">not marked</Tag>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => set(s)}
            disabled={mark.isPending}
            className={`min-h-11 rounded-[2px] border px-3 text-[13px] font-semibold disabled:opacity-40 sm:min-h-0 sm:py-1.5 sm:text-[12px] ${
              person.status === s
                ? 'border-blue text-blue bg-white'
                : 'border-rule text-mid hover:border-blue'
            }`}
          >
            {s === 'leave' ? 'On leave' : s === 'absent' ? 'Out' : 'In'}
          </button>
        ))}

        {/* Overtime only means anything for somebody who was here. */}
        {person.status === 'present' ? (
          <label className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.5"
              className={`${inputClass} w-24`}
              value={ot}
              onChange={(e) => setOt(e.target.value)}
              onBlur={() => Number(ot) !== person.ot_hours && set('present')}
              aria-label={`Overtime hours, ${person.name}`}
            />
            <span className="text-faint text-[11.5px]">OT hrs</span>
          </label>
        ) : null}
      </div>
    </div>
  )
}
