import { useEffect, useState } from 'react'
import { useDepartmentInbound, useDepartmentQueue } from '@/data/wip'
import { useManpowerDay } from '@/data/manpower'
import { useMachineStatus } from '@/data/mutations'
import { useDepartments } from '@/data/planning'
import { formatNumber, todayIso } from '@/components/format'

/**
 * The screen the `kiosk` role has been waiting for since Phase 0.
 *
 * `kiosk` is one of the twelve roles in the specification, described in
 * `src/data/users.ts` as "read-only department display", and until now nothing
 * routed to it — the fifth built-and-tested thing to turn out invisible, after
 * capacity_overrides, wip_by_order, production_vs_plan and employees. The deck
 * calls it LED department screens.
 *
 * Written for a monitor on a wall, ten feet away, watched by nobody in
 * particular: no navigation, no controls once it is set, large type, and a
 * refresh on an interval because nobody is going to press anything. The
 * department is chosen once and remembered, so a screen that loses power comes
 * back up showing the same department.
 *
 * It reuses the department board's hooks exactly. This is a different
 * presentation of the same reads, not a second implementation — the board and
 * the wall must never be able to disagree.
 */
export function Display() {
  const departments = useDepartments()
  const [code, setCode] = useState<string | null>(() =>
    localStorage.getItem('kram.display.department'),
  )

  useEffect(() => {
    if (!code && departments.data?.length) setCode(departments.data[0].code)
  }, [departments.data, code])

  useEffect(() => {
    if (code) localStorage.setItem('kram.display.department', code)
  }, [code])

  const queue = useDepartmentQueue(code)
  const inbound = useDepartmentInbound(code)
  const machines = useMachineStatus()
  const people = useManpowerDay(todayIso())

  // Nobody is going to press refresh on a wall.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (tick) {
      void queue.refetch()
      void inbound.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const department = departments.data?.find((d) => d.code === code)
  const owed = (queue.data ?? []).filter((r) => r.qty_remaining > 0)
  const late = (inbound.data ?? []).filter(
    (r) => r.state !== 'ready' && r.days_to_their_due !== null && r.days_to_their_due <= 0,
  )
  const machine = machines.data?.find((m) => m.department_code === code)
  const crew = people.data?.find((p) => p.department_code === code)

  const today = owed.filter((r) => r.days_to_due !== null && r.days_to_due <= 0)

  return (
    <div className="bg-ink min-h-screen p-6 text-white" data-testid="floor-display">
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-white/20 pb-4">
        <h1 className="font-display text-[44px] leading-none font-extrabold tracking-tight">
          {department?.name ?? '—'}
        </h1>
        <div className="flex items-center gap-6 text-[20px]">
          {crew ? (
            <span>
              <strong>{crew.present}</strong>
              <span className="text-white/60"> of {crew.sanctioned} in</span>
            </span>
          ) : (
            <span className="text-white/50 text-[16px]">attendance not marked</span>
          )}
          {machine ? (
            <span className={machine.available < machine.machines ? 'text-amber' : ''}>
              <strong>{machine.available}</strong>
              <span className="text-white/60"> of {machine.machines} machines</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <section>
          <h2 className="text-[13px] tracking-[0.18em] text-white/50 uppercase">
            Due today or overdue
          </h2>
          <div className="mt-3 space-y-2" data-testid="display-today">
            {today.length === 0 ? (
              <p className="text-[22px] text-white/50">
                {owed.length
                  ? `Nothing due today. ${owed.length} jobs still ahead.`
                  : 'Nothing outstanding.'}
              </p>
            ) : (
              today.slice(0, 8).map((r) => (
                <div
                  key={`${r.shipment_line_id}-${r.component_code}`}
                  className="flex items-baseline justify-between gap-4 border-b border-white/10 pb-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[24px] font-semibold">
                      {r.article_code}
                    </div>
                    <div className="text-[15px] text-white/60">
                      {r.erp_order_no} · {r.component_code}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[30px] leading-none font-bold">
                      {formatNumber(r.qty_remaining)}
                    </div>
                    <div className="text-[13px] text-white/50">
                      of {formatNumber(r.qty_required)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <h2 className="text-[13px] tracking-[0.18em] text-white/50 uppercase">
            Waiting on
          </h2>
          <div className="mt-3 space-y-2" data-testid="display-waiting">
            {late.length === 0 ? (
              <p className="text-[22px] text-white/50">Nothing late into here.</p>
            ) : (
              late.slice(0, 6).map((r) => (
                <div
                  key={`${r.shipment_line_id}-${r.from_department_code}`}
                  className="border-l-2 border-amber pl-3"
                >
                  <div className="text-[20px] font-semibold">
                    {r.from_department_name}
                  </div>
                  <div className="text-[14px] text-white/60">
                    {r.erp_order_no} · owes {formatNumber(r.qty_required)} ·{' '}
                    {formatNumber(r.qty_counted_in)} reached you
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* The only control, and deliberately small: set it once when the screen
          goes on the wall, then nobody touches it again. */}
      <div className="mt-8 flex items-center gap-3 border-t border-white/10 pt-4 text-[12px] text-white/40">
        <label className="flex items-center gap-2">
          Showing
          <select
            className="border border-white/20 bg-transparent px-2 py-1 text-white"
            value={code ?? ''}
            onChange={(e) => setCode(e.target.value)}
            data-testid="display-department"
          >
            {departments.data?.map((d) => (
              <option key={d.id} value={d.code} className="text-ink">
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <span>Refreshes every minute.</span>
      </div>
    </div>
  )
}
