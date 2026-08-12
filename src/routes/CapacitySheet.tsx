import { useMemo, useState } from 'react'
import {
  useCapacitySheet,
  useRouteConflicts,
  useSetCapacityCell,
  useSetCellDminus,
  type CapacityCell,
  type RouteConflict,
} from '@/data/capacity'
import { Empty, Metric, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { inputClass } from '@/components/format'
import { EditableNumber } from '@/components/edit'

/**
 * U&M's capacity sheet, as a screen.
 *
 * Their spreadsheet is one row per SKU with Manpower and Units per department —
 * seventy articles against fourteen departments, and every figure still blank.
 * This is the same grid, writing where the engine reads.
 *
 * One measure at a time, deliberately. Three numbers in each of 980 cells is not
 * a grid anyone can read; one number is a matrix you can scan down a column and
 * see where the gaps are.
 */

const MEASURES = [
  {
    key: 'units' as const,
    label: 'Units per day',
    hint: 'What the department makes in a day working only this article',
  },
  {
    key: 'manpower' as const,
    label: 'Manpower',
    hint: 'People needed to reach that figure',
  },
  {
    key: 'dminus' as const,
    label: 'D-minus',
    hint: 'Days before the stuffing date this department must finish',
  },
]

export function CapacitySheet() {
  const sheet = useCapacitySheet()
  const conflicts = useRouteConflicts()
  const setCell = useSetCapacityCell()
  const setDminus = useSetCellDminus()

  const [measure, setMeasure] = useState<'units' | 'manpower' | 'dminus'>('units')
  const [filter, setFilter] = useState('')

  const model = useMemo(() => {
    const rows = sheet.data ?? []
    const departments = [
      ...new Map(
        rows.map((r) => [
          r.department_code,
          { code: r.department_code, name: r.department_name, position: r.route_position },
        ]),
      ).values(),
    ].sort((a, b) => a.position - b.position)

    const articles = [
      ...new Map(rows.map((r) => [r.article_code, r.article_name])).values(),
    ]
    const articleCodes = [...new Set(rows.map((r) => r.article_code))]

    const byKey = new Map(
      rows.map((r) => [`${r.article_code}|${r.department_code}`, r]),
    )

    return { departments, articles, articleCodes, byKey, rows }
  }, [sheet.data])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return model.articleCodes
    return model.articleCodes.filter((code) => {
      const name = model.byKey.get(`${code}|${model.departments[0]?.code}`)
        ?.article_name
      return (
        code.toLowerCase().includes(needle) ||
        (name ?? '').toLowerCase().includes(needle)
      )
    })
  }, [filter, model])

  const progress = useMemo(() => {
    const rows = model.rows
    const withUnits = rows.filter((r) => r.units_per_day !== null)
    return {
      pairings: withUnits.length,
      missingManpower: withUnits.filter((r) => r.manpower === null).length,
      missingDminus: withUnits.filter((r) => !r.dminus_complete).length,
      articlesRouted: new Set(withUnits.map((r) => r.article_code)).size,
      articles: model.articleCodes.length,
    }
  }, [model])

  function valueOf(cell: CapacityCell | undefined) {
    if (!cell) return null
    if (measure === 'units') return cell.units_per_day
    if (measure === 'manpower') return cell.manpower
    return cell.dminus_complete ? cell.dminus_days : null
  }

  function commit(
    articleCode: string,
    cell: CapacityCell | undefined,
    next: number | null,
  ) {
    const departmentCode = cell?.department_code
    if (!departmentCode) return

    if (measure === 'dminus') {
      setDminus.mutate({ articleCode, departmentCode, days: next })
      return
    }
    if (measure === 'manpower') {
      // Manpower hangs off a rate, so there has to be one to hang it on.
      if (cell.units_per_day === null) return
      setCell.mutate({
        articleCode,
        departmentCode,
        units: cell.units_per_day,
        manpower: next,
      })
      return
    }
    setCell.mutate({
      articleCode,
      departmentCode,
      units: next,
      manpower: cell.manpower,
    })
  }

  const active = MEASURES.find((m) => m.key === measure)!

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Articles routed"
          value={`${progress.articlesRouted} / ${progress.articles}`}
          hint="Have at least one department"
          tone={progress.articlesRouted === progress.articles ? 'clear' : 'amber'}
        />
        <Metric label="Department pairings" value={progress.pairings} hint="Cells with a rate" />
        {/*
          A green zero here would read as "nothing missing" when the truth is
          "nothing entered" — these count what is absent from routed cells, and
          with no routed cells there is nothing to be absent from. An em dash
          says so.
        */}
        <Metric
          label="Missing manpower"
          value={progress.pairings ? progress.missingManpower : '—'}
          tone={
            !progress.pairings ? 'ink' : progress.missingManpower ? 'amber' : 'clear'
          }
          hint={
            progress.pairings ? 'Rate entered, crew size not' : 'Nothing routed yet'
          }
        />
        <Metric
          label="Missing D-minus"
          value={progress.pairings ? progress.missingDminus : '—'}
          tone={
            !progress.pairings ? 'ink' : progress.missingDminus ? 'flag' : 'clear'
          }
          hint={
            progress.pairings
              ? 'Blocks that article from scheduling'
              : 'Nothing routed yet'
          }
        />
      </div>

      {conflicts.data?.length ? <RouteConflicts rows={conflicts.data} /> : null}

      <Panel
        title="Capacity sheet"
        meta={`${model.articleCodes.length} articles × ${model.departments.length} departments`}
      >
        <p className="text-mid mb-4 max-w-[85ch] text-[12px]">
          The same grid as the capacity spreadsheet, writing where the engine
          reads it. A <strong>units</strong> figure means the article passes
          through that department at that rate; a blank means it does not go
          there at all. Clearing a figure removes the step.
        </p>

        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div>
            <span className="label block pb-1">Showing</span>
            <div className="flex gap-2">
              {MEASURES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  title={m.hint}
                  onClick={() => setMeasure(m.key)}
                  className={`rounded-[2px] border px-2.5 py-1.5 text-[12px] ${
                    measure === m.key
                      ? 'border-blue text-blue bg-white font-semibold'
                      : 'border-rule text-mid hover:border-blue'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="label block pb-1">Find an article</span>
            <input
              className={`${inputClass} w-64`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Code or name"
            />
          </label>
          <p className="text-faint pb-2 text-[11.5px]">{active.hint}</p>
        </div>

        {!model.articleCodes.length ? (
          <Empty>
            No articles yet. Load the capacity sheet, or add one from Masters.
          </Empty>
        ) : (
          <div className="border-rule overflow-x-auto border">
            <table
              data-testid="capacity-grid"
              className="nums min-w-max border-collapse text-[12px]"
            >
              <thead>
                <tr>
                  <th className="bg-sheet border-rule-soft sticky left-0 z-10 border-r border-b px-2 py-2 text-left">
                    <span className="label">Article</span>
                  </th>
                  {model.departments.map((d) => (
                    <th
                      key={d.code}
                      title={`${d.name} — position ${d.position}`}
                      className="text-blue border-rule-soft border-b px-1 py-2 text-[10px] tracking-[0.06em] whitespace-nowrap uppercase"
                    >
                      {d.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((code) => {
                  const first = model.byKey.get(
                    `${code}|${model.departments[0]?.code}`,
                  )
                  return (
                    <tr key={code} className="hover:bg-paper">
                      <td className="bg-sheet border-rule-soft sticky left-0 z-10 max-w-[280px] border-r border-b px-2 py-1.5">
                        <div className="font-semibold">{code}</div>
                        <div className="text-faint truncate text-[10.5px]">
                          {first?.article_name}
                        </div>
                      </td>
                      {model.departments.map((d) => {
                        const cell = model.byKey.get(`${code}|${d.code}`)
                        const routed = cell?.units_per_day !== null
                        return (
                          <td
                            key={d.code}
                            className={`border-rule-soft border-b px-1 py-1.5 text-right ${
                              routed ? '' : 'bg-paper/40'
                            }`}
                          >
                            <EditableNumber
                              value={valueOf(cell)}
                              placeholder={routed ? '—' : '·'}
                              allowEmpty
                              min={0}
                              width="w-16"
                              onCommit={(next) => commit(code, cell, next)}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {filter && visible.length === 0 ? (
          <Empty>Nothing matches “{filter}”.</Empty>
        ) : null}

        <div className="text-mid mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px]">
          <span className="flex items-center gap-1.5">
            <span className="border-rule-soft inline-block h-3 w-3 border" />
            Routed through here
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-paper/40 border-rule-soft inline-block h-3 w-3 border" />
            Does not go here
          </span>
          {measure === 'manpower' ? (
            <Tag tone="amber">Manpower needs a units figure first</Tag>
          ) : null}
        </div>

        <p className="text-faint mt-3 max-w-[85ch] text-[11.5px]">
          A units figure is what the department makes in a day working{' '}
          <em>only</em> that article. That is what lets a department's day be
          added up correctly when it is making several things at once — and it is
          the one convention worth getting right, because entering the everyday
          figure instead makes a department look like the factory's bottleneck
          when it is not.
        </p>
      </Panel>
    </div>
  )
}


/**
 * The route is a single line, so the engine treats whichever department sits at
 * the previous position as the one that must finish first. When a D-minus says
 * otherwise, it holds work back behind something not yet due and raises breaches
 * that are not real — on a screen whose whole job is raising breaches.
 *
 * Reported, never corrected. Two figures a person entered disagree, and which of
 * them is wrong is not ours to decide.
 */
function RouteConflicts({ rows }: { rows: RouteConflict[] }) {
  const biting = rows.filter((r) => r.affects_scheduling)

  return (
    <Panel
      title="Route order and D-minus disagree"
      meta={`${rows.length} to look at`}
    >
      <p className="text-mid mb-4 max-w-[85ch] text-[12px]">
        Each row below has a department that must finish <em>before</em> one
        placed ahead of it in the route. Either the route order is wrong, or the
        D-minus is — the software will not guess which.
        {biting.length ? (
          <>
            {' '}
            <strong>{biting.length}</strong> of these affect scheduling now and
            will show as runway breaches that are not real.
          </>
        ) : (
          ' None of them affects scheduling yet, because the articles do not pass through both departments.'
        )}
      </p>

      <Table>
        <thead>
          <tr>
            <Th>Article</Th>
            <Th>Comes first in the route</Th>
            <Th>But must finish before it</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r) => (
            <tr key={`${r.article_code}-${r.later_department_code}`}>
              <Td className="font-semibold">{r.article_code}</Td>
              <Td>
                {r.earlier_department_name}
                <span className="text-faint"> · D-{r.earlier_dminus}</span>
              </Td>
              <Td>
                {r.later_department_name}
                <span className="text-flag"> · D-{r.later_dminus}</span>
              </Td>
              <Td align="right">
                {r.affects_scheduling ? (
                  <Tag tone="flag">Causing breaches</Tag>
                ) : (
                  <Tag tone="mid">Not routed through both</Tag>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      {rows.length > 30 ? (
        <p className="text-faint mt-3 text-[11.5px]">
          Showing 30 of {rows.length}.
        </p>
      ) : null}

      <p className="text-faint mt-4 max-w-[85ch] text-[11.5px]">
        The rule: a department that has to finish earlier belongs earlier in the
        route. Move it on Masters → Production route, or change the D-minus here.
      </p>
    </Panel>
  )
}
