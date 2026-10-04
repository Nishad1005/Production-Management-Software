/**
 * Loads U&M's sample planning sheet into the hosted project, and plans it.
 *
 *   node scripts/load-um-sample.mjs <email> <password>
 *
 * Take it out again with the purge that already exists — it removes whatever
 * prefix is currently marked provisional:
 *
 *   node scripts/seed-live-interim.mjs <email> <password> --purge
 *
 * ---------------------------------------------------------------------------
 * What this is.
 *
 * The first data from U&M's production management team: six rows of their
 * time-and-action sheet, sent as sample data to see it run. The figures are in
 * `scripts/data/um-sample-sheet.json`, transcribed by hand from a screenshot;
 * the translation into Kram's terms is `scripts/lib/um-sample.mjs`, which
 * `tests/um-sample-sheet.test.ts` dry-runs against a local database. This
 * script only carries the result to the hosted project.
 *
 * ---------------------------------------------------------------------------
 * What it changes on the hosted project, all of it through `import_masters`
 * in one atomic call — the same path PPC's completed workbook takes:
 *
 * - **Six checkpoint departments are added** (Wood QC, Sanding QC, Finish QC,
 *   Stitching QC, Upholstery QC, Ex-factory), each on the general shift, and
 *   the twenty are re-ordered on screen to follow the sheet's columns.
 * - **The what-feeds-what graph is replaced** by the one the sheet implies.
 *   Two links change besides the checkpoints: *Ply Cutting → Assembly* goes,
 *   because the sheet plans the pair as one step with one figure; and
 *   *Fiber → Stitching* becomes *Fiber → Stapling*, because the sheet puts
 *   fibre filling after stitching, not before it.
 * - **Six articles get the sheet's day-counts and a rate of 40 a day** at every
 *   production department; two of them (the Betsy chairs) are new.
 * - **The other articles' placeholder offsets are made consistent with the
 *   route** — Machining before Ply Cutting, as the hosted graph has it. They
 *   were the other way round, and that was the whole of the seventy "route
 *   conflicts" on the Attention screen. This does not settle whether machining
 *   feeds ply cutting: the sheet only shows machining due before the combined
 *   *Ply cutting and assembly* step, which assembly alone would explain.
 * - **The twelve PROV- practice orders are replaced** by the sheet's eleven
 *   dispatches, prefixed SAMPLE-.
 *
 * The provisional banner stays up, reworded: the day-counts are U&M's, the
 * rate of forty is a stand-in, and nothing here is a confirmed plan.
 *
 * Safe to run twice. Masters upsert by code, orders already present are
 * skipped, and the purge is only called while the PROV- set is what is marked.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { buildMasters, buildOrders, expectedConflicts } from './lib/um-sample.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('Usage: load-um-sample.mjs <email> <password>')
  process.exit(1)
}

const PREFIX = 'SAMPLE-'
const WHAT =
  "Six products from U&M's own planning sheet, loaded as a sample. The " +
  'day-counts are theirs as supplied; every production rate is set to 40 a ' +
  'day as a stand-in; QC steps are treated as deadlines.'

const text = await readFile(`${repoRoot}.env.hosted.local`, 'utf8').catch(() => {
  throw new Error('.env.hosted.local not found — this writes to the hosted project.')
})
const env = Object.fromEntries(
  text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const sheet = JSON.parse(
  await readFile(`${repoRoot}scripts/data/um-sample-sheet.json`, 'utf8'),
)

const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { error: signInError } = await db.auth.signInWithPassword({ email, password })
if (signInError) {
  console.error(`Sign in failed: ${signInError.message}`)
  process.exit(1)
}

async function call(fn, args, what) {
  const { data, error } = await db.rpc(fn, args)
  if (error) {
    console.error(`\n${what}: ${error.message}`)
    process.exit(1)
  }
  return data
}

/** PostgREST stops at a thousand rows without saying so; page past it. */
async function rows(view, select = '*', shape = (q) => q) {
  const all = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await shape(
      db.from(view).select(select).range(from, from + 999),
    )
    if (error) throw new Error(`${view}: ${error.message}`)
    all.push(...(data ?? []))
    if (!data || data.length < 1000) return all
  }
}

// --- what the project already knows, so an upsert does not flatten it -------
const departmentRows = await rows('department_master', 'code,name,yield_pct,is_active')
const articleRows = await rows('article_list', 'id,code,name,is_active')
const masters = buildMasters(sheet, {
  departments: new Map(departmentRows.map((d) => [d.code, d])),
  articles: new Map(articleRows.map((a) => [a.code, a.name])),
})

/*
 * The placeholder offsets on every other article had Ply Cutting due before
 * Machining (D-60 against D-56), against a route in which machining feeds it.
 * Sixty-six articles' worth of critical findings were that one inversion in
 * figures we invented, and they would bury the six articles this load is
 * actually about. Swapped to agree with the route as it stands — which is a
 * choice about our placeholders, not evidence about U&M's factory.
 */
