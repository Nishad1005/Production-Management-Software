/**
 * Interim data for the hosted project, and a way to take it out again.
 *
 *   node scripts/seed-live-interim.mjs <email> <password>
 *   node scripts/seed-live-interim.mjs <email> <password> --purge
 *
 * ---------------------------------------------------------------------------
 * Why this exists.
 *
 * The live project holds U&M's real route — fourteen departments, seventy-one
 * SKUs — and nothing else. Not one rate in any of the 994 cells, no orders, no
 * production. Every screen is therefore empty, which makes it impossible to
 * hand anybody an account and ask what they think.
 *
 * This fills it with figures that are ours rather than U&M's, so the software
 * can be used and argued with while PPC's real sheet is being filled in.
 *
 * ---------------------------------------------------------------------------
 * Three things keep it from becoming the record.
 *
 * 1. **It says so.** `mark_provisional` puts a standing notice in the database
 *    and the application shows a banner for as long as it is there.
 * 2. **The masters overwrite themselves.** Rates and D-minus go in through
 *    `import_masters`, the same path PPC's completed workbook takes, upserting
 *    by code — so their sheet replaces these cell by cell with nothing left
 *    behind. There is no cleanup step for them because none is needed.
 * 3. **The orders carry a prefix.** `PROV-`, so `--purge` removes exactly what
 *    this created and nothing anybody has entered since.
 *
 * The marker is written **first**, before anything is created. The first version
 * wrote it last, reasoning that a half-finished load should not be announced —
 * which was exactly backwards. A load that fails partway is precisely when you
 * need the banner up and the purge available, and the first real run failed
 * partway.
 *
 * ---------------------------------------------------------------------------
 * The figures are crude on purpose.
 *
 * One rate and one D-minus per department, applied to all seventy-one
 * articles. A dining chair and an ottoman do not take the same time at
 * stitching, and anybody who knows the factory will say so within a minute of
 * looking — which is exactly the reaction wanted. A subtler set of invented
 * numbers would be likelier to be believed, and that is the failure this whole
 * project is built to avoid.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const purge = args.includes('--purge')
const [email, password] = args.filter((a) => !a.startsWith('--'))

if (!email || !password) {
  console.error(
    'Usage: seed-live-interim.mjs <email> <password> [--purge]\n' +
      '  --purge removes the PROV- orders and their production, and clears the banner.',
  )
  process.exit(1)
}

/**
 * One figure per department. Chosen to be plausible for an upholstery factory
 * and to make stitching the constraint, which is what U&M say it is — so the
 * bottleneck screen says something true even while the numbers are not.
 *
 * dminus is days before the container that department must finish; larger means
 * earlier, and the order below respects what feeds what.
 */
const DEPARTMENTS = [
  { code: 'PLYCUT', units: 120, manpower: 8, dminus: 60 },
  { code: 'MACHINE', units: 90, manpower: 10, dminus: 56 },
  { code: 'ASSY', units: 70, manpower: 14, dminus: 48 },
  { code: 'SAND', units: 85, manpower: 6, dminus: 44 },
  { code: 'WOODFIN', units: 65, manpower: 9, dminus: 38 },
  { code: 'METALFIN', units: 110, manpower: 5, dminus: 40 },
  { code: 'FOAM', units: 95, manpower: 7, dminus: 34 },
  { code: 'FIBER', units: 130, manpower: 4, dminus: 36 },
  { code: 'CUT', units: 100, manpower: 6, dminus: 32 },
  { code: 'STITCH', units: 38, manpower: 22, dminus: 26 },
  { code: 'STAPLE', units: 55, manpower: 16, dminus: 18 },
  { code: 'FIT', units: 60, manpower: 12, dminus: 12 },
  { code: 'QC', units: 140, manpower: 4, dminus: 7 },
  { code: 'PACK', units: 150, manpower: 6, dminus: 3 },
]

const WHAT =
  'Rates, D-minus, crew sizes and a twelve-order book entered by DBBS as ' +
  'placeholders. Not confirmed by PPC.'

