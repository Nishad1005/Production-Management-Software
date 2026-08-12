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
