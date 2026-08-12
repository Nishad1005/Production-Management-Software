/**
 * Applies a proposed route graph — what must finish before what.
 *
 *   node scripts/apply-route-graph.mjs --dry-run
 *   node scripts/apply-route-graph.mjs <email> <password>
 *
 * The migration that introduced department_dependencies seeded it as a single
 * line, because that reproduces the behaviour it replaced exactly and so could
 * not break anything on the way in. This is the part that says what is actually
 * true: three separate streams — frame, fabric, metal — that converge late.
 *
 * Like the route order before it, this is our reading of the trade and not
 * something U&M told us. PPC corrects it on the Masters screen, and this script
 * exists so there is something concrete to correct rather than a blank grid.
 *
 * Deliberately a script rather than a migration: it is client data, it will
 * change the moment PPC looks at it, and it belongs nowhere near the schema's
 * history.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Each entry is a department and the departments that must finish before it can
 * start. An empty list is an entry point: it waits for nothing.
 *
 * The reasoning, department by department:
 *
 *   Ply cutting and machining both start from raw board and metal. Nothing
 *   feeds them, and they run alongside each other.
 *
 *   Assembly needs both. Sanding, then wood finishing, then foam pasting follow
 *   the frame in a straight line — each genuinely cannot start until the last
 *   has finished on that piece.
 *
 *   Metal finishing is its own stream from machining. It joins at fitting,
 *   which is the first point the metalwork meets the upholstered frame.
 *
 *   Fibre processing and fabric cutting are independent of everything upstream —
 *   fabric arrives cut-ready and does not wait on woodwork. They converge at
 *   stitching.
 *
 *   Stapling is where the covers meet the padded frame, so it waits on both
 *   streams. Fitting adds the metalwork. QC and packing follow.
 */
const GRAPH = {
  PLYCUT: [],
  MACHINE: [],
  ASSY: ['PLYCUT', 'MACHINE'],
  SAND: ['ASSY'],
  WOODFIN: ['SAND'],
  FOAM: ['WOODFIN'],
  METALFIN: ['MACHINE'],
  FIBER: [],
  CUT: [],
  STITCH: ['CUT', 'FIBER'],
  STAPLE: ['FOAM', 'STITCH'],
  FIT: ['STAPLE', 'METALFIN'],
  QC: ['FIT'],
  PACK: ['QC'],
}

async function loadEnv() {
  const text = await readFile(`${repoRoot}/.env.hosted.local`, 'utf8')
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

const [emailOrFlag, password] = process.argv.slice(2)

const entryPoints = Object.entries(GRAPH)
  .filter(([, feeders]) => feeders.length === 0)
  .map(([code]) => code)

console.log('\nProposed route graph\n')
for (const [code, feeders] of Object.entries(GRAPH)) {
  console.log(
    `  ${code.padEnd(9)} ${
      feeders.length ? `waits for ${feeders.join(', ')}` : 'entry point'
    }`,
  )
}
console.log(
  `\n  ${entryPoints.length} entry points: ${entryPoints.join(', ')}`,
)
console.log(
  '  Anything not connected runs alongside everything it is not connected to.\n',
)

if (emailOrFlag === '--dry-run' || !password) {
  console.log('Dry run — nothing written.')
  process.exit(0)
}

const env = await loadEnv()
const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { error: signInError } = await db.auth.signInWithPassword({
  email: emailOrFlag,
  password,
})
if (signInError) {
  console.error(`Sign in failed: ${signInError.message}`)
  process.exit(1)
}

// Every department named here must exist, or an edge silently goes missing and
// the graph quietly means something other than what is printed above.
const { data: existing, error: readError } = await db
  .from('department_master')
  .select('code')
if (readError) {
  console.error(`Could not read departments: ${readError.message}`)
  process.exit(1)
}
const known = new Set((existing ?? []).map((d) => d.code))
const missing = Object.entries(GRAPH)
  .flatMap(([code, feeders]) => [code, ...feeders])
  .filter((code) => !known.has(code))
if (missing.length) {
  console.error(
    `Not in the database: ${[...new Set(missing)].join(', ')}\n` +
      'Run import-capacity-sheet.mjs first, or correct GRAPH in this script.',
  )
  process.exit(1)
}

/*
 * Cleared before being laid down, so running this twice leaves exactly the graph
 * printed above rather than that graph plus whatever was there before. The
 * cycle check refuses bad edges as they go in, so order matters: removing
 * everything first means a proposal can never be rejected for colliding with
 * the arrangement it is replacing.
 */
console.log('Clearing existing edges…')
const codes = [...known]
let cleared = 0
for (const department of codes) {
  for (const feeder of codes) {
    if (department === feeder) continue
    const { error } = await db.rpc('set_department_dependency', {
      p_department_code: department,
      p_depends_on_code: feeder,
      p_enabled: false,
    })
    if (error) {
      console.error(`  FAILED clearing ${feeder} → ${department}: ${error.message}`)
      process.exit(1)
    }
    cleared += 1
  }
}
console.log(`  ${cleared} pairs cleared`)

console.log('\nApplying…')
let applied = 0
for (const [department, feeders] of Object.entries(GRAPH)) {
  for (const feeder of feeders) {
    const { error } = await db.rpc('set_department_dependency', {
      p_department_code: department,
      p_depends_on_code: feeder,
      p_enabled: true,
    })
    if (error) {
      console.error(`  FAILED ${feeder} → ${department}: ${error.message}`)
      process.exit(1)
    }
    console.log(`  ${feeder} → ${department}`)
    applied += 1
  }
}

console.log(`\n${applied} edges applied.`)
console.log(
  'Quantities will fall for components on short paths — that is the old model' +
    '\ncharging them for departments their material never entered.',
)
