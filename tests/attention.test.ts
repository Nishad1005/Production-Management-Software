// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applyDemoSeed, applySeed, createOrder, inDays, runSchedule } from './helpers/fixtures'

/**
 * Phase 9 — attention.
 *
 * The view computes nothing of its own, so what needs guarding is not
 * arithmetic. It is that a finding **appears when it becomes true and goes when
 * it stops**, and that severity means something — an alert list where everything
 * is critical is a list nobody reads twice.
 */

const findings = async (c: pg.Client) =>
  (
    await c.query<{
      kind: string
      severity: string
      title: string
      detail: string
      route: string
      key: string
      days_out: number
    }>(`select * from attention`)
  ).rows

const countOf = async (c: pg.Client) =>
  (
    await c.query<{
      critical: number
      warning: number
      info: number
      total: number
    }>(`select * from attention_count`)
  ).rows[0]

describe('a quiet factory says nothing', () => {
  it('raises no alerts on a seed with no orders', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // The empty state matters: an alert list that is never empty is one
      // people stop opening.
      expect(await findings(c)).toEqual([])
      expect((await countOf(c)).total).toBe(0)
    })
  })
})

describe('material findings appear and clear', () => {
  // `shipsIn` decides which side of its ordering date the oak is on. Far out,
  // there is still time to order; close in, the date has already gone. It was a
  // fixed 1 December until that date came near enough for the ordering day to
  // pass, at which point two tests here changed their answers on their own.
  async function shortOfOak(c: pg.Client, shipsIn = 200) {
    await applySeed(c)
    await c.query(`select set_supplier('SUP-1', 'Sharma Timber', 21)`)
    await c.query(`select set_material('WD-OAK', 'Oak, 25mm', 'Wood', 'CFT', 'SUP-1')`)
    await createOrder(c, { qty: 100, stuffingDate: inDays(shipsIn) })
    await runSchedule(c)
    await c.query(`select set_article_material('AARA-LC', 'WD-OAK', 'WOOD', 2)`)
  }

  it('says nothing while the stock covers it', async () => {
    await withRollback(async (c) => {
      await shortOfOak(c)
      await c.query(`select set_material_stock('WD-OAK', 1000000)`)
      const rows = await findings(c)
      expect(rows.filter((r) => r.kind.startsWith('material'))).toEqual([])
    })
  })

  it('raises a shortage, and clears it when the store is stocked', async () => {
    await withRollback(async (c) => {
      await shortOfOak(c)
      await c.query(`select set_material_stock('WD-OAK', 1)`)

      const short = (await findings(c)).filter((r) => r.kind === 'material-short')
      expect(short).toHaveLength(1)
      expect(short[0].title).toMatch(/Oak/)
      // It names the screen that fixes it, which is the difference between an
      // alert and a complaint.
      expect(short[0].route).toBe('/material')

      await c.query(`select set_material_stock('WD-OAK', 1000000)`)
      expect(
        (await findings(c)).filter((r) => r.kind === 'material-short'),
      ).toEqual([])
    })
  })

  it('does not ask anyone to order what the store already holds', async () => {
    await withRollback(async (c) => {
      // Shipping so soon that the day to order the oak is long gone.
      await shortOfOak(c, 20)
      await c.query(`select set_material_stock('WD-OAK', 1000000)`)

      // `order_now` used to be the date alone. A store holding a million cubic
      // feet against a need for two hundred raised the most urgent alert the
      // system has — and nothing showed it until a fixture's ordering date
      // drifted into the past by itself.
      const rows = await findings(c)
      expect(rows.filter((r) => r.kind.startsWith('material'))).toEqual([])
    })
  })

  it('says the date has passed when it has and the store is short', async () => {
    await withRollback(async (c) => {
      await shortOfOak(c, 20)
      await c.query(`select set_material_stock('WD-OAK', 1)`)

      const material = (await findings(c)).filter((r) => r.kind.startsWith('material'))
      // One finding, not two: past its ordering date outranks merely short.
      expect(material).toHaveLength(1)
      expect(material[0].kind).toBe('material-late')
      expect(material[0].severity).toBe('critical')
    })
  })

  it('still says the date has passed when nobody has counted the store', async () => {
    await withRollback(async (c) => {
      // No count at all. The first fix for the test above required a count
      // that fell short, and so went quiet here too — past the ordering date,
      // stock unknown, and nothing on screen. Not knowing is not having enough.
      await shortOfOak(c, 20)

      const material = (await findings(c)).filter((r) => r.kind.startsWith('material'))
      expect(material).toHaveLength(1)
      expect(material[0].kind).toBe('material-late')
      expect(material[0].severity).toBe('critical')

      // And the screen must not be able to say "everything can still be
      // ordered in time" while that is true.
      const { rows } = await c.query<{ status: string; order_now: boolean }>(
        `select status, order_now from material_shortage where material_code = 'WD-OAK'`,
      )
      expect(rows).toEqual([{ status: 'not counted', order_now: true }])
    })
  })

  it('treats a missed ordering date as critical and a shortage as a warning', async () => {
    await withRollback(async (c) => {
      await shortOfOak(c)
      await c.query(`select set_material_stock('WD-OAK', 1)`)
      const rows = await findings(c)

      const short = rows.find((r) => r.kind === 'material-short')
      const late = rows.find((r) => r.kind === 'material-late')
      // Being short can be fixed by buying more. Being past the ordering date
      // cannot be fixed by anything, which is why only one of them is critical.
      if (late) expect(late.severity).toBe('critical')
      if (short) expect(short.severity).toBe('warning')
    })
  })

  it('says nothing about a material nobody has counted', async () => {
    await withRollback(async (c) => {
      await shortOfOak(c)
      // Stock unknown. Reporting that as a shortage would make the alert list
      // a list of shelves nobody has visited.
      const rows = await findings(c)
      expect(rows.filter((r) => r.kind === 'material-short')).toEqual([])
    })
  })
})

