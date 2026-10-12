/**
 * Writes "One order, start to finish" (DBBS/UM/KRAM/12): one real article
 * followed from the customer's first question to the container, as numbered
 * screenshots of the demonstration build and the page that explains them.
 *
 *   node scripts/make-journey.mjs [baseUrl]
 *   node scripts/make-pdf.mjs docs/order-journey.html
 *
 * ---------------------------------------------------------------------------
 * Why the demonstration build and not the live project.
 *
 * The journey writes: it accepts an order, enters it, declares production in
 * every department, counts handovers in and re-plans. The live project is
 * U&M's and nothing touches it without a go (CLAUDE.md), so the pictures come
 * from the offline build, which carries U&M's own fourteen departments, six of
 * their articles and the real route, on invented speeds. The document says so
 * on its first page. A fresh browser context builds the demonstration
 * database from the seed every time, so the journey starts from the same
 * place on every run and leaves nothing behind.
 *
 * ---------------------------------------------------------------------------
 * The same rules as the walkthrough (make-walkthrough.mjs).
 *
 * Every figure in the text is read off the screen in the same visit as the
 * picture beside it. Every picture waits for the data, not the heading. The
 * pictures are not committed (docs/journey/ is ignored); make-pdf.mjs inlines
 * them, so the PDF is self-contained.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { journeyPage } from './lib/journey-page.mjs'
import { box as boxIn, mark as markIn } from './lib/marks.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const baseUrl = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173'
const outDir = `${repoRoot}docs/journey`
await mkdir(outDir, { recursive: true })

// --page-only rebuilds the page from the last capture's facts, for a change
// to the words that does not need ten minutes of browser.
if (args.includes('--page-only')) {
  const facts = JSON.parse(await readFile(`${outDir}/facts.json`, 'utf8'))
  await writeFile(`${repoRoot}docs/order-journey.html`, journeyPage({ facts }))
  console.log('Wrote docs/order-journey.html from the last facts.')
  process.exit(0)
}

// --- the one order ----------------------------------------------------------
// U&M's own counter stool: it passes through all fourteen departments and
// carries metal and leather, so every screen on the way has something to say.
const ARTICLE = 'UT263 SPWL COU'
const CUSTOMER = 'Nordic Living ApS'
const ERP = 'SO/26-27/0501'
const QTY = 240
const CONTAINER = 'MSKU 2203-9 · 40 HC'

const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const plusDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
/** Never a Sunday: the factory's week has six working days. */
const notSunday = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() === 0 ? plusDays(iso, 1) : iso)
const today = local(new Date())
// What the customer first asked for, and what can be promised. The first
// stage of this article is due eighty-three working days before the
// container, so six weeks is too soon and eighteen fits.
const TOO_SOON = notSunday(plusDays(today, 42))
const STUFFING = notSunday(plusDays(today, 126))

// --- a server, if nothing is listening --------------------------------------
const alive = async (url) => {
  try {
    const r = await fetch(url)
    return r.ok
  } catch {
    return false
  }
}
let server = null
let serverStopped = false
function stopServer() {
  if (!server || serverStopped) return
  serverStopped = true
  try {
    process.kill(-server.pid)
  } catch {
    server.kill()
  }
}
process.on('exit', stopServer)
if (!(await alive(baseUrl))) {
  console.log('Starting the dev server (demonstration build)…')
  server = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { stdio: 'ignore', detached: true })
  const by = Date.now() + 60_000
  while (!(await alive(baseUrl))) {
    if (Date.now() > by) {
      stopServer()
      console.error('The dev server never came up. Run `npm run dev` to see why.')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

// --- the browser -------------------------------------------------------------
const WIDTH = 1180
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1.5 })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const settle = async (ms = 700) => {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}
const go = async (hash, waitFor, timeout = 90_000) => {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(waitFor, { timeout })
  await settle()
}
const box = (l) => boxIn(page, l)
const mark = (t) => markIn(page, t)
const title = (t) => page.locator(`section > header > b:text-is("${t}")`)
const bottomOf = async (l, pad = 14) => {
  const b = await box(l)
  return b.y + b.height + pad
}
const topOf = async (l, pad = 14) => (await box(l)).y - pad

