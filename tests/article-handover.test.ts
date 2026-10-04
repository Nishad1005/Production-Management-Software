// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
// @ts-expect-error — a plain .mjs script module, shared with the CLI loader.
import { buildMasters } from '../scripts/lib/um-sample.mjs'
import { withRollback } from './helpers/db'
import { importMastersOnSeed } from './helpers/fixtures'

/**
 * `article_handover`, old text against new, on the route that broke it.
 *
 * The view says which department hands work to which for each article. Its
 * reduction to nearest neighbours was a correlated `not exists` over a CTE —
 * quadratic in the number of reachable pairs — and on the hosted project it
 * stopped answering inside eight seconds the day the route went from fourteen
 * departments to twenty. `20261003090000` rewrote it as a left-join anti-join,
 * which did not help; `20261003100000` made the last query a set difference
 * (`except`), which did.
 *
 * The rewrite must return **exactly** what the original returned. So this
 * takes the original view's text straight out of the migration that created
 * it, installs it beside the new one under another name, and compares the two
 * on a database shaped like the hosted one: U&M's twenty-department route,
 * their six sample products, and sixty-six more articles on the fourteen
 * production departments.
 *
 * **There is no timing assertion here, deliberately.** Both versions take about
 * four milliseconds on this database: tests run as the table owner, no
 * row-level policy is paid, and the planner is free to turn the `not exists`
 * into a hash anti-join. The original was cancelled at eight seconds on the
 * hosted project all the same. A local timing check could only ever pass, so
 * the measurement belongs to `verify:live`, which times this view as a
 * signed-in user — the one place the cost exists.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/** The view as first written, renamed so it can sit beside its replacement. */
function originalView(): string {
  const src = readFileSync(
    `${root}supabase/migrations/20260812140000_wip_ledger.sql`,
    'utf8',
  )
  const from = src.indexOf('create view public.article_handover')
  const to = src.indexOf('comment on view public.article_handover')
  return src
    .slice(from, to)
    .replace('create view public.article_handover', 'create view public.article_handover_old')
}

async function hostedShape(c: pg.Client) {
  const sheet = JSON.parse(
    readFileSync(`${root}scripts/data/um-sample-sheet.json`, 'utf8'),
  )
  await importMastersOnSeed(c, buildMasters(sheet))

  // Sixty-six further articles on the production departments only, as the
  // hosted project carries them: one component per department, one rate each.
  await c.query(`
    insert into articles (code, name)
    select 'P' || i, 'Placeholder ' || i from generate_series(1, 66) i;

    insert into components (code, name)
    select a.code || '::' || d.code, d.code || ' work on ' || a.code
      from articles a
      join departments d
        on d.code in ('PLYCUT','MACHINE','ASSY','SAND','WOODFIN','METALFIN','FOAM',
                      'FIBER','CUT','STITCH','STAPLE','FIT','QC','PACK')
     where a.code like 'P%' and a.name like 'Placeholder %';

    insert into article_bom (article_id, component_id, qty_per_unit)
    select a.id, c.id, 1
      from articles a
      join components c on c.code like a.code || '::%'
     where a.name like 'Placeholder %';

    insert into component_rates (component_id, department_id, shift_id, units_per_day)
    select c.id, d.id, (select id from shifts where code = 'GEN'), 100
      from articles a
      join components c on c.code like a.code || '::%'
      join departments d on d.code = split_part(c.code, '::', 2)
     where a.name like 'Placeholder %';
  `)
  await c.query(originalView())

  /*
   * Statistics, and a ceiling.
   *
   * Without them this test reproduced the production failure it was written
   * about. The original view's `not exists` is planned as a hash anti-join
   * when the planner knows how big the CTEs are and as a nested loop when it
   * does not — four milliseconds or more than a minute, on the same rows. In
   * the full suite, with no `analyze` since the fixture loaded, it sometimes
   * took the second plan, ran for over sixty seconds holding every key the
   * seed inserts, and seven unrelated tests timed out queueing behind it.
   *
   * `analyze` gives the planner what it needs. The timeout is for the day it
   * is not enough: a runaway is cancelled by the server in twenty seconds and
   * reported here, instead of outliving the test that started it.
   */
  await c.query('analyze')
  await c.query(`set local statement_timeout = '20s'`)
}

const pairsOf = async (c: pg.Client, view: string) =>
  (
    await c.query<{ article: string; from_code: string; to_code: string }>(
      `select a.code as article, f.code as from_code, t.code as to_code
         from ${view} h
         join articles a on a.id = h.article_id
         join departments f on f.id = h.from_department_id
         join departments t on t.id = h.to_department_id
        order by 1, 2, 3`,
    )
  ).rows

describe('article_handover, rewritten', () => {
  it('returns exactly what the original returned', async () => {
    await withRollback(async (c) => {
      await hostedShape(c)
      const before = await pairsOf(c, 'article_handover_old')
      const after = await pairsOf(c, 'article_handover')

      // Seventy-two articles' worth and the seed's own, or this compares two
      // empty lists.
      expect(new Set(before.map((r) => r.article)).size).toBeGreaterThanOrEqual(72)
      expect(after).toEqual(before)
    })
  })

  it('still reduces to nearest neighbours', async () => {
    await withRollback(async (c) => {
      await hostedShape(c)
      const rows = await pairsOf(c, 'article_handover')
      const edges = rows
        .filter((r) => r.article === '676313')
        .map((r) => `${r.from_code}>${r.to_code}`)

      // Machining feeds assembly directly, and assembly feeds sanding — so
      // machining reaches sanding, but only by way of assembly. The direct
      // pair is in the closure and must not survive the reduction.
      expect(edges).toContain('MACHINE>ASSY')
      expect(edges).toContain('ASSY>SAND')
      expect(edges).not.toContain('MACHINE>SAND')
    })
  })
})
