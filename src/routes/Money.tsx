import { useState } from 'react'
import {
  useCashOutWeekly,
  useCostBreakdown,
  useCostSummary,
  useSupplierCommitments,
  type CostSummary,
} from '@/data/money'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'

/**
 * Money, row five of the scope of work.
 *
 * It says what things cost and when money must go out. It says nothing about
 * what anything sells for, because no order in Kram carries a value — and a
 * cash-flow screen showing money *in* with nothing behind it would be the most
 * believable wrong number in the system. The panel headings say so rather than
 * leaving the omission to be noticed.
 */
export function Money() {
  const weeks = useCashOutWeekly()
  const suppliers = useSupplierCommitments()
  const costs = useCostSummary()
  const [open, setOpen] = useState<string | null>(null)

  const rows = weeks.data ?? []
  const total = rows.reduce((n, w) => n + (w.amount ?? 0), 0)
  const unpriced = rows.reduce((n, w) => n + w.unpriced_lines, 0)
  const peak = rows.reduce((m, w) => Math.max(m, w.amount ?? 0), 0)

  return (
    <div className="space-y-6">
      <Panel
        title="Money out, week by week"
        meta={
          rows.length
            ? `₹${formatNumber(total)} across ${rows.length} weeks`
            : 'nothing committed'
        }
      >
        <div data-testid="cash-out">
          {rows.length === 0 ? (
            <Empty>
              The plan commits the factory to nothing yet. This fills in once
              articles have a bill of materials and the plan needs something
              bought.
            </Empty>
          ) : (
            <div className="space-y-1.5">
              {rows.map((w) => (
                <div key={w.week_starting} className="flex items-center gap-3">
                  <div className="w-[130px] shrink-0 text-small">
                    {formatDateLong(w.week_starting)}
                  </div>
                  <div className="bg-paper relative h-5 flex-1">
                    <div
                      className={w.overdue ? 'bg-flag h-full' : 'bg-blue h-full'}
                      style={{
                        width: `${Math.max(((w.amount ?? 0) / (peak || 1)) * 100, 1)}%`,
                      }}
                    />
                  </div>
                  <div className="nums text-mid w-[190px] shrink-0 text-right text-caption">
                    ₹{formatNumber(w.amount)}
                    <span className="text-faint">
                      {' '}
                      · {w.suppliers}{' '}
                      {w.suppliers === 1 ? 'supplier' : 'suppliers'}
                      {w.unpriced_lines
                        ? ` · ${w.unpriced_lines} unpriced`
                        : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-faint mt-4 max-w-[85ch] text-caption">
          Each material falls due the day it is needed plus the supplier's terms
          — the invoice follows the delivery, not the order. Weeks, because a
          cash question is asked in weeks and a daily list of four hundred rows
          answers nothing.
        </p>

        {unpriced ? (
          <p className="text-amber mt-2 max-w-[85ch] text-caption">
            {unpriced} {unpriced === 1 ? 'line has' : 'lines have'} no rate
            against the material, so they are counted here and not costed. The
            totals above are what we can price, not what the plan will cost.
          </p>
        ) : null}

        <p className="text-mid mt-2 max-w-[85ch] text-caption">
          <strong>This is money out only.</strong> Kram holds no order values, so
          it cannot say what comes in — and a cash-flow figure with an invented
          revenue side would be worse than none.
        </p>
      </Panel>

      <Panel
        title="By supplier"
        meta={suppliers.data?.length ? `${suppliers.data.length} suppliers` : ''}
      >
        <div data-testid="supplier-commitments">
          {suppliers.data?.length === 0 ? (
            <Empty>Nothing committed to any supplier yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Supplier</Th>
                  <Th align="right">Committed</Th>
                  <Th align="right">Materials</Th>
                  <Th align="right">Terms</Th>
                  <Th>First due</Th>
                  <Th align="right">Unpriced</Th>
                </tr>
              </thead>
              <tbody>
                {suppliers.data?.map((s) => (
                  <tr key={s.supplier_code}>
                    <Td>
                      <span className="font-semibold">{s.supplier_name}</span>
                      <span className="text-faint"> · {s.supplier_code}</span>
                    </Td>
                    <Td align="right">₹{formatNumber(s.amount)}</Td>
                    <Td align="right">{s.materials}</Td>
                    <Td align="right">{s.payment_terms_days} days</Td>
                    <Td>{formatDateLong(s.first_due)}</Td>
                    <Td align="right">
                      {s.unpriced_lines ? (
                        <Tag tone="amber">{s.unpriced_lines}</Tag>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Panel>

      <Panel
        title="What each article costs"
        meta={
          costs.data?.length
            ? `${costs.data.filter((c) => c.has_breakdown).length} of ${costs.data.length} broken down`
            : ''
        }
      >
        <div data-testid="article-costs">
          {costs.data?.length === 0 ? (
            <Empty>No articles yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Article</Th>
                  <Th align="right">Unit cost</Th>
                  <Th align="right">Material</Th>
                  <Th align="right">Labour</Th>
                  <Th align="right">Packing &amp; freight</Th>
                  <Th>Behind it</Th>
                </tr>
              </thead>
              <tbody>
                {costs.data?.map((a) => (
                  <CostRow
                    key={a.article_code}
                    row={a}
                    open={open === a.article_code}
                    onToggle={() =>
                      setOpen(open === a.article_code ? null : a.article_code)
                    }
                  />
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          Where an article has a breakdown, its unit cost is the sum of those
          lines — there is no second figure to disagree with them. A typed total
          with nothing behind it is still perfectly usable, and says so.
        </p>
      </Panel>
    </div>
  )
}

function CostRow({
  row,
  open,
  onToggle,
}: {
  row: CostSummary
  open: boolean
  onToggle: () => void
}) {
  const lines = useCostBreakdown(open ? row.article_code : null)

  return (
    <>
      <tr
        className={row.has_breakdown ? 'hover:bg-paper cursor-pointer' : ''}
        onClick={row.has_breakdown ? onToggle : undefined}
        data-testid={`cost-${row.article_code}`}
        data-breakdown={row.has_breakdown ? 'yes' : 'no'}
      >
        <Td>
          <span className="font-semibold">{row.article_code}</span>
          <span className="text-faint"> · {row.article_name}</span>
        </Td>
        <Td align="right">
          {row.unit_cost === null ? (
            <span className="text-faint">not costed</span>
          ) : (
            `₹${formatNumber(row.unit_cost)}`
          )}
        </Td>
        <Td align="right">
          {row.has_breakdown ? `₹${formatNumber(row.material_cost)}` : '—'}
        </Td>
        <Td align="right">
          {row.has_breakdown ? `₹${formatNumber(row.labour_cost)}` : '—'}
        </Td>
        <Td align="right">
          {row.has_breakdown ? `₹${formatNumber(row.packing_and_freight)}` : '—'}
        </Td>
        <Td>
          {row.has_breakdown ? (
            <Tag tone="clear">{row.lines} lines</Tag>
          ) : row.unit_cost === null ? (
            <span className="text-faint">—</span>
          ) : (
            <Tag tone="amber">a typed total</Tag>
          )}
        </Td>
      </tr>

      {open && lines.data?.length ? (
        <tr>
          <td colSpan={6} className="bg-paper/60 px-3 py-2">
            <div className="grid gap-x-6 gap-y-1 text-caption sm:grid-cols-2">
              {lines.data.map((l) => (
                <div
                  key={l.cost_line_code}
                  className="text-mid flex justify-between gap-3"
                >
                  <span>
                    {l.cost_line_name}
                    <span className="text-faint"> · {l.kind}</span>
                  </span>
                  <span className="nums">
                    ₹{formatNumber(l.amount, 2)}
                    <span className="text-faint">
                      {' '}
                      {formatNumber(l.share_pct, 1)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}
