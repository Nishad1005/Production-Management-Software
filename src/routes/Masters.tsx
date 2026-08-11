import {
  useBom,
  useDepartments,
  useDminus,
  useRates,
} from '@/data/planning'
import { Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatNumber } from '@/components/format'

/**
 * Read-only for the draft. These are the numbers every schedule run depends on,
 * so showing them is most of the value — editing them is the next piece of work.
 */
export function Masters() {
  const departments = useDepartments()
  const rates = useRates()
  const dminus = useDminus()
  const bom = useBom()

  const articles = [...new Set(dminus.data?.map((d) => d.article_code) ?? [])]
  const routeCodes = [
    ...new Map(
      (dminus.data ?? []).map((d) => [d.department_code, d.route_position]),
    ),
  ]
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code)

  return (
    <div className="space-y-6">
      <Panel title="Production route" meta="Placeholder — to be replaced by PPC">
        <p className="text-mid mb-3 max-w-[80ch] text-[12px]">
          Departments are a configurable master, not hardcoded. The route below
          is the illustrative one from the capacity-flagging prototype; U&M's
          real route is around seven departments.
        </p>
        <Table>
          <thead>
            <tr>
              <Th align="right">#</Th>
              <Th>Code</Th>
              <Th>Department</Th>
              <Th align="right">Yield</Th>
              <Th>Shifts</Th>
              <Th align="right">Sanctioned headcount</Th>
            </tr>
          </thead>
          <tbody>
            {departments.data?.map((d) => (
              <tr key={d.id}>
                <Td align="right" className="text-faint">
                  {d.route_position}
                </Td>
                <Td className="font-semibold">{d.code}</Td>
                <Td>{d.name}</Td>
                <Td align="right">{d.yield_pct}%</Td>
                <Td>{d.shifts ?? '—'}</Td>
                <Td align="right">{formatNumber(d.headcount)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
          Yield compounds backwards: a department must make the shipped quantity
          divided by its own yield and the yield of every department after it.
          Five departments at 98% each cost roughly a tenth of factory capacity.
        </p>
      </Panel>

      <Panel title="D-minus matrix" meta="Days before stuffing, per article × department">
        <Table>
          <thead>
            <tr>
              <Th>Article</Th>
              {routeCodes.map((code) => (
                <Th key={code} align="right">
                  {code}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {articles.map((article) => (
              <tr key={article}>
                <Td className="font-semibold">{article}</Td>
                {routeCodes.map((code) => {
                  const cell = dminus.data?.find(
                    (d) => d.article_code === article && d.department_code === code,
                  )
                  return (
                    <Td key={code} align="right">
                      {cell?.is_complete ? (
                        `D-${cell.dminus_days}`
                      ) : (
                        <Tag tone="flag">Missing</Tag>
                      )}
                    </Td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-faint mt-3 max-w-[80ch] text-[11.5px]">
          Each article takes a different time through each department, so the
          offset is held per pair and entered by hand. A blank cell blocks
          scheduling for that article rather than defaulting to zero — a silent
          zero would produce an impossible schedule that looks entirely normal.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Component rates" meta="Units per day, per shift">
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>Component</Th>
                <Th>Shift</Th>
                <Th align="right">Per day</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {rates.data?.map((r) => (
                <tr key={`${r.department_code}-${r.component_code}-${r.shift_code}`}>
                  <Td>{r.department_code}</Td>
                  <Td>{r.component_code}</Td>
                  <Td>{r.shift_code}</Td>
                  <Td align="right">{formatNumber(r.units_per_day)}</Td>
                  <Td>
                    {r.is_measured ? (
                      <Tag tone="clear">Measured</Tag>
                    ) : (
                      <Tag tone="amber">Estimated</Tag>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-faint mt-3 text-[11.5px]">
            A rate is what the department makes in a day{' '}
            <em>doing nothing else</em>. That is what lets utilisation be added
            across components, and it is the convention real figures must be
            entered against. Rates become measured once derived from actuals
            rather than estimated.
          </p>
        </Panel>

        <Panel title="Bill of materials" meta="Components per finished unit">
          <Table>
            <thead>
              <tr>
                <Th>Article</Th>
                <Th>Component</Th>
                <Th>Description</Th>
                <Th align="right">Per unit</Th>
              </tr>
            </thead>
            <tbody>
              {bom.data?.map((b) => (
                <tr key={`${b.article_code}-${b.component_code}`}>
                  <Td>{b.article_code}</Td>
                  <Td className="font-semibold">{b.component_code}</Td>
                  <Td className="text-mid">{b.component_name}</Td>
                  <Td align="right">{b.qty_per_unit}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-faint mt-3 text-[11.5px]">
            Departments produce components, not chairs. A chair is ready only
            when the scarcest component is: everything else is stranded stock —
            real material and real labour producing nothing shippable.
          </p>
        </Panel>
      </div>
    </div>
  )
}
