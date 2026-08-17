/**
 * Writes the blank capacity workbook for PPC.
 *
 *   node scripts/make-capacity-workbook.mjs <email> <password> [out.xlsx]
 *   node scripts/make-capacity-workbook.mjs --sample [out.xlsx]
 *
 * Reads the articles and departments Kram actually holds and lays them out in
 * the shape `import-capacity-sheet.mjs` reads back, so a completed sheet loads
 * in one command with nothing retyped. Figures already entered are filled in —
 * a sheet that comes back for a second round arrives carrying the first round's
 * answers rather than asking for them again.
 *
 * `--sample` writes a three-article example with no database at all, for
 * checking the layout or showing somebody what will land in their inbox.
 */
import { writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { buildWorkbook } from './lib/capacity-workbook.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const [first, second, third] = process.argv.slice(2)
const sample = first === '--sample'
const out = (sample ? second : third) ?? 'kram-capacity-sheet.xlsx'

if (!sample && (!first || !second)) {
  console.error(
    'Usage: make-capacity-workbook.mjs <email> <password> [out.xlsx]\n' +
      '       make-capacity-workbook.mjs --sample [out.xlsx]',
  )
  process.exit(1)
}

async function fromSample() {
  return {
    departments: [
      { name: 'Ply Cutting' },
      { name: 'Machining' },
      { name: 'Stitching' },
    ],
    articles: [
      {
        code: 'UD354 SPPL WAL',
        name: 'Betsy Chair — Specter Pearl',
        cells: { 'Ply Cutting': { manpower: 4, units: 120, dminus: 60 } },
      },
      { code: 'UT263 SPWL COU', name: 'Betsy Counter Stool', cells: {} },
      { code: 'DL25107', name: 'Mable Chair', cells: {} },
    ],
  }
}

async function fromProject(email, password) {
  const text = await readFile(`${repoRoot}/.env.hosted.local`, 'utf8').catch(() => {
    throw new Error('.env.hosted.local not found — this reads the hosted project.')
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

  const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  const { error: signInError } = await db.auth.signInWithPassword({ email, password })
  if (signInError) throw new Error(`Sign in failed: ${signInError.message}`)

  const { data: departments, error: deptError } = await db
    .from('department_master')
    .select('code, name, route_position, is_active')
    .order('route_position')
  if (deptError) throw new Error(`departments: ${deptError.message}`)

  const { data: articles, error: articleError } = await db
    .from('article_master')
    .select('code, name, is_active')
    .order('code')
  if (articleError) throw new Error(`articles: ${articleError.message}`)

  // Whatever is already entered, so a second round does not ask twice.
  const { data: sheet, error: sheetError } = await db
    .from('capacity_sheet')
    .select('article_code, department_name, units_per_day, manpower, dminus_days, dminus_complete')
  if (sheetError) throw new Error(`capacity sheet: ${sheetError.message}`)

  const live = departments.filter((d) => d.is_active)
  const filled = new Map()
  for (const row of sheet ?? []) {
    if (!filled.has(row.article_code)) filled.set(row.article_code, {})
    filled.get(row.article_code)[row.department_name] = {
      manpower: row.manpower,
      units: row.units_per_day,
      // An incomplete offset is one nobody has entered. Writing the underlying
      // null back as a number would turn "still to answer" into "answered".
      dminus: row.dminus_complete ? row.dminus_days : null,
    }
  }

  await db.auth.signOut()

  return {
    departments: live.map((d) => ({ name: d.name })),
    articles: articles
      .filter((a) => a.is_active)
      .map((a) => ({ code: a.code, name: a.name, cells: filled.get(a.code) ?? {} })),
  }
}

const model = sample ? await fromSample() : await fromProject(first, second)

const cellsFilled = model.articles.reduce(
  (n, a) => n + Object.values(a.cells ?? {}).filter((c) => c.units != null).length,
  0,
)
const pairs = model.articles.length * model.departments.length

console.log(`Departments : ${model.departments.length}`)
console.log(`Articles    : ${model.articles.length}`)
console.log(`Cells       : ${cellsFilled} already entered of ${pairs} possible`)

// Loud, because a blank sheet built from a placeholder factory looks exactly
// like a blank sheet built from the real one, and only one of them is worth
// sending to PPC.
if (model.articles.length < 10 && !sample) {
  console.warn(
    `\nOnly ${model.articles.length} articles. If the project still holds the` +
      ' placeholder route rather than U&M\'s SKUs, load their article list first' +
      ' — this sheet would ask PPC to fill in a factory that is not theirs.',
  )
}

await writeFile(out, buildWorkbook(model))
console.log(`\nWritten: ${out}`)
