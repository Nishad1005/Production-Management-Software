import { useState } from 'react'
import { useAcceptanceCheck, useArticles } from '@/data/planning'
import { Button, Field, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { BREACH_EXPLAINER, BREACH_LABEL, formatDateLong, formatNumber, inputClass } from '@/components/format'

/**
 * Spec §14: "A merchandiser enters a proposed article, quantity and stuffing
 * date. Kram provisionally schedules it against the live book and reports which
 * departments breach and when. Everything else finds problems after the
 * commitment; this finds them before, which makes it the highest-value screen
 * in the product."
 */
export function Acceptance() {
  const articles = useArticles()
  const check = useAcceptanceCheck()

  const [articleId, setArticleId] = useState('')
  const [qty, setQty] = useState('250')
  const [stuffingDate, setStuffingDate] = useState('2026-12-15')

  const chosenArticle = articleId || articles.data?.[0]?.id || ''
  const rows = check.data ?? []
  const breaches = rows.filter((r) => !r.is_feasible)
  const answered = check.isSuccess && rows.length > 0

  return (
    <div className="space-y-6">
      <Panel title="Can we take this order?" meta="Checked against the live book">
        <p className="text-mid mb-4 max-w-[80ch] text-[12px]">
          The proposed line is scheduled provisionally alongside everything
          already committed, and then removed again — nothing is added to the
          order book. What comes back is which departments break, and why.
        </p>

        <form
          className="grid items-end gap-4 sm:grid-cols-[1fr_140px_180px_auto]"
          onSubmit={(e) => {
            e.preventDefault()
            check.mutate({
              articleId: chosenArticle,
              qty: Number(qty),
              stuffingDate,
            })
          }}
        >
          <Field label="Article">
            <select
              className={inputClass}
              value={chosenArticle}
              onChange={(e) => setArticleId(e.target.value)}
            >
              {articles.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity">
            <input
              className={inputClass}
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
          <Field label="Stuffing date">
            <input
              className={inputClass}
              type="date"
              value={stuffingDate}
              onChange={(e) => setStuffingDate(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={check.isPending || !chosenArticle}>
            {check.isPending ? 'Checking…' : 'Check'}
          </Button>
        </form>
      </Panel>

      {answered ? (
        <Panel
          title={breaches.length ? 'Not as it stands' : 'Yes'}
          meta={`${formatNumber(Number(qty))} units stuffing ${formatDateLong(stuffingDate)}`}
        >
          <div
            className={`mb-4 border-l-[3px] py-1 pl-4 ${
              breaches.length ? 'border-flag' : 'border-clear'
            }`}
          >
            <p className="font-sans text-[15px] font-semibold">
              {breaches.length
                ? `${breaches.length} of ${rows.length} steps cannot be made to this date.`
                : 'Every department can make this within its window.'}
            </p>
            <p className="text-mid mt-1 max-w-[75ch] text-[12px]">
              {breaches.length
                ? 'Kram reports the shortfall. Whether to run overtime, resequence, subcontract or move the date is a production decision resting on material, cash and the customer relationship — none of which the system can see.'
                : 'Scheduled against everything already committed, with no day pushed over capacity.'}
            </p>
          </div>

          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>Component</Th>
                <Th align="right">Must make</Th>
                <Th>Starts</Th>
                <Th>Due</Th>
                <Th>Verdict</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.department_code}-${r.component_code}`}>
                  <Td>{r.department_code}</Td>
                  <Td>{r.component_code}</Td>
                  <Td align="right">{formatNumber(r.qty_required, 0)}</Td>
                  <Td>{formatDateLong(r.start_date)}</Td>
                  <Td>{formatDateLong(r.due_date)}</Td>
                  <Td>
                    {r.is_feasible ? (
                      <Tag tone="clear">Clear</Tag>
                    ) : (
                      <span className="flex flex-col gap-1">
                        <span>
                          <Tag tone="flag">
                            {BREACH_LABEL[r.breach_reason ?? ''] ??
                              r.breach_reason}
                          </Tag>
                        </span>
                        <span className="text-mid text-[11px]">
                          {BREACH_EXPLAINER[r.breach_reason ?? '']}
                        </span>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <p className="text-faint mt-4 text-[11.5px]">
            Quantities are inflated for yield — each department must make enough
            that the shipped quantity survives every loss downstream of it.
          </p>
        </Panel>
      ) : null}

      {check.isError ? (
        <Panel title="The check failed">
          <pre className="text-flag overflow-x-auto text-[11.5px] whitespace-pre-wrap">
            {String(check.error)}
          </pre>
        </Panel>
      ) : null}
    </div>
  )
}
