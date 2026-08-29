import { useState } from 'react'
import { Link } from 'react-router'
import {
  useBottlenecks,
  useCurrentRun,
  useFlagTriage,
  useKpis,
  useResetDemo,
  useRunSchedule,
} from '@/data/planning'
import { Button, Empty, Metric, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { useAccess } from '@/lib/access-context'
import { formatDate, formatDateLong, formatNumber } from '@/components/format'

const CONFIDENCE_SETS: Record<string, string[]> = {
  'Confirmed only': ['confirmed'],
  'Confirmed + probable': ['confirmed', 'probable'],
  Everything: ['confirmed', 'probable', 'forecast'],
}

/** Spec §14 triage labels, spelled out. */
const TRIAGE_LABEL: Record<string, { text: string; tone: 'clear' | 'amber' | 'flag' }> = {
  hiring: { text: 'Hiring still possible', tone: 'clear' },
  overtime_resequence_subcontract: {
    text: 'Overtime · resequence · subcontract',
    tone: 'amber',
  },
  customer_conversation: { text: 'Customer conversation', tone: 'flag' },
}

export function CommandCentre() {
  const [confidence, setConfidence] = useState('Confirmed + probable')
  const run = useCurrentRun()
  const kpis = useKpis(run.data?.id)
  const bottlenecks = useBottlenecks(run.data?.id)
  const triage = useFlagTriage(run.data?.id)
  const runSchedule = useRunSchedule()
  const reset = useResetDemo()
  const access = useAccess()

  const busy = runSchedule.isPending || reset.isPending

  return (
    <div className="space-y-6">
      <Panel
        title="Schedule run"
        meta={
          run.data
            ? `${formatDateLong(run.data.run_at.slice(0, 10))} · ${run.data.duration_ms ?? 0} ms`
            : 'No run yet'
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <span className="label block pb-1">Include orders</span>
              <div className="flex gap-2">
                {Object.keys(CONFIDENCE_SETS).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setConfidence(key)}
                    className={`rounded-[2px] border px-2.5 py-1.5 text-[12px] ${
                      confidence === key
                        ? 'border-blue text-blue bg-white font-semibold'
                        : 'border-rule text-mid hover:border-blue'
                    }`}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
            <Button
              onClick={() => runSchedule.mutate(CONFIDENCE_SETS[confidence])}
              disabled={busy}
            >
              {runSchedule.isPending ? 'Scheduling…' : 'Run the schedule'}
            </Button>
          </div>
          {/*
            Offline only. `reset()` throws away the browser's database and
            reapplies the seed; the hosted backend has no such thing, so on the
            hosted system this button called an optional method that is not
            there, reported success and changed nothing — a control that looks
            like it worked and did not, which is the failure this project keeps
            refusing. It is also mislabelled there: a shared database has no
            demo data to reset.
          */}
          {access.isOffline ? (
            <Button
              variant="quiet"
              onClick={() => reset.mutate()}
              disabled={busy}
              testId="reset-demo"
            >
              {reset.isPending ? 'Resetting…' : 'Reset demo data'}
            </Button>
          ) : null}
        </div>

        <p className="text-mid mt-3 max-w-[80ch] text-[12px]">
          Each run writes a new immutable version, so an earlier plan can always
          be recovered and compared against what actually happened. Nothing is
          overwritten.
        </p>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Shipment lines"
          value={formatNumber(kpis.data?.shipment_lines)}
          hint="The scheduling unit, not the order"
        />
        <Metric
          label="Scheduled tasks"
          value={formatNumber(kpis.data?.tasks)}
          hint="Line × department × component"
        />
        <Metric
          label="Breaches"
          value={formatNumber(kpis.data?.breaches)}
          tone={kpis.data?.breaches ? 'flag' : 'clear'}
          hint="Tasks that cannot be made as planned"
        />
        <Metric
          label="Flagged days"
          value={formatNumber(kpis.data?.flagged_days)}
          tone={kpis.data?.flagged_days ? 'flag' : 'clear'}
          hint="Department-days over capacity"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Bottleneck utilisation"
          meta="Which department is the constraint"
        >
          <p className="text-mid mb-3 max-w-[60ch] text-[12px]">
            The heatmap shows which days hurt. This shows which department is
            structurally the constraint — capacity above the bottleneck is
            decorative. This is the view that answers where the next person or
            the next machine goes.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th align="right">Average</Th>
                <Th align="right">Peak</Th>
                <Th align="right">Flagged</Th>
                <Th align="right">Idle</Th>
              </tr>
            </thead>
            <tbody>
              {bottlenecks.data?.map((b) => (
                <tr key={b.department_id}>
                  <Td>
                    <span className="font-semibold">{b.department_name}</span>
                    {b.bottleneck_rank === 1 ? (
                      <span className="ml-2">
                        <Tag tone="flag">Constraint</Tag>
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <UtilisationBar value={b.avg_utilisation} />
                  </Td>
                  <Td align="right">{b.peak_utilisation.toFixed(2)}</Td>
                  <Td align="right">
                    <span className={b.flagged_days ? 'text-flag' : ''}>
                      {b.flagged_days}
                    </span>
                  </Td>
                  <Td align="right">{b.idle_days}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!bottlenecks.data?.length ? <Empty>No run yet.</Empty> : null}
        </Panel>

        <Panel
          title="Flag triage"
          meta={`${triage.data?.length ?? 0} flagged days`}
        >
          <p className="text-mid mb-3 max-w-[60ch] text-[12px]">
            Sorted by how much time is left, and labelled with what is still
            possible at that lead time. A label, not a recommendation — the
            decision rests on material, cash and customer relationships the
            system cannot see.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Department</Th>
                <Th align="right">Over by</Th>
                <Th>Still possible</Th>
              </tr>
            </thead>
            <tbody>
              {triage.data?.slice(0, 12).map((t) => {
                const label = TRIAGE_LABEL[t.still_possible]
                return (
                  <tr key={`${t.department_code}-${t.load_date}`}>
                    <Td>{formatDate(t.load_date)}</Td>
                    <Td>{t.department_code}</Td>
                    <Td align="right" className="text-flag">
                      +{(t.over_by * 100).toFixed(0)}%
                    </Td>
                    <Td>
                      <Tag tone={label?.tone ?? 'mid'}>
                        {label?.text ?? t.still_possible}
                      </Tag>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
          {!triage.data?.length ? (
            <Empty>No day is over capacity. Nothing to triage.</Empty>
          ) : null}
          {(triage.data?.length ?? 0) > 12 ? (
            <p className="text-faint mt-3 text-[11.5px]">
              Showing the 12 earliest of {triage.data?.length}.{' '}
              <Link to="/heatmap" className="text-blue underline">
                See them all on the heatmap
              </Link>
              .
            </p>
          ) : null}
        </Panel>
      </div>
    </div>
  )
}

/** Utilisation reads better as a bar than a number: 1.0 is the line that matters. */
export function UtilisationBar({ value }: { value: number }) {
  const pct = Math.min(value, 2) / 2
  const tone =
    value > 1 ? 'bg-flag' : value > 0.85 ? 'bg-amber' : 'bg-clear'
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="bg-rule-soft relative hidden h-1.5 w-20 sm:block">
        <span
          className={`absolute inset-y-0 left-0 ${tone}`}
          style={{ width: `${pct * 100}%` }}
        />
        {/* The 1.0 line — the only threshold that means anything here. */}
        <span className="bg-ink absolute inset-y-[-2px] left-1/2 w-px" />
      </span>
      <span className="w-10 text-right">{value.toFixed(2)}</span>
    </span>
  )
}
