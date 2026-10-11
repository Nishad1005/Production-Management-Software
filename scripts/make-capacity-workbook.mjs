/**
 * Writes the capacity workbook for PPC, from a terminal.
 *
 *   node scripts/make-capacity-workbook.mjs <email> <password> [out.xlsx]
 *   node scripts/make-capacity-workbook.mjs --sample [out.xlsx]
 *
 * The same file the Capacity sheet's "Blank workbook" button hands out, built
 * by the same code (`src/lib/capacity-workbook.ts`): every active department
 * across in route order, every active article down, and whatever Kram already
 * holds filled in — so a sheet that comes back for a second round arrives
 * carrying the first round's answers rather than asking for them again.
 *
 * `--sample` writes a three-article example with no database at all, for
 * checking the layout or showing somebody what will land in their inbox.
 */
import { writeFile } from 'node:fs/promises'
import { buildWorkbook, modelFromSheet } from '../src/lib/capacity-workbook.ts'
import { hostedClient, selectAll } from './lib/hosted.mjs'

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

function fromSample() {
  return {
    departments: [{ name: 'Ply Cutting' }, { name: 'Machining' }, { name: 'Stitching' }],
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
  const db = await hostedClient(email, password)
  // The view is already active articles × active departments, and it carries
  // the figures, so it is the one read. Paged: 72 × 20 is past the API's
  // thousand-row ceiling, which it crosses silently.
  const rows = await selectAll(
    db,
    'capacity_sheet',
    'article_code, article_name, department_code, department_name, route_position, ' +
      'units_per_day, manpower, dminus_days, dminus_complete',
    ['article_code', 'route_position'],
  )
  await db.auth.signOut()
  console.log(`Read        : ${rows.length} cells from the hosted project`)
  return modelFromSheet(rows)
}

const model = sample ? fromSample() : await fromProject(first, second)

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
      " placeholder route rather than U&M's SKUs, load their article list first" +
      ' — this sheet would ask PPC to fill in a factory that is not theirs.',
  )
}

await writeFile(out, new Uint8Array(buildWorkbook(model)))
console.log(`\nWritten: ${out}`)