async function loadEnv() {
  const text = await readFile(`${repoRoot}/.env.hosted.local`, 'utf8').catch(() => {
    throw new Error('.env.hosted.local not found — this writes to the hosted project.')
  })
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const env = await loadEnv()
const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { error: signInError } = await db.auth.signInWithPassword({ email, password })
if (signInError) {
  console.error(`Sign in failed: ${signInError.message}`)
  process.exit(1)
}

async function call(fn, args, what) {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

// ---------------------------------------------------------------------------

if (purge) {
  const gone = await call('purge_provisional', {}, 'purge')
  await call('run_schedule', { p_note: 'Interim data removed' }, 're-run')
  console.log(`Removed ${gone} interim orders and everything recorded against them.`)
  console.log('Masters were left alone — they upsert by code and PPC\'s sheet replaces them.')
  await db.auth.signOut()
  process.exit(0)
}

/*
 * Before anything is created, so a load that fails halfway is still announced
 * and still removable. Re-running is safe: mark_provisional replaces the row.
 */
await call(
  'mark_provisional',
  { p_what: WHAT, p_order_prefix: 'PROV-', p_note: 'scripts/seed-live-interim.mjs' },
  'marker',
)

/*
 * `article_list`, not `article_master`.
 *
 * All this needs is a code and whether the article is switched on.
 * `article_master` additionally works out, per article, how many departments it
 * is routed through and how many of those lack a D-minus — which on the live
 * project, with 994 components behind row-level security, took longer than the
 * eight-second API timeout and killed this script on a read.
 *
 * Ask for the cheapest thing that answers the question. The Masters screen does
 * need the full view and may have the same problem; `verify:live` now times
 * every view so that can be measured rather than guessed at.
 */
const { data: articles, error: articleError } = await db
  .from('article_list')
  .select('code, name, is_active')
  .order('code')
if (articleError) throw new Error(`articles: ${articleError.message}`)

const live = articles.filter((a) => a.is_active)
console.log(`${live.length} active articles, ${DEPARTMENTS.length} departments`)
if (!live.length) {
  console.error('No articles in the project — load the capacity sheet first.')
  process.exit(1)
}

/*
 * One masters file rather than two thousand round trips.
 *
 * import_masters takes the whole thing in a single call and is the same
 * function the Load-from-a-file button uses, so this goes in through a path
 * that is already tested rather than a bespoke one written for a script.
 */
const components = []
const bom = []
const rates = []
const dminus = []

for (const a of live) {
  for (const d of DEPARTMENTS) {
    const code = `${a.code}::${d.code}`
    components.push({ code, name: `${d.code} work on ${a.code}`, uom: 'NOS', is_active: true })
    bom.push({ article_code: a.code, component_code: code, qty_per_unit: 1 })
    rates.push({
      component_code: code,
      department_code: d.code,
      shift_code: 'GEN',
      units_per_day: d.units,
      is_measured: false,
    })
    dminus.push({
      article_code: a.code,
      department_code: d.code,
      dminus_days: d.dminus,
      is_complete: true,
    })
  }
}

console.log(`Applying ${rates.length} rates and ${dminus.length} offsets…`)
const applied = await call(
  'import_masters',
  {
    p_file: {
      kram_masters: 1,
      tables: { components, article_bom: bom, component_rates: rates, article_dept_dminus: dminus },
    },
  },
  'masters',
)
console.log(`  ${applied} rows applied`)

// Crew sizes, so attendance and the overtime arithmetic have a denominator.
for (const d of DEPARTMENTS) {
  await call(
    'set_headcount',
    { p_department_code: d.code, p_shift_code: 'GEN', p_headcount: d.manpower },
    `headcount ${d.code}`,
  )
}
console.log(`  ${DEPARTMENTS.length} crew sizes`)

// Manpower per rate, which is what lets attendance scale a day.
for (const a of live.slice(0, 8)) {
  for (const d of DEPARTMENTS) {
    await call(
      'set_capacity_cell',
      {
        p_article_code: a.code,
        p_department_code: d.code,
        p_units: d.units,
        p_manpower: d.manpower,
      },
      `crew on ${a.code} × ${d.code}`,
    )
  }
}
console.log('  crew sizes against the first eight articles\' rates')

// ---------------------------------------------------------------------------
// A small order book. Twelve orders across the next four months, a few of them
// deliberately tight so the flags and the acceptance check have something to
// say.
// ---------------------------------------------------------------------------
const customer = await call(
  'create_customer',
  { p_code: 'PROV-CUST', p_name: 'Provisional Customer', p_country: 'United States' },
  'customer',
)

const { data: articleRows } = await db.from('article_list').select('id, code').eq('is_active', true)
const byCode = new Map(articleRows.map((a) => [a.code, a.id]))

const today = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
const plus = (days) => iso(new Date(today.getTime() + days * 86_400_000))

const { data: existingOrders } = await db
  .from('order_book')
  .select('erp_order_no')
  .like('erp_order_no', 'PROV-%')
const already = new Set((existingOrders ?? []).map((o) => o.erp_order_no))

let made = 0
let skipped = 0
for (const [i, a] of live.slice(0, 12).entries()) {
  const qty = [180, 240, 120, 300, 90, 150, 200, 260, 110, 340, 160, 130][i]
  // A couple inside the route's own span, which is what raises a real flag.
  const days = [95, 88, 40, 110, 30, 76, 120, 64, 25, 140, 58, 100][i]
  // Re-running after a failure should carry on rather than stop on a unique
  // violation for an order the previous attempt already created.
  if (already.has(`PROV-${String(1001 + i)}`)) {
    skipped += 1
    continue
  }
  await call(
    'create_order',
    {
      p_erp_order_no: `PROV-${String(1001 + i)}`,
      p_customer_id: customer,
      p_article_id: byCode.get(a.code),
      p_qty: qty,
      p_stuffing_date: plus(days),
      p_confidence: i % 5 === 0 ? 'probable' : 'confirmed',
      p_container_ref: `PROV-CNTR-${100 + i}`,
    },
    `order for ${a.code}`,
  )
  made += 1
}
console.log(`  ${made} orders${skipped ? `, ${skipped} already there` : ''}`)

/*
 * The first real run of this script died here: Supabase gives the
 * `authenticated` role an eight-second statement timeout and the engine needs
 * longer over 994 routed cells. The functions now carry their own timeout —
 * migration 20260823100000 — so if this fails again it is worth reading rather
 * than retrying.
 */
try {
  await call('run_schedule', { p_note: 'Interim data loaded' }, 'schedule')
} catch (e) {
  console.error(`\n${e.message}`)
  console.error(
    'The masters and the orders are in and the banner is up; only the run failed.\n' +
      'If this is a statement timeout, check migration 20260823100000 has been\n' +
      'pushed (npm run db:push), then run this script again — it resumes.',
  )
  process.exit(1)
}

// A fortnight of production against the earliest orders, so WIP, quality and
// the department boards have something in them. Deliberately short of the
// forecast threshold: ten observations would make the models state figures,
// and a measured rate on invented output is the one number this software must
// never show.
const { data: gantt } = await db
  .from('schedule_gantt')
  .select('shipment_line_id, department_code, component_code, qty_required, erp_order_no')
  .in('department_code', ['PLYCUT', 'MACHINE', 'ASSY'])
  .limit(24)

let declared = 0
for (const [i, t] of (gantt ?? []).entries()) {
  if (!t.erp_order_no?.startsWith('PROV-')) continue
  await call(
    'declare_production',
    {
      p_shipment_line_id: t.shipment_line_id,
      p_department_code: t.department_code,
      p_component_code: t.component_code,
      p_date: plus(-(i % 6) - 1),
      p_shift_code: 'GEN',
      p_good: Math.round(Number(t.qty_required) * 0.6),
      p_rejected: i % 4 === 0 ? 3 : 0,
    },
    `production ${t.component_code}`,
  )
  declared += 1
}
console.log(`  ${declared} production entries`)

await db.auth.signOut()
console.log('\nLoaded. The application will show a provisional banner until this is removed.')
console.log('Remove it with:  node scripts/seed-live-interim.mjs <email> <password> --purge')
