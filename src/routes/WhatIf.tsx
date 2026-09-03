import { useEffect, useState } from 'react'
import { useCurrentRun, useDepartments } from '@/data/planning'
import {
  useChangedTasks,
  useComparison,
  useDeleteRun,
  usePromoteRun,
  useRunWhatIf,
  useRuns,
} from '@/data/whatif'
import {
  Button,
  Empty,
  Field,
  Metric,
  Panel,
  Table,
  Tag,
  Td,
  Th,
} from '@/components/ui'
import {
  BREACH_LABEL,
  formatDateLong,
  formatNumber,
  inputClass,
} from '@/components/format'

/**
 * Concept deck, slide 3: "What-if simulation to evaluate scenarios such as
 * adding overtime, changing priorities, or machine downtime before finalizing a
 * plan."
 *
 * All three are the same lever at different magnitudes — a multiplier on a
 * department's capacity over a window — so the form asks for that rather than
 * pretending they are separate features.
 */

const PRESETS = [
  {
    label: 'Department down',
    factor: 0,
    hint: 'Breakdown or shutdown — no output at all',
  },
  {
    label: 'Overtime',
    factor: 1.2,
    hint: 'Roughly two hours a day on top',
  },
  {
    label: 'Second shift',
    factor: 2,
    hint: 'Double the capacity, same rates',
  },
] as const

const CHANGE_TONE: Record<string, 'clear' | 'flag' | 'amber' | 'mid'> = {
  resolved: 'clear',
  new_breach: 'flag',
  changed_reason: 'amber',
  moved: 'mid',
}

const CHANGE_LABEL: Record<string, string> = {
  resolved: 'Resolved',
  new_breach: 'New breach',
  changed_reason: 'Different reason',
  moved: 'Dates moved',
}

