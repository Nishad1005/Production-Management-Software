/**
 * A mock run: five of U&M's items, six orders that overlap, and three days of
 * entries made the way the HODs would make them — attendance, end-of-day
 * actuals against targets, handovers, a machine down, a stock count, a
 * what-if — with the plan re-run after each day and every screen read
 * afterwards. The manual of it is DBBS/UM/KRAM/13, docs/mock-run.html.
 *
 *   node scripts/make-mock-run.mjs [baseUrl] [email password]
 *       [--items=code,code,code,code,code]   five article codes, in the roles
 *                                           A B C D E (see ORDERS below)
 *       [--clear=PREFIX,PREFIX]              remove orders whose number starts
 *                                           so, through the Order book, first
 *       [--page-only]                        rebuild the words from the last facts
 *   node scripts/make-pdf.mjs docs/mock-run.html
 *
 * On the demonstration build (the default) it runs against the six U&M
 * articles the demo carries, on invented speeds; against the live site (a
 * baseUrl and a login, as the walkthrough takes them) it runs on the real
 * item master, and nothing of it is done except through the screens, as a
 * user would do it — the same rule as KRAM/09. Every figure the manual quotes
 * is read off the screen in the same visit as its picture. A console error
 * fails the run.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { mockRunPage } from './lib/mock-run-page.mjs'
import { box as boxIn, mark as markIn } from './lib/marks.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const plain = args.filter((a) => !a.startsWith('--'))
const option = (name, fallback) => [...flags].find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const baseUrl = plain.find((a) => /^https?:/.test(a)) ?? 'http://localhost:5173'
const [email, password] = plain.filter((a) => !/^https?:/.test(a))
const outDir = `${repoRoot}docs/mock-run`
const factsFile = `${outDir}/facts.json`
await mkdir(outDir, { recursive: true })

if (flags.has('--page-only')) {
  const facts = JSON.parse(await readFile(factsFile, 'utf8'))
  await writeFile(`${repoRoot}docs/mock-run.html`, mockRunPage({ facts }))
  console.log('Wrote docs/mock-run.html from the last facts.')
  process.exit(0)
}

// --- the scenario -------------------------------------------------------------
// Five items in five roles. The demonstration build carries six of U&M's
// articles; the live site the whole master, where the five with D-minus from
// U&M's own sheet are the ones to use (--items).
const ITEMS = option('items', 'UT263 SPWL COU,UD354 SPPL WAL,125034299,125034308,UO265 DEN VBR').split(',')
if (ITEMS.length !== 5) throw new Error('--items needs exactly five article codes')
const [A, B, C, D, E] = ITEMS
const CLEAR = option('clear', 'SO/26-27/,SAMPLE-,MOCK-').split(',').filter(Boolean)

const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const plusDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const isSunday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 0
const notSunday = (iso) => (isSunday(iso) ? plusDays(iso, 1) : iso)
const nextWorking = (iso) => {
  let d = plusDays(iso, 1)
  while (isSunday(d)) d = plusDays(d, 1)
  return d
}
const today = local(new Date())
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000)

/**
 * Six orders. The container date of each is not fixed: it is worked out from
 * the item's own D-minus so that the order's first department starts on day
 * 1 of the run, plus `shift` days — the same weeks for the first three (the
 * overlap), later for the two-container order and the second order of an
 * item already running, and twenty days too soon for the one the check
 * refuses. On any venue, with any D-minus, the floor then has work on the
 * three days the HODs enter. `why` is what the manual says about each.
 */
