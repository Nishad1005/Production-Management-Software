import { useState } from 'react'
import {
  useMaterialRequirements,
  useMaterialShortage,
  useSetMaterialStock,
  type MaterialShortage,
} from '@/data/material'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDate, formatDateLong, formatNumber } from '@/components/format'
import { EditableNumber } from '@/components/edit'

/**
 * Material, deck slide 15 — and the question the deck's slide 18 actually asks:
 * *"material ordering date to the supplier"*.
 *
 * The screen leads with **what to order this week**, not with a stock report.
 * A list of quantities on shelves is a thing you read when you have time; the
 * date a purchase order stops being possible is a thing you need shouted at
 * you, and it is the only figure here nobody can recover once it has passed.
 */
export function Material() {
  const shortage = useMaterialShortage()
  const [open, setOpen] = useState<string | null>(null)

  const rows = shortage.data ?? []
  const late = rows.filter((r) => r.order_now)
  const short = rows.filter((r) => r.status === 'short')
  const uncounted = rows.filter((r) => r.status === 'not counted')

  return (
    <div className="space-y-6">
      <Panel
        title="Order now, or it will be late"
        meta={late.length ? `${late.length} past their ordering date` : 'nothing overdue'}
      >
        <div data-testid="material-order-now">
          {rows.length === 0 ? (
            <Empty>
              No material is needed by the current plan. Either nothing is
              scheduled, or no article has a bill of materials yet — that is
              entered on Masters.
            </Empty>
          ) : late.length === 0 ? (
            <Empty>
              Every material on the plan can still be ordered in time. The
              earliest date that stops being true is{' '}
              {formatDateLong(rows[0]?.first_order_by)}.
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {late.map((r) => (
                <OrderCard key={r.material_code} row={r} />
              ))}
            </div>
          )}
        </div>
        <p className="text-faint mt-3 max-w-[85ch] text-caption">
          Counted back from the day the department that uses it starts — leather
          when cutting begins, not when the container sails — less the supplier's
          lead time. Lead times are calendar days: a supplier does not observe
          our factory holidays.
        </p>
      </Panel>

      <Panel
        title="Against the store"
        meta={
          rows.length
            ? `${short.length} short · ${uncounted.length} never counted`
            : ''
        }
      >
        <div data-testid="material-stock">
          {rows.length === 0 ? (
            <Empty>Nothing to compare until the plan needs something.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Material</Th>
                  <Th>Category</Th>
                  <Th align="right">Needed</Th>
                  <Th align="right">On hand</Th>
                  <Th align="right">Short by</Th>
                  <Th>Counted</Th>
                  <Th>First needed</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <StockRow
                    key={r.material_code}
                    row={r}
                    open={open === r.material_code}
                    onToggle={() =>
                      setOpen(open === r.material_code ? null : r.material_code)
                    }
                  />
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {uncounted.length ? (
          <p className="text-amber mt-3 max-w-[85ch] text-caption">
            {uncounted.length}{' '}
            {uncounted.length === 1 ? 'material has' : 'materials have'} never
            been counted. They are not being reported as short — nobody has been
            to the store, which is a different thing, and calling it a shortage
            would bury the real ones.
          </p>
        ) : null}
      </Panel>
    </div>
  )
}

function OrderCard({ row }: { row: MaterialShortage }) {
  return (
    <div className="border-rule bg-sheet border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-body font-semibold">{row.material_name}</div>
          <div className="text-mid text-caption">
            {row.material_code}
            {row.supplier_code ? ` · ${row.supplier_code}` : ' · no supplier'}
          </div>
        </div>
        <Tag tone="flag">order by {formatDate(row.first_order_by)}</Tag>
      </div>

      <div className="text-mid mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-caption">
        <span>
          <strong>{formatNumber(row.qty_required, 2)}</strong> {row.uom} needed
        </span>
        <span>
          first on <strong>{formatDateLong(row.first_needed_on)}</strong>
        </span>
        <span className="text-faint">
          {row.lead_time_days} day lead · {row.jobs}{' '}
          {row.jobs === 1 ? 'job' : 'jobs'}
        </span>
      </div>

      {/* The stock line changes what to do about it, so it sits with the date
          rather than in the table below. */}
      <p className="text-faint mt-1.5 text-caption">
        {row.status === 'not counted'
          ? 'Nobody has counted this one — it may already be in the store.'
          : row.status === 'covered'
            ? `${formatNumber(row.qty_on_hand, 2)} ${row.uom} on hand, which covers it.`
            : `${formatNumber(row.qty_on_hand, 2)} ${row.uom} on hand, short by ${formatNumber(row.shortfall, 2)}.`}
      </p>
    </div>
  )
}

const TONE: Record<MaterialShortage['status'], 'flag' | 'clear' | 'amber'> = {
  short: 'flag',
  covered: 'clear',
  'not counted': 'amber',
}

function StockRow({
  row,
  open,
  onToggle,
}: {
  row: MaterialShortage
  open: boolean
  onToggle: () => void
}) {
  const setStock = useSetMaterialStock()
  const jobs = useMaterialRequirements(open ? row.material_code : null)

  return (
    <>
      <tr
        className="hover:bg-paper cursor-pointer"
        onClick={onToggle}
        data-testid={`material-${row.material_code}`}
        data-status={row.status}
      >
        <Td>
          <span className="font-semibold">{row.material_name}</span>
          <span className="text-faint"> · {row.material_code}</span>
        </Td>
        <Td>{row.category ?? '—'}</Td>
        <Td align="right">
          {formatNumber(row.qty_required, 2)} {row.uom}
        </Td>
        <Td align="right" className="whitespace-nowrap">
          {/* Editable in place: the store counting a shelf is the single most
              common thing that happens on this screen, and making somebody go
              to a masters page to type one number is how it stops happening. */}
          <span onClick={(e) => e.stopPropagation()}>
            <EditableNumber
              value={row.qty_on_hand}
              min={0}
              step="any"
              width="w-24"
              placeholder="not counted"
              allowEmpty
              onCommit={(qty) =>
                setStock.mutate({ materialCode: row.material_code, qtyOnHand: qty })
              }
            />
          </span>
        </Td>
        <Td align="right">
          <Tag tone={TONE[row.status]}>
            {row.status === 'short'
              ? formatNumber(row.shortfall, 2)
              : row.status}
          </Tag>
        </Td>
        <Td>{row.counted_on ? formatDate(row.counted_on) : '—'}</Td>
        <Td>{formatDate(row.first_needed_on)}</Td>
      </tr>

      {open ? (
        <tr>
          <td colSpan={7} className="bg-paper/60 px-3 py-2">
            {jobs.data?.length ? (
              <div className="space-y-1 text-caption">
                {jobs.data.map((j, i) => (
                  <div key={i} className="text-mid flex flex-wrap gap-x-4">
                    <span className="font-semibold">{j.erp_order_no}</span>
                    <span>{j.article_code}</span>
                    <span>{j.department_name}</span>
                    <span>
                      {formatNumber(j.qty_required, 2)} {j.uom}
                    </span>
                    <span className="text-faint">
                      needed {formatDate(j.needed_on)} · order by{' '}
                      {formatDate(j.order_by)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-faint text-caption">Loading…</p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}
