import {
  useForecastReadiness,
  useLeadTimes,
  useMeasuredRates,
  useShipmentRisk,
  type Risk,
} from '@/data/forecast'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'

/**
 * Prediction, with its evidence attached.
 *
 * Readiness comes first on the screen, deliberately. Everything below it can
 * print a confident figure the moment ten rows sit behind it, and on a factory
 * that started using Kram a fortnight ago ten rows is not a lot of factory. The
 * first panel exists so nobody reads the rest without knowing what it is made
 * of — and on a project with no history it is the only panel with anything to
 * say, which is the correct outcome rather than a broken screen.
 */
export function Forecast() {
  const readiness = useForecastReadiness()
  const rates = useMeasuredRates()
  const leads = useLeadTimes()
  const risk = useShipmentRisk()

  const r = readiness.data
  const measuredRates = (rates.data ?? []).filter((x) => x.confidence === 'measured')
  const thinRates = (rates.data ?? []).filter((x) => x.confidence !== 'measured')
  const risks = risk.data ?? []
  const late = risks.filter((x) => x.band === 'likely late')
  const atRisk = risks.filter((x) => x.band === 'at risk')

  return (
    <div className="space-y-6">
      <Panel
        title="How much of this is worth believing"
        meta={r ? `${r.declarations} declarations · ${r.days_recorded} days` : ''}
      >
        <div
          data-testid="forecast-readiness"
          data-declarations={r?.declarations ?? 0}
          data-state={readiness.isPending ? 'loading' : readiness.isError ? 'failed' : 'ready'}
        >
          {/*
            `!r ||` used to fold "still loading" into "nothing declared", and
            the screen told a factory with twelve declarations against it that
            nothing had been declared — the same defect as the Attention screen,
            in the same shape, on the panel whose whole job is saying how much
            history exists.
          */}
          {readiness.isPending ? (
            <Empty>Counting the history…</Empty>
          ) : readiness.isError ? (
            <div className="border-flag bg-sheet border-l-2 p-3.5 text-small">
              <div className="text-flag font-semibold">
                The history could not be counted.
              </div>
              <div className="text-mid mt-1">
                Nothing below is a statement about the factory.{' '}
                {String(readiness.error)}
              </div>
            </div>
          ) : !r || r.declarations === 0 ? (
            <Empty>
              Nothing has been declared on the floor yet, so there is no history
              to learn from and every figure below says so. This is not a fault:
              it is what a forecast looks like before the factory has produced
              anything through Kram. Enter production on the Production screen and
              this fills in.
            </Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Figure label="Declarations" value={formatNumber(r.declarations)} />
              <Figure
                label="Days recorded"
                value={formatNumber(r.days_recorded)}
                hint={
                  r.first_day ? `${formatDateLong(r.first_day)} onwards` : undefined
                }
              />
              <Figure
                label="Rates measured"
                value={`${r.rates_measured} of ${r.rates_seen}`}
                hint={`${r.threshold} days needed each`}
                tone={r.rates_measured ? 'clear' : 'amber'}
              />
              <Figure
                label="Articles timed"
                value={`${r.articles_measured} of ${r.articles_seen}`}
                hint={`${r.threshold} finished lines needed`}
                tone={r.articles_measured ? 'clear' : 'amber'}
              />
            </div>
          )}
        </div>

        <p className="text-mid mt-4 max-w-[85ch] text-caption">
          Nothing below states a figure without stating what it is based on.
          Under <strong>{r?.threshold ?? 10} observations</strong> a prediction
          reports <em>too few to say</em> and shows the count instead — because a
          figure from two days and a figure from two hundred look identical on a
          screen, and only one of them should be acted on.
        </p>
      </Panel>

      <Panel
        title="Which shipments look like missing their container"
        meta={
          risks.length
            ? `${late.length} likely late · ${atRisk.length} at risk`
            : 'nothing open'
        }
      >
        <div data-testid="shipment-risk">
          {risks.length === 0 ? (
            <Empty>No open shipment lines to assess.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Article</Th>
                  <Th>Stuffing</Th>
                  <Th align="right">Window gone</Th>
                  <Th align="right">Work done</Th>
                  <Th>Reading</Th>
                  <Th>Because</Th>
                </tr>
              </thead>
              <tbody>
                {risks.map((x) => (
                  <RiskRow key={`${x.erp_order_no}-${x.line_no}`} row={x} />
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          Bands rather than a percentage. A percentage would be read as a
          probability, and it would be a number invented to look like one — the
          comparison underneath is simply how much of the window has gone against
          how much of the work.
        </p>
      </Panel>

      <Panel
        title="What each department actually achieves"
        meta={
          rates.data?.length
            ? `${measuredRates.length} measured · ${thinRates.length} still thin`
            : 'nothing declared'
        }
      >
        <div data-testid="measured-rates">
          {rates.data?.length === 0 ? (
            <Empty>
              No department has declared production yet, so there is nothing to
              compare against the rates on the capacity sheet.
            </Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Department</Th>
                  <Th>Component</Th>
                  <Th align="right">Days seen</Th>
                  <Th align="right">Claimed</Th>
                  <Th align="right">Achieved</Th>
                  <Th align="right">Against plan</Th>
                  <Th align="right">Worst / best</Th>
                </tr>
              </thead>
              <tbody>
                {rates.data?.map((m) => (
                  <tr
                    key={`${m.department_code}-${m.component_code}`}
                    data-testid={`rate-${m.department_code}`}
                    data-confidence={m.confidence}
                  >
                    <Td className="font-semibold">{m.department_name}</Td>
                    <Td className="text-faint">{m.component_code}</Td>
                    <Td align="right">{m.observations}</Td>
                    <Td align="right">
                      {m.standing_rate === null ? '—' : formatNumber(m.standing_rate)}
                    </Td>
                    <Td align="right">
                      {m.measured_rate === null ? (
                        <span className="text-faint">too few to say</span>
                      ) : (
                        formatNumber(m.measured_rate)
                      )}
                    </Td>
                    <Td align="right">
                      {m.against_plan_pct === null ? (
                        '—'
                      ) : (
                        <Tag tone={m.against_plan_pct < 0 ? 'flag' : 'clear'}>
                          {m.against_plan_pct > 0 ? '+' : ''}
                          {formatNumber(m.against_plan_pct, 1)}%
                        </Tag>
                      )}
                    </Td>
                    <Td align="right" className="text-faint">
                      {formatNumber(m.worst_day)} / {formatNumber(m.best_day)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          Reported, never applied. Nothing here edits the capacity sheet — a
          master that corrects itself is one nobody can account for, and a rate
          that drifted on its own would move every date in the system with no
          entry anywhere saying why.
        </p>
      </Panel>

      <Panel
        title="How long each article really takes"
        meta={leads.data?.length ? `${leads.data.length} articles` : ''}
      >
        <div data-testid="lead-times">
          {leads.data?.length === 0 ? (
            <Empty>No article has a complete route yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Article</Th>
                  <Th align="right">Lines finished</Th>
                  <Th align="right">Plan allows</Th>
                  <Th align="right">Actually took</Th>
                  <Th align="right">Fastest / slowest</Th>
                </tr>
              </thead>
              <tbody>
                {leads.data?.map((l) => (
                  <tr key={l.article_code}>
                    <Td>
                      <span className="font-semibold">{l.article_code}</span>
                      <span className="text-faint"> · {l.article_name}</span>
                    </Td>
                    <Td align="right">{l.observations}</Td>
                    <Td align="right">{l.planned_span} days</Td>
                    <Td align="right">
                      {l.measured_span === null ? (
                        <span className="text-faint">too few to say</span>
                      ) : (
                        `${formatNumber(l.measured_span, 1)} days`
                      )}
                    </Td>
                    <Td align="right" className="text-faint">
                      {l.fastest === null ? '—' : `${l.fastest} / ${l.slowest}`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Panel>
    </div>
  )
}

function Figure({
  label,
  value,
  hint,
  tone = 'ink',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ink' | 'clear' | 'amber'
}) {
  const border =
    tone === 'clear' ? 'border-clear' : tone === 'amber' ? 'border-amber' : 'border-rule'
  return (
    <div className={`bg-sheet border-l-2 border p-3.5 ${border}`}>
      <div className="text-faint text-caption tracking-wider uppercase">{label}</div>
      <div className="mt-1 text-display font-semibold">{value}</div>
      {hint ? <div className="text-faint text-caption">{hint}</div> : null}
    </div>
  )
}

const BAND: Record<Risk['band'], 'flag' | 'amber' | 'clear' | 'mid'> = {
  'likely late': 'flag',
  'at risk': 'amber',
  'on track': 'clear',
  'not started': 'mid',
}

function RiskRow({ row }: { row: Risk }) {
  return (
    <tr data-testid={`risk-${row.erp_order_no}`} data-band={row.band}>
      <Td className="font-semibold">{row.erp_order_no}</Td>
      <Td>{row.article_code}</Td>
      <Td>
        {formatDateLong(row.stuffing_date)}
        <span className="text-faint"> · {row.days_to_stuffing}d</span>
      </Td>
      <Td align="right">
        {row.window_elapsed_pct === null
          ? '—'
          : `${formatNumber(row.window_elapsed_pct, 0)}%`}
      </Td>
      <Td align="right">
        {row.work_done_pct === null ? '—' : `${formatNumber(row.work_done_pct, 0)}%`}
      </Td>
      <Td>
        <Tag tone={BAND[row.band]}>{row.band}</Tag>
      </Td>
      <Td className="text-mid text-caption">{row.because}</Td>
    </tr>
  )
}