const ORDERS = [
  { erp: 'MOCK-01', item: A, qty: 240, shift: 0, customer: 0, why: 'fits on its own' },
  { erp: 'MOCK-02', item: B, qty: 300, shift: 0, customer: 1, why: 'the same weeks and the same route as MOCK-01: the overlap' },
  { erp: 'MOCK-03', item: C, qty: 180, shift: 0, customer: 0, why: 'a third stream on the same departments' },
  { erp: 'MOCK-04', item: D, qty: 120, shift: 7, customer: 1, secondLine: { qty: 120, shift: 28 }, why: 'one order, two containers' },
  { erp: 'MOCK-05', item: E, qty: 400, shift: -20, customer: 0, anyway: 'Customer insists; overtime in Stitching agreed', why: 'the check refuses it, and it is taken anyway' },
  { erp: 'MOCK-06', item: A, qty: 150, shift: 21, customer: 1, why: 'a second order of an item already running' },
]
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12 }
const isoOf = (long) => {
  const m = /^(\d+) (\w+) (\d{4})$/.exec(String(long ?? '').trim())
  return m ? `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null
}

// --- a server, if nothing is listening --------------------------------------
const alive = async (url) => {
  try {
    return (await fetch(url)).ok
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
  console.log(`Starting the dev server (${email ? 'hosted' : 'demonstration'} build)…`)
  server = spawn('npx', email ? ['vite', '--mode', 'hosted', '--port', '5173'] : ['vite', '--port', '5173', '--strictPort'], {
    stdio: 'ignore',
    detached: true,
  })
  const by = Date.now() + 60_000
  while (!(await alive(baseUrl))) {
    if (Date.now() > by) {
      stopServer()
      console.error('The dev server never came up.')
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
page.on('dialog', (d) => d.accept())
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
const num = (s) => Number(String(s ?? '').replace(/[^\d.-]/g, '')) || 0

const shots = {}
async function shot(name, top, bottom) {
  const height = Math.round(bottom - top)
  await page.screenshot({
    path: `${outDir}/${name}.png`,
    fullPage: true,
    clip: { x: 0, y: Math.max(0, Math.round(top)), width: WIDTH, height },
  })
  shots[name] = { width: WIDTH, height }
  console.log(`  ${name}.png — ${WIDTH}×${height}`)
}

// Day 1 is today, or Monday when today is a Sunday; the orders are dated so
// that their first departments have work on it.
const D1 = isSunday(today) ? nextWorking(today) : today
const facts = { venue: email ? baseUrl.replace(/^https?:\/\//, '') : 'the demonstration build', today, items: ITEMS, orders: ORDERS, days: {} }

// --- boot, and sign in on the hosted build -----------------------------------
console.log('booting')
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
if (email) {
  await page.waitForSelector('text=Sign in', { timeout: 60_000 })
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button:has-text("Sign in")')
}
await page.waitForSelector('text=Bottleneck utilisation', { timeout: 240_000 })
await page.waitForFunction(
  () => /\d|No run/.test(document.querySelector('main')?.innerText ?? ''),
  null,
  { timeout: 120_000 },
)

// Department names by code, from the Production screen's own list.
await go('#/production', '[data-testid="production-department"]')
const departments = await page.$$eval('[data-testid="production-department"] option', (os) =>
  os.map((o) => ({ code: o.value, name: o.textContent.trim() })),
)
const codeOf = new Map(departments.map((d) => [d.name, d.code]))
const nameOf = new Map(departments.map((d) => [d.code, d.name]))
facts.departments = departments

// --- readings: what the screens say, as attributes and figures --------------
const readMain = async (label) => {
  const text = await page.locator('main').innerText()
  return text.match(new RegExp(`${label}\\s*\\n\\s*([^\\n]+)`, 'i'))?.[1].trim() ?? ''
}

async function readCommandCentre() {
  await go('', 'text=Bottleneck utilisation')
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('main')?.innerText.match(/Scheduled tasks\s*\n\s*(\S+)/i)?.[1] ?? ''),
    null,
    { timeout: 120_000 },
  )
  await page.waitForSelector('[data-testid="bottlenecks"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  const constraint = await page
    .locator('tr:has-text("Constraint") td')
    .first()
    .innerText()
    .then((t) => t.replace(/constraint/i, '').trim())
    .catch(() => '')
  return {
    lines: num(await readMain('Shipment lines')),
    tasks: num(await readMain('Scheduled tasks')),
    breaches: num(await readMain('Breaches')),
    flaggedDays: num(await readMain('Flagged days')),
    constraint,
  }
}

async function readAttention() {
  await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
  await page.waitForSelector('[data-testid="attention-warning"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  const kinds = await page.$$eval('[data-testid^="finding-"]', (els) => {
    const out = {}
    for (const el of els) {
      const k = el.getAttribute('data-testid').replace('finding-', '')
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  })
  const mock = await page.$$eval('[data-testid^="finding-"]', (els) =>
    els.map((el) => el.innerText.split('\n').slice(0, 2).join(' — ')).filter((t) => /MOCK-/.test(t)).slice(0, 8),
  )
  return {
    critical: num(await page.locator('[data-testid="attention-critical"]').getAttribute('data-count')),
    warning: num(await page.locator('[data-testid="attention-warning"]').getAttribute('data-count')),
    kinds,
    mock,
  }
}

async function readHeatmap() {
  await go('#/heatmap', '[data-testid="heatmap-grid"]')
  const grid = page.locator('[data-testid="heatmap-grid"]')
  const worst = await page.evaluate(() => {
    let best = null
    for (const b of document.querySelectorAll('[data-testid="heatmap-grid"] button[data-department][data-utilisation]')) {
      const u = Number(b.getAttribute('data-utilisation'))
      if (!best || u > best.utilisation) best = { department: b.getAttribute('data-department'), day: b.getAttribute('data-day') ?? b.title, utilisation: u }
    }
    return best
  })
  const stitch = await page.evaluate(() => {
    let over = 0
    for (const b of document.querySelectorAll('[data-testid="heatmap-grid"] button[data-department="STITCH"][data-utilisation]')) {
      if (Number(b.getAttribute('data-utilisation')) > 1) over++
    }
    return over
  })
  return { over: num(await grid.getAttribute('data-over')), worst, stitchOverDays: stitch }
}

async function readDashboard(date) {
  await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
  await page.waitForSelector('[data-testid="production-vs-plan"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  const kpi = {}
  for (const label of ['Orders running', 'OTIF', 'Daily production', 'WIP in progress', 'Production efficiency', 'Rejections', 'Material shortages', 'Delayed orders', 'Containers ready']) {
    kpi[label] = await readMain(label)
  }
  const grid = await page.evaluate((d) => {
    const g = document.querySelector('[data-testid="plan-vs-made-grid"]')
    if (!g) return null
    const heads = [...g.querySelectorAll('.grid > div[title]')].filter((el) => !el.hasAttribute('data-state'))
    const dayNos = heads.map((h) => h.textContent.trim())
    const target = String(Number(d.slice(8)))
    const col = dayNos.lastIndexOf(target)
    const rows = {}
    for (const btn of g.querySelectorAll('button[data-code]')) {
      const cells = []
      let el = btn.nextElementSibling
      while (el && el.hasAttribute('data-state')) {
        cells.push({ state: el.getAttribute('data-state'), ratio: el.getAttribute('data-ratio'), title: el.title })
        el = el.nextElementSibling
      }
      rows[btn.getAttribute('data-code')] = col >= 0 ? cells[col] : null
    }
    return { days: dayNos.length, rows }
  }, date)
  return { kpi, grid }
}

async function readWip() {
  await go('#/wip', '[data-testid="wip-running"][data-state="ready"]')
  await page.waitForSelector('[data-testid="wip-ready"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  const lines = await page.$$eval('[data-testid="wip-line"]', (els) =>
    els.map((el) => {
      const t = el.innerText
      return {
        erp: t.match(/MOCK-\d+|SO\/[\w/-]+|SAMPLE-[^\n]+/)?.[0] ?? t.split('\n')[0],
        percent: t.match(/(\d+)%/)?.[1] ?? '',
        departments: (t.match(/(\d+) of (\d+) departments/i)?.[0] ?? '').toLowerCase(),
      }
    }),
  )
  return lines.filter((l) => /MOCK-/.test(l.erp))
}

// --- the screens, driven as a user would ------------------------------------
async function run() {
  await go('', 'text=Bottleneck utilisation')
  await page.click('button:has-text("Run the schedule")')
  await page.waitForSelector('button:has-text("Scheduling…")', { timeout: 10_000 }).catch(() => {})
  await page.waitForSelector('button:has-text("Run the schedule")', { timeout: 240_000 })
  await settle(1500)
}

async function clearOrders(prefixes) {
  await go('#/orders', 'text=Order book')
  await page.waitForSelector('[data-testid="order-book-state"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  for (let guard = 0; guard < 40; guard++) {
    const row = page.locator('tbody tr').filter({ hasText: new RegExp(`^(${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`) }).first()
    if (!(await row.count())) break
    const erp = (await row.locator('td').first().innerText()).split('\n')[0].trim()
    await row.click()
    const del = page.locator('button:has-text("Delete this order")').first()
    await del.waitFor({ timeout: 30_000 })
    await del.click()
    await page.waitForFunction((e) => ![...document.querySelectorAll('tbody tr td')].some((td) => td.textContent.trim().startsWith(e)), erp, { timeout: 120_000 })
    await settle(600)
    console.log(`  removed ${erp}`)
  }
}

async function articleOption(selector, code) {
  return page.$eval(selector, (sel, c) => [...sel.options].find((o) => o.textContent.trim().startsWith(c))?.value ?? '', code)
}

/** Check an order on Accept an order; returns the verdict as the screen says it. */
async function check(order) {
  await go('#/accept', 'text=Can we take this order?')
  const value = await articleOption('select', order.item)
  if (!value) throw new Error(`article ${order.item} is not on the list`)
  await page.selectOption('select', value)
  await page.fill('input[type=number]', String(order.qty))
  await page.fill('input[type=date]', order.stuffing)
  await page.click('button:has-text("Check")')
  await page.waitForSelector(`text=/${order.qty} units stuffing/i`, { timeout: 200_000 })
  await page.locator('section > header > b').filter({ hasText: /^(Yes|Not as it stands)$/ }).first().waitFor({ timeout: 200_000 })
  await settle(500)
  const verdict = (await page.locator('text=/steps cannot be made to this date|Every department can make this/').first().innerText()).trim()
  const failing = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr')]
      .filter((r) => !/Clear/i.test(r.lastElementChild?.textContent ?? ''))
      .map((r) => `${r.firstElementChild?.textContent?.trim()}: ${r.lastElementChild?.querySelector('span span')?.textContent?.trim() ?? r.lastElementChild?.textContent?.trim().split('\n')[0] ?? ''}`),
  )
  const name = (await page.locator('select option:checked').innerText()).replace(/^\S+(\s\S+)*?\s+—\s+/, '').trim()
  return { verdict, failing, name, refused: /cannot be made/.test(verdict) }
}

/**
 * Works the container date out from the item's D-minus: checked once far
 * out, the earliest "Starts" the screen prints is the first department's
 * latest start; pulling the date back by that slack puts it on day 1.
 */
async function calibrate(order) {
  const far = notSunday(plusDays(today, 240))
  await check({ ...order, stuffing: far })
  const starts = (
    await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => r.children[3]?.textContent?.trim() ?? ''))
  )
    .map(isoOf)
    .filter(Boolean)
    .sort()
  if (!starts.length) throw new Error(`${order.erp}: the far check placed nothing`)
  const slack = daysBetween(D1, starts[0])
  order.stuffing = notSunday(plusDays(far, -slack + order.shift))
  if (order.secondLine) order.secondLine.stuffing = notSunday(plusDays(far, -slack + order.secondLine.shift))
}

/** From the verdict, into the book: the button, the form, the reason. */
async function takeIt(order, result) {
  await page.click('[data-testid="accept-anyway"]')
  await page.waitForSelector('text=Creates its first shipment line', { timeout: 60_000 })
  const form = page.locator('form').last()
  await form.locator('input[placeholder="SO/26-27/0500"]').fill(order.erp)
  const customers = form.locator('select').first()
  const n = await customers.locator('option').count()
  if (n) await customers.selectOption({ index: Math.min(order.customer, n - 1) })
  if (result.refused) {
    await form.locator('[data-testid="acceptance-note"]').fill(order.anyway ?? 'Taken for the customer relationship')
  }
  await form.locator('button:has-text("Add order")').click()
  await page.waitForSelector(`tbody tr:has-text("${order.erp}")`, { timeout: 180_000 })
  await settle(1200)
}

async function addSecondLine(order) {
  await go('#/orders', 'text=Order book')
  const row = page.locator(`tbody tr:has-text("${order.erp}")`).first()
  await row.click()
  await page.locator('button:has-text("Add a shipment line")').first().click()
  const modal = page.locator('[data-testid="modal"]').last()
  await modal.waitFor({ timeout: 30_000 })
  await modal.locator('input[type=number]').first().fill(String(order.secondLine.qty))
  await modal.locator('input[type=date]').first().fill(order.secondLine.stuffing)
  await modal.locator('button[type=submit]').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), null, { timeout: 180_000 })
  await settle(1200)
}

// --- production, as the HODs enter it -----------------------------------------
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

/** The MOCK rows on the open day: aria-labels of their Good inputs. */
async function mockRows() {
  return page.$$eval('[data-testid="production-worklist"] input[aria-label^="Good, MOCK-"]', (els) =>
    [...new Set(els.map((e) => e.getAttribute('aria-label')))],
  )
}
const rowOf = (label) => page.locator(`tr:visible:has(input[aria-label="${label}"])`).first()

/**
 * Marks who came in for a department on a date: `short` fewer than are on
 * the books. Its own entry, whether or not the department has work that day
 * — attendance is the morning's first thing, before anybody looks at a list.
 */
async function enterAttendance(code, date, short) {
  await openProduction(code, date)
  const people = page.locator('input[aria-label^="People present"]').first()
  if (!(await people.count())) return { onBooks: null, present: null, text: 'no attendance panel' }
  const onBooks = num((await page.locator('text=/\\d+ on the books/').first().innerText().catch(() => '')).match(/(\d+) on the books/)?.[1])
  const present = Math.max(1, onBooks - short)
  await people.fill(String(present))
  await page.locator('[data-testid="todays-capacity"] button:has-text("Save")').first().click()
  await page.waitForFunction((n) => new RegExp(`\\b${n}\\b\\s*of\\s*\\d+ in`).test(document.body.innerText), present, { timeout: 60_000 })
  await settle(500)
  const text = (await page.locator('text=/of \\d+ in/').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  return { onBooks, present, text }
}

/** Enters a day for one department: good = planned × factor, plus rejected on the first row. */
async function enterDay(code, date, { factor = 1, rejected = 0 } = {}) {
  await openProduction(code, date)
  const entries = []
  const attendanceText = (await page.locator('text=/of \\d+ in/').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const labels = await mockRows()
  let first = true
  for (const label of labels) {
    const row = rowOf(label)
    const cells = await row.locator('td').allInnerTexts()
    const planned = num(cells[2])
    const good = Math.max(0, Math.round(planned * factor))
    const good$ = row.locator('input[aria-label^="Good,"]')
    await good$.fill(String(good))
    if (first && rejected) await row.locator('input[aria-label^="Rejected,"]').fill(String(rejected))
    await good$.press('Enter')
    await row.locator('td').last().locator('text=Entered').waitFor({ timeout: 60_000 })
    entries.push({ order: label.replace(/^Good, /, '').split(' ')[0], planned, good, rejected: first ? rejected : 0 })
    first = false
  }
  const header = await page.locator('section').filter({ has: page.locator('header > b', { hasText: 'What you were asked for' }) }).first().locator('header').innerText()
  return { entries, attendance: attendanceText, header: header.replace(/\s+/g, ' ').replace(/^What you were asked for\s*/i, '').trim() }
}

/** Counts in everything handed to a department for the mock orders. */
async function countIn(code, { shortBy = 0 } = {}) {
  await go('#/production', '[data-testid="production-department"]')
  await page.selectOption('[data-testid="production-department"]', code)
  await settle(800)
  const received = () => page.locator('input[aria-label^="Received, MOCK-"]:visible').first()
  let first = true
  let counted = 0
  let shortfall = ''
  while (await received().count()) {
    const row = page.locator('tr:visible:has(input[aria-label^="Received, MOCK-"])').first()
    if (first && shortBy) {
      const declared = Number(await received().inputValue())
      await received().fill(String(declared - shortBy))
      shortfall = (await page.locator('[data-testid="shortfall"]:visible').first().innerText().catch(() => '')).trim()
    }
    const before = await page.locator('input[aria-label^="Received, MOCK-"]').count()
    await row.locator('button:has-text("Count in")').click()
    await page.waitForFunction((n) => document.querySelectorAll('input[aria-label^="Received, MOCK-"]').length < n, before, { timeout: 60_000 })
    await settle(400)
    first = false
    counted++
  }
  return { counted, shortfall }
}

/** Which departments have MOCK work planned on a date, and the day's planned figure. */
async function plannedOn(date) {
  const out = []
  for (const d of departments) {
    await openProduction(d.code, date)
    const labels = await mockRows()
    if (!labels.length) continue
    let planned = 0
    for (const label of labels) planned += num((await rowOf(label).locator('td').allInnerTexts())[2])
    out.push({ code: d.code, name: d.name, rows: labels.length, planned })
  }
  return out
}

/** The plan for one order from the Schedule, per department. */
async function readPlan(erp) {
  await go('#/gantt', '[data-testid="gantt-order"]')
  const g = page.locator(`[data-testid="gantt-order"]:has-text("${erp}")`).first()
  await g.waitFor({ timeout: 60_000 })
  if ((await g.getAttribute('data-expanded')) !== 'yes') await g.locator('button').first().click()
  await settle(400)
  const titles = await g.locator('[data-testid="gantt-bar"]').evaluateAll((bars) => bars.map((b) => b.title))
  const made = await g.locator('[data-testid="gantt-made"]').count()
  const bars = titles
    .map((t) => {
      const m = /^(.+?): (\d+ \w+ \d{4}) → (\d+ \w+ \d{4}) · ([\d,]+) units(?: · (.*?))? — drag/.exec(t)
      return m ? { code: codeOf.get(m[1]) ?? m[1], name: m[1], start: isoOf(m[2]), end: isoOf(m[3]), qty: num(m[4]), reason: m[5] ?? '' } : null
    })
    .filter(Boolean)
  const breaches = num(await g.getAttribute('data-breaches'))
  return { bars, made, breaches }
}

async function readPlans(list) {
  const out = {}
  for (const o of list) out[o.erp] = await readPlan(o.erp)
  return out
}

// =============================================================================
// Day 0 — the orders, and what the plan said
// =============================================================================
console.log('day 0: clearing the book')
if (CLEAR.length) await clearOrders(CLEAR)

console.log('day 0: six orders through Accept an order')
facts.verdicts = []
for (const order of ORDERS) {
  await calibrate(order)
  const result = await check(order)
  order.name = result.name
  facts.verdicts.push({ erp: order.erp, item: order.item, name: result.name, qty: order.qty, stuffing: order.stuffing, ...result })
  console.log(`  ${order.erp} ${result.name}: ${result.verdict}`)
  if (order.erp === 'MOCK-01') {
    await mark([{ n: 1, at: page.locator('text=/steps cannot be made to this date|Every department can make this/').first(), where: 'left', dx: -6 }])
    const rows = page.locator('tbody tr')
    await shot('d0-accept-m01', await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(Math.min(7, (await rows.count()) - 1)), 6))
  }
  if (order.erp === 'MOCK-05') {
    const flagged = page.locator('tbody tr').filter({ hasNotText: /Clear/ })
    await mark([
      { n: 1, at: page.locator('text=/steps cannot be made to this date|Every department can make this/').first(), where: 'left', dx: -6 },
      ...((await flagged.count()) ? [{ n: 2, at: flagged.first().locator('td').last().locator('span').first(), where: 'right', dx: 4 }] : []),
      { n: 3, at: page.locator('[data-testid="accept-anyway"]'), where: 'right', dx: 4 },
    ])
    const rows = page.locator('tbody tr')
    await shot('d0-accept-m05', await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(Math.min(7, (await rows.count()) - 1)), 6))
  }
  await takeIt(order, result)
  if (order.secondLine) await addSecondLine(order)
}

// The book, with the tag on MOCK-05.
await go('#/orders', 'text=Order book')
await page.waitForSelector('[data-testid="order-book-state"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
{
  const rows = page.locator('tbody tr').filter({ hasText: /MOCK-/ })
  await mark([
    { n: 1, at: rows.first().locator('td').first(), where: 'left', dx: 2 },
    { n: 2, at: page.locator('[data-testid="order-against-plan"]').first(), where: 'right', dx: 4 },
    { n: 3, at: rows.first().locator('td').last(), where: 'right', dx: -8 },
  ])
  facts.book = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())))
  await shot('d0-book', await topOf(page.locator('thead').first(), 10), await bottomOf(rows.last(), 6))
}

console.log('day 0: what the plan said')
facts.plans0 = {}
for (const o of ORDERS) facts.plans0[o.erp] = await readPlan(o.erp)
{
  // The Schedule, every mock line collapsed into its span.
  await go('#/gantt', '[data-testid="gantt-order"]')
  await page.locator('[data-testid="gantt-collapse-all"]').click().catch(() => {})
  await settle(400)
  const groups = page.locator('[data-testid="gantt-order"]').filter({ hasText: /MOCK-/ })
  await mark([
    { n: 1, at: groups.first().locator('span.font-semibold').first(), where: 'left', dx: 0 },
    { n: 2, at: groups.last().locator('span.font-semibold').first(), where: 'left', dx: 0 },
  ])
  await shot('d0-schedule', await topOf(title('Schedule'), 30), await bottomOf(groups.last(), 10))
}
facts.days.d0 = {
  commandCentre: await readCommandCentre(),
  heatmap: await readHeatmap(),
  attention: await readAttention(),
  dashboard: await readDashboard(D1),
}
{
  await go('', 'text=Bottleneck utilisation')
  await page.waitForSelector('[data-testid="bottlenecks"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  const rows = page.locator('tr:has-text("Constraint") ~ tr')
  await mark([
    { n: 1, at: page.locator('.label:text-is("Breaches")'), where: 'right' },
    { n: 2, at: page.locator('.label:text-is("Flagged days")'), where: 'right' },
    { n: 3, at: page.locator('tr:has-text("Constraint") >> text=/^Constraint$/i'), where: 'right' },
  ])
  await shot('d0-command-centre', 0, await bottomOf(rows.nth(Math.min(2, (await rows.count()) - 1)), 6))
  await go('#/heatmap', '[data-testid="heatmap-grid"]')
  const grid = page.locator('[data-testid="heatmap-grid"]')
  await mark([{ n: 1, at: grid, where: 'top-left', dx: -6, dy: -2 }])
  await shot('d0-heatmap', await topOf(title('Load heatmap'), 30).catch(async () => (await box(grid)).y - 60), await bottomOf(grid, 10))
  await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
  const findings = page.locator('[data-testid^="finding-"]')
  await shot('d0-attention', (await box(page.locator('header.gridpaper'))).y - 8, await bottomOf(findings.nth(Math.min(3, (await findings.count()) - 1)), 10))
}

// =============================================================================
// Three days on the floor
// =============================================================================
const D2 = nextWorking(D1)
const D3 = nextWorking(D2)
facts.dates = { D1, D2, D3 }

async function hodDay(label, date, rules) {
  console.log(`${label}: the floor`)
  const planned = await plannedOn(date)
  const entered = []
  for (const dept of planned) {
    const rule = rules[dept.code] ?? {}
    const r = await enterDay(dept.code, date, rule)
    entered.push({ code: dept.code, name: dept.name, ...r })
    console.log(`  ${dept.name}: ${r.header}`)
  }
  return { planned, entered }
}

// --- Day 1 --------------------------------------------------------------------
facts.days.d1 = {}
console.log('day 1: attendance')
facts.days.d1.attendance = { STITCH: await enterAttendance('STITCH', D1, 2) }
console.log(`  Stitching: ${facts.days.d1.attendance.STITCH.text}`)
facts.days.d1.floor = await hodDay('day 1', D1, {
  MACHINE: { factor: 0.5 },
  PLYCUT: { rejected: 4 },
})
{
  // Pictures: Stitching's day with its attendance, Machining's shortfall.
  await openProduction('STITCH', D1)
  if (await page.locator('input[aria-label^="People present"]').count()) {
    await mark([
      { n: 1, at: page.locator('input[aria-label^="People present"]').first(), where: 'inside', dx: 6, dy: 14 },
      { n: 2, at: page.locator('text=/of \\d+ in/').first(), where: 'right', dx: 4 },
    ])
    await shot('d1-stitching-attendance', await topOf(title('What you can do today'), 30), await bottomOf(page.locator('[data-testid="todays-capacity"]'), 10))
  }
  await openProduction('MACHINE', D1)
  if (await page.locator('[data-testid="production-worklist"]').count()) {
    await mark([{ n: 1, at: page.locator('[data-testid="production-worklist"] tr:visible').nth(1).locator('td').nth(2), where: 'inside', dx: 4, dy: 10 }])
    await shot('d1-machining', await topOf(title('What you were asked for'), 30), await bottomOf(page.locator('[data-testid="production-worklist"]'), 10))
  }
}
await run()
facts.days.d1.after = {
  commandCentre: await readCommandCentre(),
  attention: await readAttention(),
  dashboard: await readDashboard(D1),
  wip: await readWip(),
  plans: await readPlans(ORDERS.slice(0, 3)),
}
{
  await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
  await page.waitForSelector('[data-testid="plan-vs-made-grid"]', { timeout: 60_000 })
  const grid = page.locator('[data-testid="plan-vs-made-grid"]')
  const machineRow = grid.locator('button[data-code="MACHINE"]')
  await mark([
    { n: 1, at: grid, where: 'top-left', dx: -6, dy: -2 },
    ...((await machineRow.count()) ? [{ n: 2, at: machineRow, where: 'inside-right', dx: -6 }] : []),
  ])
  await shot('d1-dashboard-grid', await topOf(title('Planned against made'), 30), await bottomOf(grid, 44))
}

// --- Day 2 --------------------------------------------------------------------
console.log('day 2: counting in, and a machine down')
facts.days.d2 = { handovers: {} }
for (const d of departments) {
  const r = await countIn(d.code, { shortBy: d.code === 'ASSY' ? 2 : 0 })
  if (r.counted) facts.days.d2.handovers[d.code] = r
}
// The picture of the handover is of Assembly before it counted in; taken on
// a second order's rows where they exist, by re-opening the screen.
{
  await go('#/masters?tab=machines', '[data-testid="machines-master"]')
  await settle(600)
  const before = await page.locator('[data-testid="machines-short-STITCH"]').getAttribute('data-available').catch(() => null)
  await page.click('[data-testid="book-downtime"]')
  const modal = page.locator('[data-testid="modal"]')
  await modal.waitFor()
  const machine = await modal.locator('select').first().evaluate((sel) => [...sel.options].find((o) => o.value.startsWith('STITCH'))?.value ?? '')
  if (machine) {
    await modal.locator('select').first().selectOption(machine)
    const dates = modal.locator('input[type=date]')
    // From today through day 2: every "day" of the run is entered on the
    // same real day, and the machines-available figure is today's.
    if ((await dates.count()) >= 2) {
      await dates.nth(0).fill(D1)
      await dates.nth(1).fill(D2)
    }
    await modal.getByPlaceholder('Hook timing gone — spares ordered').fill('Thread take-up lever bent')
    await modal.locator('button:has-text("Book it")').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), null, { timeout: 60_000 })
    await settle(800)
  }
  const after = await page.locator('[data-testid="machines-short-STITCH"]').getAttribute('data-available').catch(() => null)
  const machines = await page.locator('[data-testid="machines-short-STITCH"]').getAttribute('data-machines').catch(() => null)
  facts.days.d2.machine = { machine, before, after, machines }
  await mark([{ n: 1, at: page.locator(`[data-testid="machine-${machine}"]`).first(), where: 'left', dx: 2 }]).catch(() => {})
  await shot('d2-machines', await topOf(page.locator('[data-testid="machines-master"]'), 60), await bottomOf(page.locator('[data-testid="machines-master"]'), 10))
}
facts.days.d2.floor = await hodDay('day 2', D2, {
  MACHINE: { factor: 0.85 },
})
await run()
facts.days.d2.after = {
  commandCentre: await readCommandCentre(),
  attention: await readAttention(),
  dashboard: await readDashboard(D2),
  wip: await readWip(),
}
{
  await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
  const findings = page.locator('[data-testid^="finding-"]')
  const machineCard = page.locator('[data-testid="finding-machine-down"]').first()
  if (await machineCard.count()) await mark([{ n: 1, at: machineCard, where: 'inside', dx: -40, dy: 0 }])
  await shot('d2-attention', (await box(page.locator('header.gridpaper'))).y - 8, await bottomOf(findings.nth(Math.min(3, (await findings.count()) - 1)), 10))
  await go('#/board', 'text=What you owe')
  await page.selectOption('[data-testid="board-department"]', 'ASSY')
  await page.waitForSelector('[data-testid="board-queue"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await page.waitForSelector('[data-testid="board-inbound"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  facts.days.d2.board = (await page.locator('[data-testid="board-inbound"]').innerText()).replace(/\s+/g, ' ').slice(0, 400)
  await shot('d2-board-assembly', await topOf(title('Holding you up'), 30), await bottomOf(page.locator('[data-testid="board-inbound"]'), 10))
  await go('#/display', '[data-testid="display-department"]')
  await page.selectOption('[data-testid="display-department"]', 'STITCH')
  await page.waitForSelector('[data-testid="display-waiting"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await page.waitForSelector('[data-testid="display-today"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await settle(600)
  facts.days.d2.display = (await page.locator('[data-testid="floor-display"]').innerText()).split('\n').slice(0, 3).join(' · ')
  await shot('d2-display', 0, await bottomOf(page.locator('[data-testid="display-waiting"]'), 24))
}

// --- Day 3 --------------------------------------------------------------------
console.log('day 3: a stock count, a what-if, catching up')
facts.days.d3 = {}
for (const d of departments) await countIn(d.code)
{
  await go('#/material', '[data-testid="material-stock"][data-state="ready"]')
  const target = page.locator('[data-testid^="material-"][data-status="short"], [data-testid^="material-"][data-status="not counted"]').first()
  if (await target.count()) {
    const code = (await target.getAttribute('data-testid')).replace('material-', '')
    const status = await target.getAttribute('data-status')
    await target.locator('button').first().click()
    const input = page.locator('input[type=number]:visible').first()
    await input.fill('9000')
    await input.press('Enter')
    await page.waitForFunction((c) => document.querySelector(`[data-testid="material-${c}"]`)?.getAttribute('data-status') === 'covered', code, { timeout: 60_000 })
    facts.days.d3.material = { code, before: status, after: 'covered' }
    await mark([{ n: 1, at: page.locator(`[data-testid="material-${code}"]`), where: 'left', dx: 2 }])
    await shot('d3-material', await topOf(title('Against the store'), 30), await bottomOf(page.locator(`[data-testid="material-${code}"]`), 10))
  }
  await go('#/whatif', 'text=Try a change')
  await page.fill('input[placeholder="Second shift on stitching through November"]', 'Second shift in Stitching')
  await page.selectOption('form select', { label: nameOf.get('STITCH') ?? 'Stitching' })
  await page.click('button:text-is("Second shift")')
  await page.click('button:has-text("Run it")')
  await page.waitForSelector('text=What changed', { timeout: 240_000 })
  await settle(800)
  facts.days.d3.whatIf = {
    breachesNow: num(await readMain('Breaches now')),
    breachesThen: num(await readMain('Breaches in this scenario')),
    flaggedNow: num(await readMain('Flagged days now')),
    flaggedThen: num(await readMain('Flagged days in this scenario')),
    changed: await page.locator('[data-testid="changed-task"]').count(),
  }
  await mark([
    { n: 1, at: page.locator('.label:text-is("Breaches now")'), where: 'right' },
    { n: 2, at: page.locator('.label:text-is("Breaches in this scenario")'), where: 'right' },
  ])
  await shot('d3-whatif', await topOf(title('Try a change'), 30), await bottomOf(page.locator('.label:text-is("Flagged days in this scenario")'), 60))
}
facts.days.d3.floor = await hodDay('day 3', D3, {
  MACHINE: { factor: 1.25 },
})
await run()
facts.days.d3.after = {
  commandCentre: await readCommandCentre(),
  attention: await readAttention(),
  dashboard: await readDashboard(D3),
  wip: await readWip(),
  plans: await readPlans(ORDERS),
}
{
  await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
  await page.waitForSelector('[data-testid="plan-vs-made-grid"]', { timeout: 60_000 })
  const grid = page.locator('[data-testid="plan-vs-made-grid"]')
  await shot('d3-dashboard', await topOf(title('Is the factory on track today?'), 30), await bottomOf(grid, 44))
  await go('#/wip', '[data-testid="wip-running"][data-state="ready"]')
  const lines = page.locator('[data-testid="wip-running"] [data-testid="wip-line"]').filter({ hasText: /MOCK-/ })
  if (await lines.count()) {
    await lines.first().locator('button').first().click()
    await settle(400)
    await shot('d3-wip', await topOf(title('In progress'), 30), await bottomOf(lines.first(), 10))
  }
  await go('#/quality', '[data-testid="quality-by-department"][data-state="ready"]')
  facts.days.d3.quality = (await page.locator('[data-testid="quality-by-department"]').innerText()).replace(/\s+/g, ' ').slice(0, 300)
  await shot('d3-quality', await topOf(title('Rejections by department'), 30).catch(async () => (await box(page.locator('[data-testid="quality-by-department"]'))).y - 60), await bottomOf(page.locator('[data-testid="quality-by-department"]'), 10))
  await go('#/forecast', '[data-testid="forecast-readiness"][data-state="ready"]')
  facts.days.d3.forecast = {
    declarations: num(await page.locator('[data-testid="forecast-readiness"]').getAttribute('data-declarations')),
    text: (await page.locator('[data-testid="forecast-readiness"]').innerText()).replace(/\s+/g, ' ').slice(0, 240),
  }
  await shot('d3-forecast', await topOf(title('How much of this is worth believing'), 30), await bottomOf(page.locator('[data-testid="forecast-readiness"]'), 10))
}

await browser.close()
stopServer()

facts.generatedAt = new Date().toISOString()
facts.shots = shots
await writeFile(factsFile, JSON.stringify(facts, null, 1))
await writeFile(`${repoRoot}docs/mock-run.html`, mockRunPage({ facts }))
console.log(`\nWrote docs/mock-run.html and ${Object.keys(shots).length} pictures.`)

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s) while capturing:`)
  for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  process.exit(1)
}