describe('masters findings', () => {
  it('raises an article that cannot be planned, but only once it is ordered', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article('CHAIR-9', 'Bergen Chair')`)

      // Unplannable and unordered is a tidy-up, not an alert.
      expect(
        (await findings(c)).filter((r) => r.kind === 'article-unplannable'),
      ).toEqual([])

      await createOrder(c, {
        erpOrderNo: 'SO-9',
        articleCode: 'CHAIR-9',
        qty: 10,
        stuffingDate: '2026-12-01',
      })
      const rows = (await findings(c)).filter(
        (r) => r.kind === 'article-unplannable',
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].detail).toMatch(/no route/i)
    })
  })

  it('raises a machine down today and names the cost to the day', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_machine('ST-1', 'Lockstitch 1', 'STITCH')`)
      await c.query(`select set_machine('ST-2', 'Lockstitch 2', 'STITCH')`)
      expect((await findings(c)).filter((r) => r.kind === 'machine-down')).toEqual([])

      await c.query(
        `select set_machine_downtime('ST-1', current_date, current_date, 'Timing belt')`,
      )
      const rows = (await findings(c)).filter((r) => r.kind === 'machine-down')
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toMatch(/1 of 2/)
      expect(rows[0].detail).toMatch(/50%/)
    })
  })
})

describe('the count for the header', () => {
  it('counts by severity, and agrees with the list', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_machine('ST-1', 'Lockstitch 1', 'STITCH')`)
      await c.query(
        `select set_machine_downtime('ST-1', current_date, current_date, 'Timing belt')`,
      )

      const rows = await findings(c)
      const count = await countOf(c)
      expect(count.total).toBe(rows.length)
      expect(count.warning).toBe(rows.filter((r) => r.severity === 'warning').length)
      expect(count.critical).toBe(
        rows.filter((r) => r.severity === 'critical').length,
      )
    })
  })
})

describe('every finding can be acted on', () => {
  it('names a screen and carries a stable key', async () => {
    await withRollback(async (c) => {
      // The demo factory, not the parity fixture. The fixture is a single line,
      // so no declaration is ever owed to two departments — which is exactly
      // the shape that produced two findings with the same key, and it took a
      // React warning in a browser to see it because this assertion could not.
      await applySeed(c)
      await applyDemoSeed(c)
      await runSchedule(c)
      await c.query(`select set_machine('ST-1', 'Lockstitch 1', 'STITCH')`)
      await c.query(
        `select set_machine_downtime('ST-1', current_date, current_date, 'Timing belt')`,
      )

      const rows = await findings(c)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        // A finding with nowhere to go is a complaint. A finding whose identity
        // changes every refresh cannot be deduplicated or, later, acknowledged.
        expect(r.route).toMatch(/^\//)
        expect(r.key).toContain(':')
        expect(r.title.length).toBeGreaterThan(5)
      }

      const keys = rows.map((r) => r.key)
      expect(new Set(keys).size).toBe(keys.length)
    })
  })
})

/**
 * Each finding has its own view as well as a place in the union.
 *
 * The union costs more than the API allows once row-level security is paid on
 * eight nested views, so the screen fetches the branches in parallel. That only
 * works if the two agree — a branch view that drifted from its place in the
 * union would show a finding on the screen that the list does not have, or the
 * reverse, and neither would be visible without looking at both.
 */
describe('the branches and the union say the same thing', () => {
  const BRANCHES = [
    'attention_breach',
    'attention_overloaded',
    'attention_material_late',
    'attention_material_short',
    'attention_route_conflict',
    'attention_machine_down',
    'attention_article_unplannable',
    'attention_handover',
    'attention_department_unstaffed',
  ]

  it('add up to exactly the union, on a factory with things wrong with it', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await applyDemoSeed(c)
      await runSchedule(c)
      await c.query(`select set_machine('ST-1', 'Lockstitch 1', 'STITCH')`)
      await c.query(
        `select set_machine_downtime('ST-1', current_date, current_date, 'Timing belt')`,
      )

      const union = (await c.query<{ key: string }>(`select key from attention`)).rows
      expect(union.length).toBeGreaterThan(5)

      const fromBranches: string[] = []
      for (const view of BRANCHES) {
        const { rows } = await c.query<{ key: string }>(`select key from ${view}`)
        fromBranches.push(...rows.map((r) => r.key))
      }

      expect(fromBranches.sort()).toEqual(union.map((r) => r.key).sort())
    })
  })

  it('gives every branch the same columns, so the screen can treat them alike', async () => {
    await withRollback(async (c) => {
      for (const view of BRANCHES) {
        const { rows } = await c.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_name = $1 order by ordinal_position`,
          [view],
        )
        expect(rows.map((r) => r.column_name), view).toEqual([
          'kind',
          'severity',
          'title',
          'detail',
          'route',
          'key',
          'days_out',
        ])
      }
    })
  })
})
