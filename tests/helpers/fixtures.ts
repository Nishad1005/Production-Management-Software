import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Applies the placeholder seed: 4 departments, one article, six components. */
export async function applySeed(client: pg.Client): Promise<void> {
  await client.query(
    await readFile(join(repoRoot, 'supabase', 'seed.sql'), 'utf8'),
  )
}

/**
 * The demonstration data, on U&M's fourteen departments. Applied on top of the
 * seed, exactly as the offline build applies it — `src/lib/database.ts` sorts
 * the two files and gets them in this order.
 */
export async function applyDemoSeed(client: pg.Client): Promise<void> {
  await client.query(
    await readFile(join(repoRoot, 'supabase', 'seed_demo.sql'), 'utf8'),
  )
}

export type OrderSpec = {
  erpOrderNo?: string
  articleCode?: string
  qty: number
  stuffingDate: string
  materialReadyDate?: string | null
  confidence?: 'confirmed' | 'probable' | 'forecast'
}

/** Creates a customer, order and single shipment line. Returns the line id. */
export async function createOrder(
  client: pg.Client,
  spec: OrderSpec,
): Promise<string> {
  const {
    erpOrderNo = `SO-${Math.round(spec.qty)}-${spec.stuffingDate}`,
    articleCode = 'AARA-LC',
    materialReadyDate = null,
    confidence = 'confirmed',
  } = spec

  await client.query(
    `insert into customers (code, name) values ('CUST-1', 'Test Customer')
     on conflict (code) do nothing`,
  )

  const { rows } = await client.query<{ id: string }>(
    `insert into orders (erp_order_no, customer_id, article_id, total_qty, confidence)
     values ($1,
             (select id from customers where code = 'CUST-1'),
             (select id from articles where code = $2),
             $3, $4::order_confidence)
     returning id`,
    [erpOrderNo, articleCode, spec.qty, confidence],
  )

  const { rows: line } = await client.query<{ id: string }>(
    `insert into shipment_lines (order_id, line_no, qty, stuffing_date, material_ready_date)
     values ($1, 1, $2, $3, $4) returning id`,
    [rows[0].id, spec.qty, spec.stuffingDate, materialReadyDate],
  )

  return line[0].id
}

/** Runs the engine and returns the run id. */
export async function runSchedule(
  client: pg.Client,
  opts: { makeCurrent?: boolean; note?: string } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `select run_schedule(
       array['confirmed','probable']::order_confidence[], $1, $2) as id`,
    [opts.makeCurrent ?? true, opts.note ?? null],
  )
  return rows[0].id
}

/**
 * U&M's department codes, in the order `seed_demo.sql` inserts them.
 *
 * Every test runs inside its own transaction against one shared database, and
 * a row inserted under a unique key holds that key until the transaction ends.
 * Two tests inserting the same department codes therefore queue behind each
 * other — which is fine — unless they take the codes in *different orders*, in
 * which case each ends up waiting on a key the other holds and Postgres kills
 * one of them. The first fixtures built from U&M's planning sheet inserted
 * Assembly before Stitching, the seed inserts Stitching before Assembly, and
 * seven unrelated tests timed out behind the resulting deadlocks.
 *
 * So anything that loads these departments does it through here: the seed
 * first, which takes its keys in the order every other test does, and then the
 * rest in the order the demonstration seed uses.
 */
const DEMO_DEPARTMENT_ORDER = [
  'PLYCUT', 'MACHINE', 'ASSY', 'SAND', 'WOODFIN', 'METALFIN', 'FOAM', 'FIBER',
  'CUT', 'STITCH', 'STAPLE', 'FIT', 'QC', 'PACK',
]

type MastersFile = {
  kram_masters: number
  tables: { departments?: { code: string }[]; [table: string]: unknown }
}

/** Applies the seed, then a masters file, taking shared keys in seed order. */
export async function importMastersOnSeed(
  client: pg.Client,
  masters: MastersFile,
): Promise<void> {
  await applySeed(client)
  const rank = (code: string) => {
    const i = DEMO_DEPARTMENT_ORDER.indexOf(code)
    return i === -1 ? DEMO_DEPARTMENT_ORDER.length : i
  }
  const ordered = {
    ...masters,
    tables: {
      ...masters.tables,
      departments: [...(masters.tables.departments ?? [])].sort(
        (a, b) => rank(a.code) - rank(b.code),
      ),
    },
  }
  await client.query(`select import_masters($1::jsonb)`, [JSON.stringify(ordered)])
}

/**
 * A date a number of days from today, as the database will see it.
 *
 * For anything read through a view that compares against `current_date` —
 * alerts, ordering dates, shipment risk. Those tests were first written with
 * fixed dates that were comfortably in the future in August; by October the
 * calendar had walked past them and three tests failed without a line of code
 * having changed. A fixed date in such a test is a timer, not a fixture.
 *
 * (Engine tests are different and keep their fixed dates: the engine never
 * looks at today, and its expectations are exact calendar arithmetic.)
 */
export function inDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