const sampled = new Set(sheet.rows.map((r) => r.sku))
for (const a of articleRows.filter((x) => x.is_active && !sampled.has(x.code))) {
  masters.tables.article_dept_dminus.push(
    { article_code: a.code, department_code: 'MACHINE', dminus_days: 60, is_complete: true },
    { article_code: a.code, department_code: 'PLYCUT', dminus_days: 56, is_complete: true },
  )
}

console.log(
  `${sheet.rows.length} products · ${masters.tables.departments.length} departments · ` +
    `${masters.tables.department_dependencies.length} links · ` +
    `${masters.tables.component_rates.length} rates · ` +
    `${masters.tables.article_dept_dminus.length} day-counts`,
)
const applied = await call('import_masters', { p_file: masters }, 'masters')
console.log(`  ${applied} rows applied`)

// --- the order book: ours out, the sheet's in -------------------------------
const [state] = await rows('provisional_state')
if (state?.is_provisional && state.order_prefix !== PREFIX) {
  const gone = await call('purge_provisional', {}, 'purge')
  console.log(`  ${gone} ${state.order_prefix} practice orders removed`)
}
// Straight after the purge and before any order exists: the banner must never
// be down while invented figures are on screen.
await call('mark_provisional', { p_what: WHAT, p_order_prefix: PREFIX, p_note: sheet.source }, 'marker')

const customer = await call(
  'create_customer',
  { p_code: 'UM-SAMPLE', p_name: 'U&M sample dispatch plan', p_country: null },
  'customer',
)
const articleId = new Map(
  (await rows('article_list', 'id,code')).map((a) => [a.code, a.id]),
)
const already = new Set(
  (await rows('order_book', 'erp_order_no')).map((o) => o.erp_order_no),
)

let made = 0
for (const o of buildOrders(sheet, PREFIX)) {
  if (already.has(o.erp_order_no)) continue
  await call(
    'create_order',
    {
      p_erp_order_no: o.erp_order_no,
      p_customer_id: customer,
      p_article_id: articleId.get(o.sku),
      p_qty: o.qty,
      p_stuffing_date: o.stuffing_date,
      p_confidence: 'confirmed',
      p_container_ref: o.container_ref,
    },
    `order ${o.erp_order_no}`,
  )
  made += 1
}
console.log(`  ${made} dispatches entered`)

// --- plan it ----------------------------------------------------------------
const started = Date.now()
await call(
  'run_schedule',
  { p_confidence: ['confirmed', 'probable'], p_make_current: true, p_note: 'U&M sample sheet' },
  'schedule',
)
console.log(`  planned in ${Math.round((Date.now() - started) / 1000)}s`)

// --- and say what came out, checked rather than assumed ---------------------
const [run] = await rows('run_history', '*', (q) => q.eq('is_current', true))
const tasks = await rows('schedule_gantt', 'erp_order_no,department_code,is_feasible,breach_reason', (q) =>
  q.eq('run_id', run.id),
)
const breached = tasks.filter((t) => !t.is_feasible)
const byDept = {}
for (const t of breached) byDept[t.department_code] = (byDept[t.department_code] ?? 0) + 1
const departmentsPlanned = new Set(tasks.map((t) => t.department_code)).size

console.log(`\n${tasks.length} tasks across ${departmentsPlanned} departments`)
console.log(
  `${breached.length} cannot be made in the days given` +
    (breached.length ? ` — ${Object.entries(byDept).map(([d, n]) => `${d} ${n}`).join(', ')}` : ''),
)

const conflicts = await rows('route_order_conflicts', 'article_code,later_department_code')
const want = new Set(expectedConflicts(sheet).map((x) => `${x.sku}|${x.department}`))
const got = new Set(conflicts.map((c) => `${c.article_code}|${c.later_department_code}`))
const stray = [...got].filter((k) => !want.has(k))
console.log(
  `${got.size} equal-day findings (${want.size} are in the sheet itself)` +
    (stray.length ? ` — ${stray.length} NOT from the sheet: ${stray.slice(0, 5).join(', ')}` : ''),
)

const unstaffed = await rows('attention_department_unstaffed', 'title')
if (unstaffed.length) {
  console.log(`\n${unstaffed.length} department(s) have no shift and are being skipped:`)
  for (const u of unstaffed) console.log(`  ${u.title}`)
}
if (departmentsPlanned !== sheet.departments.length) {
  console.log(
    `\nExpected ${sheet.departments.length} departments in the plan, found ${departmentsPlanned}.`,
  )
  process.exit(1)
}

await db.auth.signOut()
console.log('\nLoaded. The banner says these are sample figures until they are replaced.')
