// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withClient, withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The client reads through views and writes through functions, because
 * PostgREST exposes those and not arbitrary SQL. These tests cover the write
 * functions' behaviour and check that every view a screen depends on exists —
 * a missing one is a blank screen, and the build will not catch it.
 */

const VIEWS = [
  'bom_master',
  'component_rate_master',
  'department_master',
  'department_shift_grid',
  'dminus_matrix',
  'heatmap_cell',
  'load_detail',
  'order_book',
  'order_qty_reconciliation',
  'pin_list',
  'run_history',
  'schedule_bottleneck',
  'schedule_component_load',
  'schedule_department_day',
  'schedule_flag_triage',
  'schedule_gantt',
  'schedule_idle_capacity',
  'schedule_kpis',
  'shift_master',
]

describe('the read surface', () => {
  it('exposes every view a screen depends on', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.views
          where table_schema = 'public' order by table_name`,
      ),
    )
    const present = rows.map((r) => r.table_name)
    expect(VIEWS.filter((v) => !present.includes(v))).toEqual([])
  })

  it('every view is queryable', async () => {
    // A view that references a dropped column parses fine and fails at select.
    await withClient(async (c) => {
      for (const view of VIEWS) {
        await expect(
          c.query(`select * from ${view} limit 1`),
          `${view} is not queryable`,
        ).resolves.toBeDefined()
      }
    })
  })
})

describe('the client stays portable', () => {
  /**
   * The offline build runs PGlite, which happily executes any SQL it is given.
   * Supabase does not: PostgREST exposes tables, views and functions and
   * nothing else. A raw INSERT in the client works perfectly today and cannot
   * work at all the moment the backend moves — so it fails here instead, while
   * the fix is one function away.
   */
  it('issues no raw DML — every write goes through a function', async () => {
    const dir = join(repoRoot, 'src', 'data')
    const offenders: string[] = []

    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts')) continue
      const source = await readFile(join(dir, file), 'utf8')
      for (const [i, line] of source.split('\n').entries()) {
        // Comments describe the rules; only executable SQL matters.
        if (/^\s*(\*|\/\/)/.test(line)) continue
        if (/\b(insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('master writes', () => {
  it('clearing a D-minus value puts the cell back to incomplete', async () => {
    await withRollback(async (c) => {
      await applySeed(c)

      await c.query(`select set_dminus('AARA-LC', 'WOOD', 64)`)
      let { rows } = await c.query<{ d: number; complete: boolean }>(
        `select dminus_days as d, is_complete as complete from dminus_matrix
          where article_code = 'AARA-LC' and department_code = 'WOOD'`,
      )
      expect(rows[0]).toEqual({ d: 64, complete: true })

      await c.query(`select set_dminus('AARA-LC', 'WOOD', null)`)
      ;({ rows } = await c.query(
        `select dminus_days as d, is_complete as complete from dminus_matrix
          where article_code = 'AARA-LC' and department_code = 'WOOD'`,
      ))
      // Not zero — blank, which stops the article scheduling on purpose.
      expect(rows[0]).toEqual({ d: null, complete: false })
    })
  })

  it('switching a shift on copies rates and establishment across', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_shift_active(
        (select id from shifts where code = 'A'), true)`)
      await c.query(`select set_department_shift('STITCH', 'A', true)`)

      const { rows } = await c.query<{
        is_active: boolean
        sanctioned_headcount: number
        rate_count: number
      }>(
        `select is_active, sanctioned_headcount, rate_count
           from department_shift_grid
          where department_code = 'STITCH' and shift_code = 'A'`,
      )

      expect(rows[0].is_active).toBe(true)
      // Copied from the General shift rather than starting at zero.
      expect(rows[0].sanctioned_headcount).toBe(12)
      expect(rows[0].rate_count).toBeGreaterThan(0)
    })
  })

  it('switching a shift off leaves its rates alone', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_shift_active(
        (select id from shifts where code = 'A'), true)`)
      await c.query(`select set_department_shift('STITCH', 'A', true)`)
      await c.query(`select set_department_shift('STITCH', 'A', false)`)

      const { rows } = await c.query<{
        is_active: boolean
        rate_count: number
      }>(
        `select is_active, rate_count from department_shift_grid
          where department_code = 'STITCH' and shift_code = 'A'`,
      )
      // Off, but the rates survive so switching it back on is not destructive.
      expect(rows[0].is_active).toBe(false)
      expect(rows[0].rate_count).toBeGreaterThan(0)
    })
  })
})

describe('order writes', () => {
  it('creates an order with its first shipment line', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into customers (code, name) values ('C1', 'Test customer')`,
      )

      const { rows } = await c.query<{ id: string }>(
        `select create_order('SO-1',
           (select id from customers where code = 'C1'),
           (select id from articles where code = 'AARA-LC'),
           200, '2026-12-01'::date) as id`,
      )

      const { rows: book } = await c.query<{
        line_count: string
        breaches: number
      }>(`select line_count, breaches from order_book where order_id = $1`, [
        rows[0].id,
      ])
      expect(Number(book[0].line_count)).toBe(1)

      await c.query(
        `select add_shipment_line($1, 100, '2027-01-15'::date)`,
        [rows[0].id],
      )
      const { rows: after } = await c.query<{ line_count: string }>(
        `select line_count from order_book where order_id = $1`,
        [rows[0].id],
      )
      expect(Number(after[0].line_count)).toBe(2)
    })
  })
})

describe('pin writes', () => {
  it('creates, replaces and releases a pin', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(
        `insert into customers (code, name) values ('C1', 'Test customer')`,
      )
      const { rows } = await c.query<{ id: string }>(
        `select create_order('SO-1',
           (select id from customers where code = 'C1'),
           (select id from articles where code = 'AARA-LC'),
           200, '2026-12-01'::date) as id`,
      )
      const { rows: line } = await c.query<{ id: string }>(
        `select id from shipment_lines where order_id = $1`,
        [rows[0].id],
      )

      await c.query(
        `select create_pin($1, 'STITCH', 'COVER', '2026-10-01'::date, 'Start early')`,
        [line[0].id],
      )
      let pins = await c.query<{ reason: string; pinned_start_date: string }>(
        `select reason, pinned_start_date::text from pin_list`,
      )
      expect(pins.rows).toHaveLength(1)
      expect(pins.rows[0].reason).toBe('Start early')

      // Pinning the same task again moves it rather than adding a second pin.
      await c.query(
        `select create_pin($1, 'STITCH', 'COVER', '2026-10-08'::date, 'Moved again')`,
        [line[0].id],
      )
      pins = await c.query(
        `select reason, pinned_start_date::text from pin_list`,
      )
      expect(pins.rows).toHaveLength(1)
      expect(pins.rows[0].reason).toBe('Moved again')

      await c.query(`select release_pin($1, 'STITCH', 'COVER')`, [line[0].id])
      pins = await c.query(
        `select reason, pinned_start_date::text from pin_list`,
      )
      expect(pins.rows).toHaveLength(0)

      // Released, not deleted — the record of who moved what survives.
      const { rows: history } = await c.query<{ n: string }>(
        `select count(*) as n from schedule_pins where not is_active`,
      )
      expect(Number(history[0].n)).toBe(1)
    })
  })
})
