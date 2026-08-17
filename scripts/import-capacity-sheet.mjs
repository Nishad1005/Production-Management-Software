/**
 * Loads U&M's capacity sheet into Kram.
 *
 *   node scripts/import-capacity-sheet.mjs <workbook.xlsx> <email> <password>
 *   node scripts/import-capacity-sheet.mjs <workbook.xlsx> --dry-run
 *
 * Reads the departments from the header row and the SKUs from the body, and
 * loads any capacity figures that have been filled in — rates, crew sizes, and
 * the D-minus offsets from the second sheet. Everything upserts by code, so it
 * is safe to run again when PPC returns a completed sheet.
 *
 * The layout lives in lib/capacity-workbook.mjs, shared with the generator that
 * writes the blank sheet, so the two cannot drift a column apart.
 *
 * Deliberately a script rather than a migration: this is client data, it will
 * change, and it belongs nowhere near the schema's history.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { parseWorkbook } from './lib/capacity-workbook.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The sheet's column order is a grouping, not a sequence — sanding before ply
 * cutting, and assembly second, is not how upholstered furniture is made. This
 * is the order the trade runs in: frame, then finishes, then the soft parts,
 * then upholstery, fitting and despatch. Metal finishing and fibre processing
 * are feeders and sit before what consumes them.
 *
 * route_position decides every date in the system, so PPC should check this
 * first. It is editable on the Masters screen without touching code.
 */
const ROUTE = [
  'Ply Cutting',
  'Machining',
  'Assembly',
  'Sanding',
  'Wood Finishing',
  'Metal Finishing',
  'Foam Pasting',
  'Fiber Processing',
  'Cutting',
  'Stitching',
  'Stapling',
  'Fitting',
  'Final QC inspection',
  'Final Packing',
]

/**
 * Written out rather than derived. Truncating gave MACHININ and STITCHIN, and
 * these codes head every column of a 70-row grid and appear on every schedule —
 * they are read constantly and worth choosing.
 */
const CODES = {
  'Ply Cutting': 'PLYCUT',
  Machining: 'MACHINE',
  Assembly: 'ASSY',
  Sanding: 'SAND',
  'Wood Finishing': 'WOODFIN',
  'Metal Finishing': 'METALFIN',
  'Foam Pasting': 'FOAM',
  'Fiber Processing': 'FIBER',
  Cutting: 'CUT',
  Stitching: 'STITCH',
  Stapling: 'STAPLE',
  Fitting: 'FIT',
  'Final QC inspection': 'QC',
  'Final Packing': 'PACK',
}

function departmentCode(name) {
  return (
    CODES[name] ??
    name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)
  )
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

const [file, emailOrFlag, password] = process.argv.slice(2)
if (!file) {
  console.error('Usage: import-capacity-sheet.mjs <workbook.xlsx> <email> <password>')
  process.exit(1)
}

const { departments, articles } = parseWorkbook(await readFile(file))
const filled = articles.flatMap((a) => a.cells.filter((c) => c.units !== null))
const offsets = articles.flatMap((a) =>
  a.cells.filter((c) => c.units !== null && c.dminus !== null),
)

/*
 * An article schedules only when every department it is routed through has an
 * offset. Reporting the offsets alone would let a sheet look nearly complete
 * while not one article could be planned — this is the figure PPC actually
 * care about, so it is the one printed.
 */
const routed = articles.filter((a) => a.cells.some((c) => c.units !== null))
const schedulable = routed.filter((a) =>
  a.cells.every((c) => c.units === null || c.dminus !== null),
)

console.log(`Workbook: ${file}`)
console.log(`  departments : ${departments.length}`)
console.log(`  articles    : ${articles.length}`)
console.log(`  filled cells: ${filled.length}`)
console.log(`  D-minus     : ${offsets.length} of ${filled.length} routed cells`)
console.log(
  `  schedulable : ${schedulable.length} of ${routed.length} routed articles` +
    (schedulable.length < routed.length
      ? ' — the rest are missing an offset and will not plan'
      : ''),
)

const ordered = ROUTE.filter((name) => departments.some((d) => d.name === name))
const unplaced = departments.filter((d) => !ROUTE.includes(d.name))
if (unplaced.length) {
  // Better loud than quietly appended at the end of the route, where they would
  // silently become the last operations in the factory.
  console.error(
    `\nNot in the proposed route order, so not loaded: ${unplaced
      .map((d) => d.name)
      .join(', ')}\nAdd them to ROUTE in this script, in sequence.`,
  )
  process.exit(1)
}