export function WhatIf() {
  const current = useCurrentRun()
  const departments = useDepartments()
  const runs = useRuns()
  const runWhatIf = useRunWhatIf()
  const promote = usePromoteRun()
  const deleteRun = useDeleteRun()

  const [note, setNote] = useState('')
  const [departmentCode, setDepartmentCode] = useState('')
  const [factor, setFactor] = useState('0')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [includeProbable, setIncludeProbable] = useState(true)
  const [scenarioId, setScenarioId] = useState<string | null>(null)

  const baseId = current.data?.id
  const comparison = useComparison(baseId, scenarioId ?? undefined)
  const changed = useChangedTasks(baseId, scenarioId ?? undefined)

  // Default the window to the plan's own horizon, so a scenario covers the
  // work rather than a range someone had to guess at.
  useEffect(() => {
    if (!from && current.data?.horizon_from) setFrom(current.data.horizon_from)
    if (!to && current.data?.horizon_to) setTo(current.data.horizon_to)
  }, [current.data, from, to])

  const scenario = runs.data?.find((r) => r.id === scenarioId)
  const partial =
    scenario &&
    scenario.what_if_applied !== null &&
    scenario.what_if_intended !== null &&
    scenario.what_if_applied < scenario.what_if_intended

  const totals = {
    base: comparison.data?.reduce((n, r) => n + r.base_breaches, 0) ?? 0,
    scenario: comparison.data?.reduce((n, r) => n + r.scenario_breaches, 0) ?? 0,
    baseFlagged:
      comparison.data?.reduce((n, r) => n + r.base_flagged_days, 0) ?? 0,
    scenarioFlagged:
      comparison.data?.reduce((n, r) => n + r.scenario_flagged_days, 0) ?? 0,
  }

  return (
    <div className="space-y-6">
      <Panel title="Try a change" meta="Nothing here touches the live plan">
        <p className="text-mid mb-4 max-w-[80ch] text-caption">
          A scenario is scheduled as its own version of the plan, alongside the
          live one, and compared against it. The capacity change is applied for
          the run and taken straight back out — the masters are never edited.
        </p>

        <form
          className="grid items-end gap-4 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault()
            runWhatIf.mutate(
              {
                note: note.trim(),
                confidence: includeProbable
                  ? ['confirmed', 'probable']
                  : ['confirmed'],
                departmentCode: departmentCode || null,
                from: departmentCode ? from : null,
                to: departmentCode ? to : null,
                factor: departmentCode ? Number(factor) : null,
              },
              { onSuccess: (id) => setScenarioId(id) },
            )
          }}
        >
          <Field label="What are you trying?">
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Second shift on stitching through November"
              required
            />
          </Field>
          <Field label="Department">
            <select
              className={inputClass}
              value={departmentCode}
              onChange={(e) => setDepartmentCode(e.target.value)}
            >
              <option value="">No capacity change</option>
              {departments.data?.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              className={inputClass}
              type="date"
              value={from}
              disabled={!departmentCode}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              className={inputClass}
              type="date"
              value={to}
              disabled={!departmentCode}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={runWhatIf.isPending}>
            {runWhatIf.isPending ? 'Running…' : 'Run it'}
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Capacity</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={!departmentCode}
                onClick={() => setFactor(String(p.factor))}
                title={p.hint}
                className={`min-h-11 rounded-[2px] border px-2.5 py-1.5 text-small disabled:opacity-40 sm:min-h-0 sm:text-caption ${
                  Number(factor) === p.factor && departmentCode
                    ? 'border-blue text-blue bg-white font-semibold'
                    : 'border-rule text-mid hover:border-blue'
                }`}
              >
                {p.label}
              </button>
            ))}
            <span className="text-faint text-caption">
              ×
              <input
                className="border-rule ml-1 min-h-11 w-20 border px-1.5 py-1 text-emphasis sm:min-h-0 sm:w-16 sm:text-caption"
                type="number"
                step="0.1"
                min="0"
                value={factor}
                disabled={!departmentCode}
                onChange={(e) => setFactor(e.target.value)}
              />
            </span>
          </div>

          <label className="flex min-h-11 items-center gap-2 text-small sm:min-h-0 sm:text-small">
            <input
              type="checkbox"
              checked={includeProbable}
              onChange={(e) => setIncludeProbable(e.target.checked)}
            />
            Include probable orders
          </label>
        </div>
      </Panel>

      {scenarioId && comparison.data?.length ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Breaches now"
              value={formatNumber(totals.base)}
              hint="The live plan"
            />
            <Metric
              label="Breaches in this scenario"
              value={formatNumber(totals.scenario)}
              tone={
                totals.scenario < totals.base
                  ? 'clear'
                  : totals.scenario > totals.base
                    ? 'flag'
                    : 'ink'
              }
              hint={verdict(totals.base, totals.scenario, 'breach', 'breaches')}
            />
            <Metric
              label="Flagged days now"
              value={formatNumber(totals.baseFlagged)}
            />
            <Metric
              label="Flagged days in this scenario"
              value={formatNumber(totals.scenarioFlagged)}
              tone={
                totals.scenarioFlagged < totals.baseFlagged
                  ? 'clear'
                  : totals.scenarioFlagged > totals.baseFlagged
                    ? 'flag'
                    : 'ink'
              }
              hint={verdict(
                totals.baseFlagged,
                totals.scenarioFlagged,
                'flagged day',
                'flagged days',
              )}
            />
          </div>

          {partial ? (
            <p className="border-amber text-mid border-l-[3px] py-1 pl-4 text-caption">
              Only {scenario?.what_if_applied} of {scenario?.what_if_intended}{' '}
              component rates took the change — the rest already had a capacity
              override booked in that window, and a real one is not overwritten by
              a scenario. This result is the partial change, not the whole one.
            </p>
          ) : null}

          <Panel
            title={scenario?.note ?? 'Scenario'}
            meta="Against the live plan"
          >
            <Table>
              <thead>
                <tr>
                  <Th>Department</Th>
                  <Th align="right">Utilisation now</Th>
                  <Th align="right">In this scenario</Th>
                  <Th align="right">Change</Th>
                  <Th align="right">Breaches now</Th>
                  <Th align="right">Then</Th>
                </tr>
              </thead>
              <tbody>
                {comparison.data.map((r) => (
                  <tr key={r.department_code}>
                    <Td className="font-semibold">{r.department_code}</Td>
                    <Td align="right">
                      {r.base_utilisation?.toFixed(2) ?? '—'}
                    </Td>
                    <Td align="right">
                      {r.scenario_utilisation?.toFixed(2) ?? '—'}
                    </Td>
                    <Td align="right">
                      <span
                        className={
                          r.utilisation_delta > 0.0001
                            ? 'text-flag'
                            : r.utilisation_delta < -0.0001
                              ? 'text-clear'
                              : 'text-faint'
                        }
                      >
                        {r.utilisation_delta > 0 ? '+' : ''}
                        {r.utilisation_delta.toFixed(2)}
                      </span>
                    </Td>
                    <Td align="right">{r.base_breaches}</Td>
                    <Td align="right">
                      <span
                        className={
                          r.scenario_breaches < r.base_breaches
                            ? 'text-clear'
                            : r.scenario_breaches > r.base_breaches
                              ? 'text-flag'
                              : ''
                        }
                      >
                        {r.scenario_breaches}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="border-rule-soft mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
              <Button
                onClick={() => scenarioId && promote.mutate(scenarioId)}
                disabled={promote.isPending}
              >
                Make this the plan
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  if (scenarioId) deleteRun.mutate(scenarioId)
                  setScenarioId(null)
                }}
              >
                Discard
              </Button>
              <span className="text-faint text-caption">
                Promoting keeps the plan it replaces — every run is kept, so you
                can always go back and see what was decided.
              </span>
            </div>
          </Panel>

          <Panel
            title="What changed"
            meta={`${changed.data?.length ?? 0} tasks`}
          >
            {changed.data?.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Change</Th>
                    <Th>Order</Th>
                    <Th>Department</Th>
                    <Th>Component</Th>
                    <Th>Started</Th>
                    <Th>Now starts</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {changed.data.slice(0, 40).map((t, i) => (
                    <tr key={`${t.erp_order_no}-${t.department_code}-${t.component_code}-${i}`}>
                      <Td>
                        <Tag tone={CHANGE_TONE[t.change] ?? 'mid'}>
                          {CHANGE_LABEL[t.change] ?? t.change}
                        </Tag>
                      </Td>
                      <Td>
                        {t.erp_order_no}
                        <span className="text-faint"> line {t.line_no}</span>
                      </Td>
                      <Td>{t.department_code}</Td>
                      <Td>{t.component_code}</Td>
                      <Td>{formatDateLong(t.base_start)}</Td>
                      <Td className="font-semibold">
                        {formatDateLong(t.scenario_start)}
                      </Td>
                      <Td className="text-mid">
                        {t.scenario_breach
                          ? (BREACH_LABEL[t.scenario_breach] ??
                            t.scenario_breach)
                          : t.base_breach
                            ? `was ${BREACH_LABEL[t.base_breach] ?? t.base_breach}`
                            : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Empty>
                Not one task moved. The change makes no difference to this order
                book.
              </Empty>
            )}
          </Panel>
        </>
      ) : null}

      <Panel title="Runs" meta={`${runs.data?.length ?? 0} kept`}>
        <p className="text-mid mb-3 max-w-[80ch] text-caption">
          Every run is kept and none is ever overwritten, so an earlier plan can
          be recovered and compared against what actually happened. Select one to
          compare it with the live plan.
        </p>
        <Table>
          <thead>
            <tr>
              <Th>Run</Th>
              <Th>Scenario</Th>
              <Th align="right">Tasks</Th>
              <Th align="right">Breaches</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {runs.data?.map((r) => (
              <tr
                key={r.id}
                className={scenarioId === r.id ? 'bg-paper' : undefined}
              >
                <Td>
                  {new Date(r.run_at).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {r.is_current ? (
                    <span className="ml-2">
                      <Tag tone="clear">Live plan</Tag>
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {r.note ?? <span className="text-faint">—</span>}
                  {r.what_if_department ? (
                    <span className="text-faint">
                      {' '}
                      · {r.what_if_department} ×{r.what_if_factor}
                    </span>
                  ) : null}
                </Td>
                <Td align="right">{formatNumber(r.task_count)}</Td>
                <Td align="right">
                  <span className={r.breach_count ? 'text-flag' : 'text-clear'}>
                    {r.breach_count}
                  </span>
                </Td>
                <Td align="right">
                  {r.is_current ? (
                    <span className="text-faint text-caption">—</span>
                  ) : (
                    <button
                      type="button"
                      className="text-blue text-caption hover:underline"
                      onClick={() => setScenarioId(r.id)}
                    >
                      Compare
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  )
}

/**
 * Plurals are passed in rather than derived. Adding an "s" turns "breach" into
 * "breachs", and a screen shown to a client should not have a spelling mistake
 * in the number that matters most on it.
 */
function verdict(
  base: number,
  scenario: number,
  singular: string,
  plural: string,
) {
  const diff = scenario - base
  if (diff === 0) return 'No change'
  const noun = Math.abs(diff) === 1 ? singular : plural
  return diff < 0 ? `${-diff} fewer ${noun}` : `${diff} more ${noun}`
}