const shots = {}
async function shot(name, top, bottom, x = 0, width = WIDTH) {
  const height = Math.round(bottom - top)
  await page.screenshot({
    path: `${outDir}/${name}.png`,
    fullPage: true,
    clip: { x: Math.round(x), y: Math.max(0, Math.round(top)), width: Math.round(width), height },
  })
  shots[name] = { width: Math.round(width), height }
  console.log(`  ${name}.png — ${Math.round(width)}×${height}`)
}

const facts = { article: ARTICLE, customer: CUSTOMER, erp: ERP, qty: QTY, container: CONTAINER, today, tooSoon: TOO_SOON, stuffing: STUFFING }
const num = (s) => Number(String(s).replace(/[^\d.]/g, ''))

// --- boot: the demonstration database is built in the browser --------------
console.log('booting the demonstration build')
await go('', 'text=Bottleneck utilisation', 240_000)
await page.waitForFunction(
  () => /\d/.test(document.querySelector('main')?.innerText.match(/Scheduled tasks\s*\n\s*(\S+)/i)?.[1] ?? ''),
  null,
  { timeout: 120_000 },
)

// Department names as the screens print them, by code, from the Production
// screen's own list — the one place both are side by side.
await go('#/production', '[data-testid="production-department"]')
const departments = await page.$$eval('[data-testid="production-department"] option', (os) =>
  os.map((o) => ({ code: o.value, name: o.textContent.trim() })),
)
const codeOf = new Map(departments.map((d) => [d.name, d.code]))
facts.departments = departments

/** The option value whose label starts with the article code. */
async function articleOption(selector) {
  return page.$eval(
    selector,
    (sel, code) => [...sel.options].find((o) => o.textContent.trim().startsWith(code))?.value ?? '',
    ARTICLE,
  )
}

// --- 1 · can we take it? -----------------------------------------------------
console.log('accept an order')
await go('#/accept', 'text=Can we take this order?')
await page.selectOption('select', await articleOption('select'))
facts.articleName = (await page.locator('select option:checked').innerText()).replace(/^\S+(\s\S+)*?\s+—\s+/, '').trim()
await page.fill('input[type=number]', String(QTY))
await page.fill('input[type=date]', TOO_SOON)
await page.click('button:has-text("Check")')
await title('Not as it stands').waitFor({ timeout: 200_000 })
await settle(500)
const verdictLine = page.locator('text=/steps cannot be made to this date|Every department can make this/')
facts.tooSoonVerdict = (await verdictLine.first().innerText()).trim()
facts.tooSoonSteps = Number(facts.tooSoonVerdict.match(/^(\d+) of (\d+)/)?.[1] ?? 0)
facts.steps = Number(facts.tooSoonVerdict.match(/^(\d+) of (\d+)/)?.[2] ?? 0)
const flaggedRows = page.locator('tbody tr').filter({ hasNotText: /Clear/ })
await mark([
  { n: 1, at: page.locator('select'), where: 'inside-right', dx: -34 },
  { n: 2, at: page.locator('input[type=number]'), where: 'inside-right', dx: -8 },
  { n: 3, at: page.locator('input[type=date]'), where: 'inside-right', dx: -30 },
  { n: 4, at: page.locator('button:has-text("Check")'), where: 'above', ring: true },
  { n: 5, at: verdictLine.first(), where: 'left', dx: -6 },
  { n: 6, at: flaggedRows.first().locator('td').last().locator('span').first(), where: 'right', dx: 4 },
  { n: 7, at: page.locator('[data-testid="accept-anyway"]'), where: 'right', dx: 4 },
])
{
  // Five rows: with the button marked as well, the page has seven things to
  // say and the picture has to leave room for them.
  const rows = page.locator('tbody tr')
  const n = Math.min(4, (await rows.count()) - 1)
  await shot('accept-no', await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(n), 6))
}
await page.fill('input[type=date]', STUFFING)
await page.click('button:has-text("Check")')
await title('Yes').waitFor({ timeout: 200_000 })
await settle(500)
facts.yesVerdict = (await verdictLine.first().innerText()).trim()
await mark([
  { n: 1, at: page.locator('input[type=date]'), where: 'inside-right', dx: -30, ring: true },
  { n: 2, at: verdictLine.first(), where: 'left', dx: -6 },
  { n: 3, at: page.locator('tbody tr').first().locator('td').nth(3), where: 'left', dx: 2 },
])
{
  const rows = page.locator('tbody tr')
  const n = Math.min(9, (await rows.count()) - 1)
  await shot('accept-yes', await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(n), 6))
}

