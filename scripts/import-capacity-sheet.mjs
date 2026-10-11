/**
 * Loads a capacity workbook into Kram, from a terminal — the twin of "Load a
 * workbook" on the Capacity sheet, on the same code and the same rules.
 *
 *   node scripts/import-capacity-sheet.mjs <workbook.xlsx>                         # read it, say what is in it
 *   node scripts/import-capacity-sheet.mjs <workbook.xlsx> <email> <password> --dry-run
 *   node scripts/import-capacity-sheet.mjs <workbook.xlsx> <email> <password>
 *
 * The plan is worked out against the live masters before anything is written
 * (`planWorkbookLoad` in `src/lib/capacity-workbook.ts`) and printed in full;
 * `--dry-run` stops there. Applying is one call, `apply_capacity_workbook`,
 * which writes everything or nothing and raises on any code the masters do
 * not hold.
 *
 * What this never does, any more: create, retire or re-order a department,
 * create an article, or touch a yield. The first version of this script did
 * all four from a fourteen-name constant, and given the sheet already sent
 * to PPC it would have retired the six checkpoint departments (log §8.4). A
 * column Kram does not know is listed and skipped; the route is changed on
 * Masters.
 */
import { readFile } from 'node:fs/promises'
import { parseWorkbook, planWorkbookLoad } from '../src/lib/capacity-workbook.ts'
import { hostedClient, selectAll } from './lib/hosted.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [file, email, password] = args.filter((a) => !a.startsWith('--'))

if (!file) {
  console.error(
    'Usage: import-capacity-sheet.mjs <workbook.xlsx> [<email> <password>] [--dry-run]',
  )
  process.exit(1)
}

const parsed = parseWorkbook(new Uint8Array(await readFile(file)))
const filled = parsed.articles.flatMap((a) => a.cells.filter((c) => c.units !== null))
const offsets = parsed.articles.flatMap((a) => a.cells.filter((c) => c.dminus !== null))

console.log(`Workbook: ${file}`)
console.log(`  columns      : ${parsed.departments.length} departments`)
console.log(`  rows         : ${parsed.articles.length} articles`)
console.log(`  units        : ${filled.length} cells`)
console.log(`  D-minus      : ${offsets.length} cells`)

if (!email || !password) {
  console.log('\nNo login given, so no preview against the live project and nothing written.')
  process.exit(0)
}

const db = await hostedClient(email, password)
const departments = (
  await selectAll(db, 'department_master', 'code, name, is_active', ['route_position'])
).filter((d) => d.is_active)
const articles = (
  await selectAll(db, 'article_master', 'code, name, is_active', ['code'])
).filter((a) => a.is_active)
const sheet = await selectAll(
  db,
  'capacity_sheet',
  'article_code, article_name, department_code, department_name, route_position, ' +
    'units_per_day, manpower, dminus_days, dminus_complete',
  ['article_code', 'route_position'],
)

const plan = planWorkbookLoad(parsed, { departments, articles, sheet })
const list = (xs) => (xs.length ? xs.join(', ') : 'none')

console.log('\nAgainst the live project:')
console.log(`  departments matched : ${plan.matchedDepartments.length}`)
console.log(`  columns unknown     : ${list(plan.unknownDepartments)} — skipped, never created`)
console.log(`  articles matched    : ${plan.matchedArticles.length}`)
console.log(`  codes unknown       : ${list(plan.unknownArticles)} — skipped; add them on Masters first`)
if (plan.duplicateArticles.length) {
  console.log(`  codes on two rows   : ${list(plan.duplicateArticles)} — the last row wins`)
}
console.log(
  `  rates               : ${plan.rates.new} new, ${plan.rates.changed} changed, ${plan.rates.unchanged} unchanged`,
)
console.log(
  `  D-minus             : ${plan.dminus.new} new, ${plan.dminus.changed} changed, ${plan.dminus.unchanged} unchanged`,
)
console.log(
  `  blank cells         : ${plan.blanks} left exactly as they are (${plan.keptRates} hold a rate today)`,
)
console.log(
  `  schedulable after   : ${plan.schedulable.after} of ${plan.schedulable.of} routed articles` +
    (plan.schedulable.after < plan.schedulable.of
      ? ' — the rest are missing a D-minus somewhere and will not plan'
      : ''),
)

if (dryRun) {
  console.log('\nDry run — nothing written.')
  await db.auth.signOut()
  process.exit(0)
}
if (!plan.file.cells.length) {
  console.log('\nNothing in the file matches anything on Masters, so nothing to apply.')
  await db.auth.signOut()
  process.exit(0)
}

const { data, error } = await db.rpc('apply_capacity_workbook', { p_file: plan.file })
if (error) {
  console.error(`\nFAILED, nothing written: ${error.message}`)
  await db.auth.signOut()
  process.exit(1)
}
const { error: runError } = await db.rpc('run_schedule', {
  p_note: 'Recomputed after loading a capacity workbook',
})
if (runError) {
  console.error(`\nApplied, but the schedule did not re-run: ${runError.message}`)
  await db.auth.signOut()
  process.exit(1)
}
await db.auth.signOut()
console.log(
  `\n${data.rates} rates and ${data.dminus} D-minus figures applied; the schedule re-run.`,
)
