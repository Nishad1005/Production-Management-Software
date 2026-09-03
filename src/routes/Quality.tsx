import {
  useDefectPareto,
  useQualityByArticle,
  useQualityByDepartment,
  type ParetoRow,
} from '@/data/quality'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatNumber } from '@/components/format'

/**
 * Quality, deck slide 17.
 *
 * The quantities have been in the ledger since Phase 3. What this screen adds
 * is the question the numbers could never answer on their own: **which two
 * causes would fix half of it**. That is why the first panel is a Pareto and
 * not a table of rates — a rejection percentage tells a department it is bad at
 * something without telling anybody what.
 */
export function Quality() {
  const pareto = useDefectPareto()
  const departments = useQualityByDepartment()
  const articles = useQualityByArticle()

  const causes = pareto.data ?? []
  const total = causes.reduce((n, c) => n + c.qty, 0)
  const unexplained = causes.find((c) => c.code === 'UNATTRIBUTED')
  const worst = causes.filter((c) => c.code !== 'UNATTRIBUTED').slice(0, 2)

  return (
    <div className="space-y-6">
      <Panel
        title="Where the losses come from"
        meta={total ? `${formatNumber(total)} rejected in all` : 'nothing rejected yet'}
      >
        <div data-testid="defect-pareto">
          {causes.length === 0 ? (
            <Empty>
              Nothing has been rejected on any declaration yet. Rejections are
              entered beside good output on the Production screen.
            </Empty>
          ) : (
            <div className="space-y-1.5">
              {causes.map((c) => (
                <CauseBar key={c.code} row={c} />
              ))}
            </div>
          )}
        </div>

        {worst.length === 2 ? (
          <p className="text-mid mt-4 max-w-[80ch] text-caption">
            <strong>{worst[0].name}</strong> and <strong>{worst[1].name}</strong>{' '}
            account for{' '}
            {formatNumber(worst[0].share_pct + worst[1].share_pct, 0)}% of
            everything rejected.
          </p>
        ) : null}

        {unexplained ? (
          <p className="text-amber mt-2 max-w-[80ch] text-caption">
            {formatNumber(unexplained.qty)} rejected pieces —{' '}
            {formatNumber(unexplained.share_pct, 0)}% — have no cause against
            them. Nobody is required to explain every reject, but an unexplained
            majority makes the rest of this screen a guess.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="By department, against the yield its master claims"
        meta={`${departments.data?.length ?? 0} reporting`}
      >
        <div data-testid="quality-by-department">
          {departments.data?.length === 0 ? (
            <Empty>No department has declared any production yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Department</Th>
                  <Th align="right">Good</Th>
                  <Th align="right">Rejected</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Yield, counted</Th>
                  <Th align="right">Against plan</Th>
                  <Th align="right">Explained</Th>
                  <Th>Biggest cause</Th>
                </tr>
              </thead>
              <tbody>
                {departments.data?.map((d) => (
                  <tr key={d.department_code} data-testid={`quality-${d.department_code}`}>
                    <Td className="font-semibold">{d.department_name}</Td>
                    <Td align="right">{formatNumber(d.qty_good)}</Td>
                    <Td align="right">{formatNumber(d.qty_rejected)}</Td>
                    <Td align="right">
                      {d.rejection_pct === null
                        ? '—'
                        : `${formatNumber(d.rejection_pct, 2)}%`}
                    </Td>
                    <Td align="right">
                      {d.measured_yield_pct === null
                        ? '—'
                        : `${formatNumber(d.measured_yield_pct, 1)}%`}
                    </Td>
                    <Td align="right">
                      {/* The gap between counted and claimed. Reported, never
                          applied — a master that edits itself is one nobody can
                          account for. */}
                      {d.against_plan_pct === null ? (
                        '—'
                      ) : (
                        <Tag tone={d.against_plan_pct < 0 ? 'flag' : 'clear'}>
                          {d.against_plan_pct > 0 ? '+' : ''}
                          {formatNumber(d.against_plan_pct, 1)}
                        </Tag>
                      )}
                    </Td>
                    <Td align="right">
                      {d.attributed_pct === null
                        ? '—'
                        : `${formatNumber(d.attributed_pct, 0)}%`}
                    </Td>
                    <Td>{d.biggest_cause ?? <span className="text-faint">—</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          A department with nothing declared is absent rather than shown at zero.
          Zero rejections and no reporting look identical on a screen and are
          opposite findings.
        </p>
      </Panel>

      <Panel title="By article" meta={`${articles.data?.length ?? 0} making`}>
        <div data-testid="quality-by-article">
          {articles.data?.length === 0 ? (
            <Empty>Nothing declared against any article yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Article</Th>
                  <Th align="right">Good</Th>
                  <Th align="right">Rejected</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Departments</Th>
                </tr>
              </thead>
              <tbody>
                {articles.data?.map((a) => (
                  <tr key={a.article_code}>
                    <Td>
                      <span className="font-semibold">{a.article_code}</span>
                      <span className="text-faint"> · {a.article_name}</span>
                    </Td>
                    <Td align="right">{formatNumber(a.qty_good)}</Td>
                    <Td align="right">{formatNumber(a.qty_rejected)}</Td>
                    <Td align="right">
                      {a.rejection_pct === null
                        ? '—'
                        : `${formatNumber(a.rejection_pct, 2)}%`}
                    </Td>
                    <Td align="right">{a.departments}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          The same rejections seen from the other side. A department having a bad
          month and one article being hard to make produce the same figure above,
          and only one of them is fixed by talking to the department.
        </p>
      </Panel>
    </div>
  )
}

const CATEGORY_TONE: Record<string, string> = {
  workmanship: 'bg-blue',
  material: 'bg-amber',
  machine: 'bg-flag',
  design: 'bg-mid',
  handling: 'bg-faint',
}

function CauseBar({ row }: { row: ParetoRow }) {
  const unexplained = row.code === 'UNATTRIBUTED'
  return (
    <div className="flex items-center gap-3">
      <div className="w-[220px] shrink-0 text-small">
        <span className={unexplained ? 'text-amber' : ''}>{row.name}</span>
        {!unexplained ? (
          <span className="text-faint text-caption"> · {row.category}</span>
        ) : null}
      </div>
      <div className="bg-paper relative h-5 flex-1">
        <div
          className={`h-full ${unexplained ? 'bg-amber' : (CATEGORY_TONE[row.category] ?? 'bg-blue')}`}
          style={{ width: `${Math.max(row.share_pct, 1)}%` }}
        />
      </div>
      <div className="nums text-mid w-[130px] shrink-0 text-right text-caption">
        {formatNumber(row.qty)} · {formatNumber(row.share_pct, 0)}%
        <span className="text-faint"> ({formatNumber(row.running_pct, 0)}%)</span>
      </div>
    </div>
  )
}