// --- 2 · it is confirmed: enter it -------------------------------------------
console.log('order book')
await go('#/orders', 'text=Order book')
await page.click('button:has-text("Add an order")')
await page.waitForSelector('text=Creates its first shipment line')
const form = page.locator('form').last()
await form.locator('input[placeholder="SO/26-27/0500"]').fill(ERP)
await form.locator('select').first().selectOption({ label: CUSTOMER })
await form
  .locator('select')
  .nth(1)
  .selectOption(
    await form
      .locator('select')
      .nth(1)
      .evaluate((sel, code) => [...sel.options].find((o) => o.textContent.trim().startsWith(code))?.value ?? '', ARTICLE),
  )
await form.locator('select').nth(2).selectOption('confirmed')
await form.locator('input[type=number]').fill(String(QTY))
await form.locator('input[type=date]').first().fill(STUFFING)
await form.locator('input[placeholder="Optional"]').fill(CONTAINER)
await mark([
  { n: 1, at: form.locator('input[placeholder="SO/26-27/0500"]'), where: 'inside-right', dx: -8 },
  { n: 2, at: form.locator('select').first(), where: 'inside-right', dx: -34 },
  { n: 3, at: form.locator('select').nth(1), where: 'inside-right', dx: -34 },
  { n: 4, at: form.locator('input[type=number]'), where: 'inside-right', dx: -8 },
  { n: 5, at: form.locator('input[type=date]').first(), where: 'inside-right', dx: -30 },
  { n: 6, at: form.locator('button:has-text("Add order")'), where: 'right', ring: true },
])
{
  const b = await box(form)
  await shot('order-form', b.y - 70, b.y + b.height + 16)
}
await form.locator('button:has-text("Add order")').click()
await page.waitForSelector(`tbody tr:has-text("${ERP}")`, { timeout: 120_000 })
// Adding an order re-plans everything; the row shows its dates once that is in.
await settle(1500)
const ourRow = page.locator(`tbody tr:has-text("${ERP}")`).first()
facts.orderRow = (await ourRow.innerText()).replace(/\s+/g, ' ').trim()
await mark([{ n: 1, at: ourRow.locator('td').first(), where: 'left', dx: 2 }])
{
  const rows = page.locator('tbody tr')
  const idx = await rows.evaluateAll((all, erp) => all.findIndex((r) => r.textContent.includes(erp)), ERP)
  const last = rows.nth(Math.min(idx + 1, (await rows.count()) - 1))
  facts.orderRowCells = (await ourRow.locator('td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  await shot('order-book', await topOf(page.locator('thead').first(), 10), await bottomOf(last, 6))
}

// --- 3 · the plan ------------------------------------------------------------
console.log('schedule')
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12 }
const isoOf = (long) => {
  const m = /^(\d+) (\w+) (\d{4})$/.exec(long.trim())
  if (!m) throw new Error(`cannot read the date "${long}"`)
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`
}
const ourGroup = () => page.locator(`[data-testid="gantt-order"]:has-text("${ERP}")`).first()
async function openOurOrder() {
  await go('#/gantt', '[data-testid="gantt-order"]')
  // Only this customer's lines: the book is long and the picture is about one order.
  const customerSelect = page.locator('select').nth(1)
  const value = await customerSelect.evaluate(
    (sel, name) => [...sel.options].find((o) => o.textContent.includes(name))?.value ?? '',
    CUSTOMER,
  )
  if (value) {
    await customerSelect.selectOption(value)
    await settle(500)
  }
  const g = ourGroup()
  await g.waitFor({ timeout: 60_000 })
  if ((await g.getAttribute('data-expanded')) !== 'yes') await g.locator('button').first().click()
  await settle(400)
  return g
}
{
  const g = await openOurOrder()
  await g.locator('[data-testid="gantt-bar"]').first().waitFor({ timeout: 30_000 })
  const titles = await g.locator('[data-testid="gantt-bar"]').evaluateAll((bars) => bars.map((b) => b.title))
  facts.plan = titles.map((t) => {
    const m = /^(.+?): (\d+ \w+ \d{4}) → (\d+ \w+ \d{4}) · ([\d,]+) units/.exec(t)
    if (!m) throw new Error(`cannot read the bar "${t}"`)
    const code = codeOf.get(m[1])
    if (!code) throw new Error(`no department code for "${m[1]}"`)
    return { code, name: m[1], start: isoOf(m[2]), end: isoOf(m[3]), qty: num(m[4]) }
  })
  const bars = g.locator('[data-testid="gantt-bar"]')
  const heading = g.locator('span.font-semibold').first()
  facts.scheduleHeading = (await heading.innerText()).trim()
  await mark([
    { n: 1, at: heading, where: 'left', dx: 0 },
    { n: 2, at: bars.first(), where: 'right' },
    { n: 3, at: bars.last(), where: 'left' },
    { n: 4, at: g.locator('[title^="Container stuffing"]').first(), where: 'right', dx: 4 },
    { n: 5, at: g.locator('[title^="Due "]').nth(Math.max(0, facts.plan.findIndex((p) => p.code === 'STITCH'))), where: 'below', dy: 4 },
  ])
  const b = await box(g)
  await shot('schedule', await topOf(title('Schedule'), 30), b.y + b.height + 10)
}

// --- 4 · what to buy, and by when --------------------------------------------
console.log('material')
await go('#/material', '[data-testid="material-order-now"][data-state="ready"]')
await page.waitForSelector('[data-testid="material-stock"][data-state="ready"]', { timeout: 60_000 })
{
  const orderNow = page.locator('[data-testid="material-order-now"]')
  const orderBy = orderNow.locator('text=/^Order by /i')
  const text = (await orderNow.innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
  facts.orderNow = {
    count: await orderBy.count(),
    first: text[0] ?? '',
    by: (await orderBy.first().innerText().catch(() => ''))
      .replace(/^order by\s*/i, '')
      .trim()
      .replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    lead: text.find((l) => /day lead/.test(l))?.match(/(\d+) day lead/)?.[1] ?? '',
  }
  const leather = page.locator('[data-testid="material-stock"] tbody tr:has-text("Leather")').first()
  const hasLeather = (await leather.count()) > 0
  const stockRows = page.locator('[data-testid="material-stock"] tbody tr')
  await mark([
    { n: 1, at: title('Order now, or it will be late'), where: 'right', dx: 6 },
    ...(facts.orderNow.count ? [{ n: 2, at: orderBy.first(), where: 'left', dx: -2 }] : []),
    { n: 3, at: title('Against the store'), where: 'right', dx: 6 },
    ...(hasLeather ? [{ n: 4, at: leather.locator('td').first(), where: 'left', dx: 2 }] : []),
  ])
  const last = hasLeather ? leather : stockRows.nth(Math.min(5, (await stockRows.count()) - 1))
  await shot('material', await topOf(title('Order now, or it will be late'), 30), await bottomOf(last, 6))
}

// --- production: the routines every department uses --------------------------
const ourGood = () => page.locator(`input[aria-label^="Good, ${ERP}"]:visible`).first()
const ourRejected = () => page.locator(`input[aria-label^="Rejected, ${ERP}"]:visible`).first()
const rowOfGood = () => page.locator(`tr:visible:has(input[aria-label^="Good, ${ERP}"])`).first()

async function openProduction(code, date) {
  await go('#/production', '[data-testid="production-department"]')
  await page.selectOption('[data-testid="production-department"]', code)
  await page.fill('[data-testid="production-date"]', date)
  await page.waitForFunction(
    (d) =>
      document.querySelector('[data-testid="production-date"]')?.value === d &&
      !document.querySelector('[data-testid="production-waiting"]') &&
      (document.querySelector('[data-testid="production-worklist"]') || document.querySelector('[data-testid="production-empty"]')),
    date,
    { timeout: 60_000 },
  )
  await settle(400)
}

/** The day's planned figure on our row, as the screen prints it. */
async function plannedOnRow() {
  const cells = await rowOfGood().locator('td').allInnerTexts()
  return num(cells[2])
}

async function saveRow() {
  // On a desk the row saves on Enter and the last cell reads Entered; the
  // word is gone while the row is dirty, so waiting for it is waiting for
  // the save.
  await ourGood().press('Enter')
  await rowOfGood().locator('td').last().locator('text=Entered').waitFor({ timeout: 60_000 })
}

/**
 * Declares a department's whole job for this order, a day at a time, exactly
 * as the plan asked for it — the last day takes whatever is left so the
 * department's total comes to what it must make.
 */
async function declareDepartment(d, { rejectedOnFirstDay = 0 } = {}) {
  let made = 0
  let first = true
  for (let date = d.start; date <= d.end; date = plusDays(date, 1)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    await openProduction(d.code, date)
    if (!(await ourGood().count())) continue
    const planned = await plannedOnRow()
    const isLast = plusDays(date, 1) > d.end
    // The figure on the bar is rounded and the requirement carries yield
    // (279.4 shows as 279), so the last day makes one piece over — as a
    // floor does — and the department is complete rather than a fraction short.
    const good = isLast ? Math.max(1, Math.ceil(d.qty - made) + 1) : Math.round(planned)
    if (good <= 0) continue
    await ourGood().fill(String(good))
    if (first && rejectedOnFirstDay) await ourRejected().fill(String(rejectedOnFirstDay))
    await saveRow()
    made += good
    first = false
  }
  if (made < d.qty) throw new Error(`${d.name}: declared ${made} of ${d.qty}`)
  return made
}

/** Counts in everything handed to a department for this order. */
async function countIn(code, { shortBy = 0 } = {}) {
  await go('#/production', '[data-testid="production-department"]')
  await page.selectOption('[data-testid="production-department"]', code)
  await settle(800)
  const received = () => page.locator(`input[aria-label^="Received, ${ERP}"]:visible`).first()
  let first = true
  while (await received().count()) {
    const row = page.locator(`tr:visible:has(input[aria-label^="Received, ${ERP}"])`).first()
    if (first && shortBy) {
      const declared = Number(await received().inputValue())
      await received().fill(String(declared - shortBy))
    }
    const before = await page.locator(`input[aria-label^="Received, ${ERP}"]`).count()
    await row.locator('button:has-text("Count in")').click()
    await page.waitForFunction(
      ({ erp, n }) => document.querySelectorAll(`input[aria-label^="Received, ${erp}"]`).length < n,
      { erp: ERP, n: before },
      { timeout: 60_000 },
    )
    await settle(400)
    first = false
  }
}

const plan = facts.plan
const byCode = new Map(plan.map((p) => [p.code, p]))
const order = plan.map((p) => p.code)
const indexOf = (code) => order.indexOf(code)

// --- 5 · the first department's first day ------------------------------------
console.log('production: the first day')
const firstDept = plan[0]
await openProduction(firstDept.code, firstDept.start)
await ourGood().waitFor({ timeout: 60_000 })
facts.firstDay = { dept: firstDept.name, date: firstDept.start, planned: await plannedOnRow(), total: firstDept.qty }
await mark([
  { n: 1, at: page.locator('[data-testid="production-department"]'), where: 'inside-right', dx: -34 },
  { n: 2, at: page.locator('[data-testid="production-date"]'), where: 'inside-right', dx: -30 },
])
{
  const strip = page.locator('[data-testid="production-department"]')
  await shot('production-top', await topOf(strip, 40), await bottomOf(page.locator('[data-testid="production-date"]'), 14))
  await mark([
    { n: 3, at: rowOfGood().locator('td').nth(2), where: 'inside', dx: 4, dy: 10 },
    { n: 4, at: ourGood(), where: 'inside', dx: 6, dy: 14 },
    { n: 5, at: ourRejected(), where: 'inside', dx: 6, dy: 14 },
    { n: 6, at: rowOfGood().locator('td').last(), where: 'right', dx: -8 },
  ])
  const panelTop = await topOf(title('What you were asked for'), 30)
  await shot('production-before', panelTop, await bottomOf(page.locator('[data-testid="production-worklist"]'), 10))
  await ourGood().fill(String(Math.round(facts.firstDay.planned)))
  await saveRow()
  await mark([{ n: 7, at: rowOfGood().locator('td').last().locator('span').first(), where: 'left', dx: -2, ring: true }])
  await shot('production-after', panelTop, await bottomOf(page.locator('[data-testid="production-worklist"]'), 10))
}
// The rest of its days, as planned.
{
  const d = firstDept
  let made = Math.round(facts.firstDay.planned)
  for (let date = plusDays(d.start, 1); date <= d.end; date = plusDays(date, 1)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    await openProduction(d.code, date)
    if (!(await ourGood().count())) continue
    const isLast = plusDays(date, 1) > d.end
    const good = isLast ? Math.max(1, Math.ceil(d.qty - made) + 1) : Math.round(await plannedOnRow())
    if (good <= 0) continue
    await ourGood().fill(String(good))
    await saveRow()
    made += good
  }
  if (made <= d.qty) {
    // A short plan is topped up on its last day, one over.
    await openProduction(d.code, d.end)
    await ourGood().fill(String(Math.ceil(d.qty - made + Number(await ourGood().inputValue())) + 1))
    await saveRow()
  }
}

// --- 6 · the handover ---------------------------------------------------------
// Assembly is fed by two departments; it counts in what each one sent. The
// second one declares first, then the picture is taken on Assembly's screen
// with two pieces short of what Ply Cutting said.
console.log('production: the wood side, and the handover')
const feedersOfAssembly = plan.slice(1, indexOf('ASSY'))
for (const d of feedersOfAssembly) {
  await countIn(d.code)
  await declareDepartment(d)
}
await go('#/production', '[data-testid="production-department"]')
await page.selectOption('[data-testid="production-department"]', 'ASSY')
await page.waitForSelector('[data-testid="pending-acceptance"]', { timeout: 60_000 })
await settle(600)
{
  const received = page.locator(`input[aria-label^="Received, ${ERP}"]:visible`).first()
  const row = page.locator(`tr:visible:has(input[aria-label^="Received, ${ERP}"])`).first()
  const declared = Number(await received.inputValue())
  facts.handover = {
    to: 'Assembly',
    from: (await row.locator('td').first().innerText()).trim().split(/\s*·\s*|\n/)[0],
    declared,
    received: declared - 2,
  }
  await received.fill(String(declared - 2))
  const shortfall = page.locator('[data-testid="shortfall"]:visible').first()
  await shortfall.waitFor({ timeout: 10_000 })
  facts.handover.shortfall = (await shortfall.innerText()).trim()
  await mark([
    { n: 1, at: row.locator('td').first(), where: 'left', dx: 2 },
    { n: 2, at: row.locator('td').nth(3), where: 'inside', dx: 4, dy: 12 },
    { n: 3, at: received, where: 'inside', dx: 6, dy: 14 },
    { n: 4, at: shortfall, where: 'below', dy: 4 },
    { n: 5, at: row.locator('button:has-text("Count in")'), where: 'right', dx: 2, ring: true },
  ])
  const panel = page.locator('[data-testid="pending-acceptance"]')
  await shot('handover', await topOf(title('Handed to you, not yet counted in'), 30), await bottomOf(panel, 10))
}
await countIn('ASSY', { shortBy: 2 })

// Through the wood side: assembly, sanding (with four rejected), the finishes.
const woodSide = plan.slice(indexOf('ASSY'), indexOf('FOAM'))
for (const d of woodSide) {
  if (d.code !== 'ASSY') await countIn(d.code)
  await declareDepartment(d, { rejectedOnFirstDay: d.code === 'SAND' ? 4 : 0 })
}
facts.rejectedAt = { dept: byCode.get('SAND')?.name ?? 'Sanding', qty: 4 }
facts.declaredSoFar = woodSide.length + feedersOfAssembly.length + 1

// --- 7 · where is it now -----------------------------------------------------
console.log('wip, half-way')
await go('#/wip', '[data-testid="wip-running"][data-state="ready"]')
{
  const line = page.locator(`[data-testid="wip-running"] [data-testid="wip-line"]:has-text("${ERP}")`).first()
  await line.waitFor({ timeout: 60_000 })
  await line.locator('button').first().click()
  await settle(400)
  const text = await line.innerText()
  facts.wipMid = {
    percent: text.match(/(\d+)%/)?.[1] ?? '',
    departments: (text.match(/(\d+) of (\d+) departments/i)?.[0] ?? '').toLowerCase(),
    container: (text.match(/container in \d+d/i)?.[0] ?? '').toLowerCase(),
  }
  const strip = line.locator('div.flex.gap-0\\.5').first()
  await mark([
    { n: 1, at: line.locator('.text-title').first(), where: 'left', dx: -2 },
    { n: 2, at: strip, where: 'left', dx: -2 },
    { n: 3, at: line.locator('.border-t').first(), where: 'inside', dx: -40, dy: 6 },
  ])
  const b = await box(line)
  await shot('wip-running', await topOf(title('In progress'), 30), b.y + b.height + 10)
}

// --- 8 · on the wall ----------------------------------------------------------
console.log('floor display')
await go('#/display', '[data-testid="display-department"]')
await page.selectOption('[data-testid="display-department"]', 'STITCH')
await page.waitForSelector('[data-testid="display-waiting"][data-state="ready"]', { timeout: 60_000 })
await page.waitForSelector('[data-testid="display-today"][data-state="ready"]', { timeout: 60_000 })
await settle(600)
{
  const waiting = page.locator('[data-testid="display-waiting"]')
  const today = page.locator('[data-testid="display-today"]')
  facts.display = {
    dept: 'Stitching',
    today: (await today.innerText()).replace(/\s+/g, ' ').trim().slice(0, 120),
    waiting: (await waiting.innerText()).replace(/\s+/g, ' ').trim().slice(0, 160),
    headline: (await page.locator('[data-testid="floor-display"]').innerText()).split('\n').slice(0, 3).join(' · ').trim(),
  }
  await shot('display', 0, await bottomOf(waiting, 24))
}

// --- 9 · the plan learns ------------------------------------------------------
console.log('run, and the schedule again')
await go('', 'text=Bottleneck utilisation')
await page.click('button:has-text("Run the schedule")')
await page.waitForSelector('button:has-text("Scheduling…")', { timeout: 10_000 }).catch(() => {})
await page.waitForSelector('button:has-text("Run the schedule")', { timeout: 180_000 })
await settle(1500)
{
  const g = await openOurOrder()
  await g.locator('[data-testid="gantt-made"]').first().waitFor({ timeout: 30_000 })
  facts.madeCount = await g.locator('[data-testid="gantt-made"]').count()
  facts.remainingBars = await g.locator('[data-testid="gantt-bar"]').count()
  await mark([
    { n: 1, at: g.locator('[data-testid="gantt-made"]').first(), where: 'left', dx: -2 },
    { n: 2, at: g.locator('[data-testid="gantt-bar"]').first(), where: 'right' },
  ])
  const b = await box(g)
  await shot('schedule-made', await topOf(title('Schedule'), 30), b.y + b.height + 10)
}

// --- the rest of the route, to the door -------------------------------------
console.log('production: upholstery, fitting, QC, packing')
for (const d of plan.slice(indexOf('FOAM'))) {
  await countIn(d.code)
  await declareDepartment(d)
}

// --- 10 · ready to stuff -----------------------------------------------------
console.log('wip, finished, and the dashboard')
await go('#/wip', '[data-testid="wip-ready"][data-state="ready"]')
{
  const line = page.locator(`[data-testid="wip-ready"] [data-testid="wip-line"]:has-text("${ERP}")`).first()
  await line.waitFor({ timeout: 60_000 })
  const text = await line.innerText()
  facts.wipReady = {
    percent: text.match(/(\d+)%/)?.[1] ?? '',
    departments: (text.match(/(\d+) of (\d+) departments/i)?.[0] ?? '').toLowerCase(),
    // `has` is matched inside each candidate, so the inner locator must not start from `section`.
    meta: (await page.locator('section').filter({ has: page.locator('header > b', { hasText: 'Ready to stuff' }) }).first().locator('header').innerText()).replace(/\s+/g, ' ').trim(),
  }
  await mark([
    { n: 1, at: title('Ready to stuff'), where: 'right', dx: 6 },
    { n: 2, at: line.locator('.text-title').first(), where: 'left', dx: -2 },
    { n: 3, at: line.locator('div.flex.gap-0\\.5').first(), where: 'left', dx: -2 },
  ])
  const b = await box(line)
  await shot('wip-ready', await topOf(title('Ready to stuff'), 30), b.y + b.height + 10)
}
await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
{
  const kpis = page.locator('[data-testid="md-kpis"]')
  const text = await kpis.innerText()
  const read = (label) => text.match(new RegExp(`${label}\\s*\\n\\s*([^\\n]+)`, 'i'))?.[1].trim() ?? ''
  facts.dashboard = { containersReady: read('Containers ready'), ordersRunning: read('Orders running'), delayed: read('Delayed orders') }
  const tile = kpis.locator('.label', { hasText: /Containers ready/i }).first()
  // And the fortnight below it: the grid of made against planned, which is
  // where this order's days were entered.
  await page.waitForSelector('[data-testid="production-vs-plan"][data-state="ready"]', { timeout: 60_000 })
  const grid = page.locator('[data-testid="plan-vs-made-grid"]')
  await grid.waitFor({ timeout: 30_000 })
  facts.dashboard.gridDepartments = Number(await grid.getAttribute('data-departments'))
  await mark([
    { n: 1, at: tile, where: 'left', dx: -2, ring: true },
    { n: 2, at: grid, where: 'top-left', dx: -6, dy: -2 },
  ])
  await shot('dashboard', await topOf(title('Is the factory on track today?'), 30), await bottomOf(grid, 44))
}

await browser.close()
stopServer()

facts.generatedAt = new Date().toISOString()
facts.shots = shots
await writeFile(`${outDir}/facts.json`, JSON.stringify(facts, null, 1))
await writeFile(`${repoRoot}docs/order-journey.html`, journeyPage({ facts }))
console.log(`\nWrote docs/order-journey.html and ${Object.keys(shots).length} pictures.`)

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s) while capturing:`)
  for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  process.exit(1)
}