console.log('\nRoute order to be applied:')
ordered.forEach((name, i) =>
  console.log(`  ${String((i + 1) * 10).padStart(3)}  ${departmentCode(name).padEnd(8)} ${name}`),
)

if (emailOrFlag === '--dry-run' || !password) {
  console.log('\nDry run — nothing written.')
  process.exit(0)
}

const env = await loadEnv()
const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { error: signInError } = await db.auth.signInWithPassword({
  email: emailOrFlag,
  password,
})
if (signInError) {
  console.error(`\nSign in failed: ${signInError.message}`)
  process.exit(1)
}

async function call(fn, args, what) {
  const { error } = await db.rpc(fn, args)
  if (error) {
    console.error(`  FAILED ${what}: ${error.message}`)
    return false
  }
  return true
}

console.log('\nLoading…')
let ok = 0
let failed = 0

/*
 * Route positions are unique, and the placeholder route occupies exactly the
 * numbers the real one needs. Each RPC is its own transaction, so the
 * constraint's deferral cannot help across calls — everything existing is
 * parked in a spare range first, then the real route is laid down on the
 * numbers it wants.
 */
const { data: existing } = await db
  .from('department_master')
  .select('id, code, route_position')

const incoming = new Set(ordered.map(departmentCode))

for (const [i, dept] of (existing ?? []).entries()) {
  await call(
    'update_department',
    { p_id: dept.id, p_route_position: 900 + i },
    `parking ${dept.code}`,
  )
}
if (existing?.length) {
  console.log(`  parked ${existing.length} existing department(s) out of the way`)
}

for (const [i, name] of ordered.entries()) {
  const done = await call(
    'create_department',
    {
      p_code: departmentCode(name),
      p_name: name,
      p_route_position: (i + 1) * 10,
      p_yield_pct: 98,
    },
    `department ${name}`,
  )
  if (done) ok += 1
  else failed += 1
}
console.log(`  departments: ${ok} loaded`)

// Anything that was there before and is not in the real route is retired —
// soft, never deleted, because a department with history keeps it.
const retired = (existing ?? []).filter((d) => !incoming.has(d.code))
for (const dept of retired) {
  await call(
    'set_department_active',
    { p_id: dept.id, p_is_active: false },
    `retiring ${dept.code}`,
  )
}
if (retired.length) {
  console.log(
    `  retired: ${retired.map((d) => d.code).join(', ')} — not in the real route`,
  )
}

let articlesLoaded = 0
for (const article of articles) {
  if (await call(
    'create_article',
    { p_code: article.code, p_name: article.name, p_category: null },
    `article ${article.code}`,
  )) {
    articlesLoaded++
  } else {
    failed++
  }
}
console.log(`  articles: ${articlesLoaded} loaded`)

let cells = 0
for (const article of articles) {
  for (const cell of article.cells) {
    if (cell.units === null) continue
    if (await call(
      'set_capacity_cell',
      {
        p_article_code: article.code,
        p_department_code: departmentCode(cell.department),
        p_units: cell.units,
        p_manpower: cell.manpower,
      },
      `${article.code} × ${cell.department}`,
    )) {
      cells++
    } else {
      failed++
    }
  }
}
console.log(`  capacity cells: ${cells} loaded`)

/*
 * D-minus after the rates, deliberately. set_dminus marks the cell complete,
 * and a cell is only worth completing where the article actually goes — so the
 * rate has to exist first for the pair to mean anything.
 */
let loadedOffsets = 0
for (const article of articles) {
  for (const cell of article.cells) {
    if (cell.units === null || cell.dminus === null) continue
    if (await call(
      'set_dminus',
      {
        p_article_code: article.code,
        p_department_code: departmentCode(cell.department),
        p_days: cell.dminus,
      },
      `D-minus ${article.code} × ${cell.department}`,
    )) {
      loadedOffsets++
    } else {
      failed++
    }
  }
}
console.log(`  D-minus offsets: ${loadedOffsets} loaded`)

await db.auth.signOut()
console.log(failed ? `\n${failed} failed.` : '\nDone.')
process.exit(failed ? 1 : 0)
