/**
 * A week at U&M on Kram: sixteen orders on U&M's items dated over three
 * months, and five days on the floor entered the way each role would enter
 * them — attendance and overtime, end-of-day actuals against targets with the
 * rejects put down to a cause, handovers counted in, a machine down, a stock
 * count, a pin, a what-if, orders arriving mid-week — with the plan re-run
 * each evening and every screen read afterwards. The document of it is
 * DBBS/UM/KRAM/14, docs/demo-week.html.
 *
 *   node scripts/make-demo-week.mjs [baseUrl] [email password]
 *       [--items=code,code,…]        article codes to spread the orders over
 *                                    (default: every article the Accept
 *                                    screen lists, which on the demonstration
 *                                    build is U&M's six)
 *       [--clear=PREFIX,PREFIX]      remove orders whose number starts so,
 *                                    through the Order book, first
 *       [--days=5]                   how many floor days to enter (rehearsals)
 *       [--page-only]                rebuild the words from the last facts
 *   node scripts/make-pdf.mjs docs/demo-week.html
 *
 * Same rules as KRAM/13: nothing is done except through the screens, as a user
 * would do it; every figure the document quotes is read off the screen in the
 * same visit as its picture; a console error fails the run. Against the live
 * site it writes through every screen and presses Run, which is why it is
 * run from Nishad's own terminal, on a go.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { demoWeekPage } from './lib/demo-week-page.mjs'
import { box as boxIn, mark as markIn } from './lib/marks.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const plain = args.filter((a) => !a.startsWith('--'))
const option = (name, fallback) => [...flags].find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const baseUrl = plain.find((a) => /^https?:/.test(a)) ?? 'http://localhost:5173'
const [email, password] = plain.filter((a) => !/^https?:/.test(a))
const outDir = `${repoRoot}docs/demo-week`
const factsFile = `${outDir}/facts.json`
await mkdir(outDir, { recursive: true })

if (flags.has('--page-only')) {
  const facts = JSON.parse(await readFile(factsFile, 'utf8'))
  await writeFile(`${repoRoot}docs/demo-week.html`, demoWeekPage({ facts }))
  console.log('Wrote docs/demo-week.html from the last facts.')
  process.exit(0)
}

const ITEMS_ARG = option('items', '').split(',').map((s) => s.trim()).filter(Boolean)
const DAYS = Math.max(1, Math.min(5, Number(option('days', '5')) || 5))
const CLEAR = option('clear', 'SO/26-27/,SAMPLE-,MOCK-,DEMO-,PROV-').split(',').filter(Boolean)

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
const prevWorking = (iso) => {
  let d = plusDays(iso, -1)
  while (isSunday(d)) d = plusDays(d, -1)
  return d
}
const today = local(new Date())
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000)

/**
 * Sixteen orders over three months. `item` is an index into the article list;
 * `shift` is days after the earliest date the item fits (worked out from its
 * own D-minus by calibrate(), so the first container of the run has work on
 * day 1 whatever the venue's D-minus says); `fixed` pins a container to a day
 * of the week instead; `enterOn` enters the order during the week rather than
 * before it. `why` is what the document says about each.
 */
const ORDERS = [
  { erp: 'DEMO-01', item: 0, qty: 240, shift: 0, customer: 0, why: 'fits on its own: the first container of the run' },
  { erp: 'DEMO-02', item: 1, qty: 300, shift: 0, customer: 1, why: 'the same weeks and the same route as DEMO-01: the overlap' },
  { erp: 'DEMO-03', item: 2, qty: 180, shift: 3, customer: 2, why: 'a third stream on the same departments' },
  { erp: 'DEMO-04', item: 3, qty: 120, shift: 7, customer: 1, secondLine: { qty: 120, shift: 28 }, why: 'one order, two containers three weeks apart' },
  { erp: 'DEMO-05', item: 4, qty: 400, shift: -20, customer: 0, enterOn: 4, anyway: 'Customer insists; overtime in Stitching agreed', why: 'arrives on day 4, twenty days too soon: the check refuses it, and it is taken anyway with a reason' },
  { erp: 'DEMO-06', item: 5, qty: 10, fixed: -1, customer: 2, anyway: 'Sample set for the buyer, going by air', why: 'ten pieces whose container day was yesterday: carried over, late from the day it is entered, its container day already in the past on the Schedule' },
  { erp: 'DEMO-07', item: 0, qty: 150, shift: 21, customer: 1, enterOn: 2, why: 'arrives on day 2: a second order of an item already running' },
  { erp: 'DEMO-08', item: 1, qty: 60, shift: 35, customer: 2, why: 'a small order a month later' },
  { erp: 'DEMO-09', item: 2, qty: 220, shift: 42, customer: 0, why: 'next month' },
  { erp: 'DEMO-10', item: 3, qty: 90, shift: 49, customer: 1, confidence: 'probable', why: 'probable, not yet confirmed: planned, and marked as such' },
  { erp: 'DEMO-11', item: 4, qty: 260, shift: 56, customer: 2, why: 'next month, the biggest of the run' },
  { erp: 'DEMO-12', item: 5, qty: 200, shift: 63, customer: 0, why: 'the month after' },
  { erp: 'DEMO-13', item: 0, qty: 320, shift: 70, customer: 1, why: 'the month after: a third order of the first item' },
  { erp: 'DEMO-14', item: 1, qty: 140, shift: 77, customer: 2, why: 'the month after' },
  { erp: 'DEMO-15', item: 2, qty: 180, shift: 84, customer: 0, confidence: 'probable', why: 'probable, three months out' },
  { erp: 'DEMO-16', item: 3, qty: 100, shift: 91, customer: 1, why: 'the last container of the run' },
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
const text = async (l) => (await l.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()

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
/** A picture that must not stop the run: a panel that is not there is noted, not fatal. */
const tryShot = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    console.log(`  (no ${name}: ${String(e.message ?? e).split('\n')[0].slice(0, 100)})`)
  }
}

// Day 1 is today, or Monday when today is a Sunday.
const D1 = isSunday(today) ? nextWorking(today) : today
const DATES = [D1]
for (let i = 1; i < 5; i++) DATES.push(nextWorking(DATES[i - 1]))
const dayDate = (n) => DATES[n - 1]
const facts = { venue: email ? baseUrl.replace(/^https?:\/\//, '') : 'the demonstration build', today, orders: ORDERS, dates: { D1: DATES[0], D2: DATES[1], D3: DATES[2], D4: DATES[3], D5: DATES[4] }, daysEntered: DAYS, days: {} }

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

// The articles, from the Accept screen's own list unless given.
await go('#/accept', 'text=Can we take this order?')
await page.waitForFunction(() => document.querySelectorAll('select option').length > 1, null, { timeout: 60_000 })
const listed = await page.$$eval('select option', (os) => os.map((o) => o.textContent.trim().split(/\s+—\s+/)[0]).filter(Boolean))
const ITEMS = ITEMS_ARG.length ? ITEMS_ARG : listed
if (!ITEMS.length) throw new Error('no articles to order')
for (const o of ORDERS) o.code = ITEMS[o.item % ITEMS.length]
facts.items = ITEMS

// --- readings: what the screens say, as attributes and figures --------------
const readMain = async (label) => {
  const t = await page.locator('main').innerText()
  return t.match(new RegExp(`${label}\\s*\\n\\s*([^\\n]+)`, 'i'))?.[1].trim() ?? ''
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
  const demo = await page.$$eval('[data-testid^="finding-"]', (els) =>
    els.map((el) => el.innerText.split('\n').slice(0, 2).join(' — ')).filter((t) => /DEMO-/.test(t)).slice(0, 12),
  )
  return {
    critical: num(await page.locator('[data-testid="attention-critical"]').getAttribute('data-count')),
    warning: num(await page.locator('[data-testid="attention-warning"]').getAttribute('data-count')),
    kinds,
    demo,
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
        erp: t.match(/DEMO-\d+/)?.[0] ?? t.split('\n')[0],
        percent: t.match(/(\d+)%/)?.[1] ?? '',
        departments: (t.match(/(\d+) of (\d+) departments/i)?.[0] ?? '').toLowerCase(),
      }
    }),
  )
  return lines.filter((l) => /DEMO-/.test(l.erp))
}

async function readManpower(date) {
  await go('#/manpower', 'text=Who is in')
  await page.fill('[data-testid="manpower-date"]', date)
  await page.waitForSelector('[data-testid="manpower-today"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await settle(600)
  return page.$$eval('[data-testid^="manpower-dept-"]', (els) =>
    els.map((el) => ({ code: el.getAttribute('data-testid').replace('manpower-dept-', ''), present: Number(el.getAttribute('data-present')), text: el.innerText.replace(/\s+/g, ' ').trim() })),
  )
}

async function readDisplay(code) {
  await go('#/display', '[data-testid="display-department"]')
  await page.selectOption('[data-testid="display-department"]', code)
  await page.waitForSelector('[data-testid="display-waiting"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await page.waitForSelector('[data-testid="display-today"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
  await settle(600)
  return (await page.locator('[data-testid="floor-display"]').innerText()).split('\n').slice(0, 3).join(' · ')
}

async function readSchedule() {
  await go('#/gantt', '[data-testid="gantt-scroll"]')
  await page.locator('[data-testid="gantt-collapse-all"]').click().catch(() => {})
  await settle(400)
  return page.$$eval('[data-testid="gantt-order"]', (els) =>
    els
      .map((el) => ({
        erp: el.innerText.match(/DEMO-\d+/)?.[0] ?? '',
        breaches: Number(el.getAttribute('data-breaches')),
        stuffing: el.getAttribute('data-stuffing'),
        passed: Boolean(el.querySelector('[data-testid="gantt-passed"]')),
        againstPlan: Boolean(el.querySelector('[data-testid="gantt-against-plan"]')),
      }))
      .filter((o) => o.erp),
  )
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
  // Up to two hundred: the live book held the sample, the interim and the
  // demo orders together, and a cap of sixty left two sample orders behind.
  let removed = 0
  for (let guard = 0; guard < 200; guard++) {
    // The number is the first cell's own text node — the "taken against the
    // plan" tag sits beside it in the same cell, and the screen shows the tag
    // in capitals, so reading the cell's text and comparing it with the
    // document's never matched and the loop ran on without waiting.
    const erps = await page.$$eval('tbody tr > td:first-child', (tds) => tds.map((td) => td.firstChild?.textContent?.trim() ?? ''))
    const erp = erps.find((e) => prefixes.some((p) => e.startsWith(p)))
    if (!erp) break
    const row = page.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: erp }) }).first()
    await row.click()
    // Clicking opens that order's own detail in the row beneath it; the
    // delete button there is the one for this order and no other.
    const del = row.locator('xpath=following-sibling::tr[1]').locator('button:has-text("Delete this order")')
    await del.waitFor({ timeout: 30_000 })
    await del.click()
    await page.waitForFunction(
      (e) => ![...document.querySelectorAll('tbody tr > td:first-child')].some((td) => (td.firstChild?.textContent?.trim() ?? '') === e),
      erp,
      { timeout: 120_000 },
    )
    await settle(600)
    removed++
    console.log(`  removed ${erp}`)
  }
  console.log(`  ${removed} removed; ${await page.locator('tbody tr').count()} orders left in the book`)
}

async function articleOption(selector, code) {
  return page.$eval(selector, (sel, c) => [...sel.options].find((o) => o.textContent.trim().startsWith(c))?.value ?? '', code)
}

/** Check an order on Accept an order; returns the verdict as the screen says it. */
async function check(order) {
  await go('#/accept', 'text=Can we take this order?')
  const value = await articleOption('select', order.code)
  if (!value) throw new Error(`article ${order.code} is not on the list`)
  await page.selectOption('select', value)
  await page.fill('input[type=number]', String(order.qty))
  await page.fill('input[type=date]', order.stuffing)
  const sentence = page.locator('text=/steps cannot be made to this date|Every department can make this/').first()
  for (let attempt = 1; ; attempt++) {
    await page.click('button:has-text("Check")')
    await page.waitForSelector(`text=/${order.qty} units stuffing/i`, { timeout: 200_000 })
    await page.locator('section > header > b').filter({ hasText: /^(Yes|Not as it stands)$/ }).first().waitFor({ timeout: 200_000 })
    await settle(500)
    // The sentence arrives with the heading; on the live site, with runs
    // from the clear still finishing behind it, the screen can re-render
    // for a while. Wait as long as for the heading, and ask once more.
    if (await sentence.waitFor({ timeout: 200_000 }).then(() => true, () => false)) break
    if (attempt >= 2) throw new Error(`${order.erp}: the verdict never settled`)
    console.log(`  (${order.erp}: no verdict sentence after the heading; checking again)`)
  }
  const verdict = (await sentence.innerText()).trim()
  const failing = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr')]
      .filter((r) => !/Clear/i.test(r.lastElementChild?.textContent ?? ''))
      .map((r) => `${r.firstElementChild?.textContent?.trim()}: ${r.lastElementChild?.querySelector('span span')?.textContent?.trim() ?? r.lastElementChild?.textContent?.trim().split('\n')[0] ?? ''}`),
  )
  const pulled = await page.locator('[data-testid="accept-pulled"]').count()
  const name = (await page.locator('select option:checked').innerText()).replace(/^\S+(\s\S+)*?\s+—\s+/, '').trim()
  return { verdict, failing, pulled, name, refused: /cannot be made/.test(verdict) }
}

/**
 * Works the container date out from the item's D-minus: checked once far
 * out, the earliest "Starts" the screen prints is the first department's
 * latest start; pulling the date back by that slack puts it on day 1.
 */
const slackOf = new Map()
async function calibrate(order) {
  if (order.fixed) {
    // A day of the week, or, negative, the working day before day 1: the
    // whole week is entered on one real day, so a container day inside it
    // never passes in real time.
    order.stuffing = order.fixed > 0 ? dayDate(order.fixed) : prevWorking(D1)
    return
  }
  if (!slackOf.has(order.code)) {
    const far = notSunday(plusDays(today, 240))
    await check({ ...order, stuffing: far })
    const starts = (
      await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => r.children[3]?.textContent?.trim() ?? ''))
    )
      .map(isoOf)
      .filter(Boolean)
      .sort()
    if (!starts.length) throw new Error(`${order.erp}: the far check placed nothing`)
    slackOf.set(order.code, { far, slack: daysBetween(D1, starts[0]) })
  }
  const { far, slack } = slackOf.get(order.code)
  order.stuffing = notSunday(plusDays(far, -slack + order.shift))
  if (order.secondLine) order.secondLine.stuffing = notSunday(plusDays(far, -slack + order.secondLine.shift))
}

/** From the verdict, into the book: the button, the form, the reason, the confidence. */
async function takeIt(order, result) {
  await page.click('[data-testid="accept-anyway"]')
  await page.waitForSelector('text=Creates its first shipment line', { timeout: 60_000 })
  const form = page.locator('form').last()
  await form.locator('input[placeholder="SO/26-27/0500"]').fill(order.erp)
  const customers = form.locator('select').first()
  const n = await customers.locator('option').count()
  if (n) await customers.selectOption({ index: Math.min(order.customer, n - 1) })
  if (order.confidence) {
    const conf = form.locator(`select:has(option[value="${order.confidence}"])`).first()
    if (await conf.count()) await conf.selectOption(order.confidence)
  }
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

/** Check and enter one order, with the two pictures the document wants. */
async function enterOrder(order, pictures = {}) {
  const result = await check(order)
  order.name = result.name
  facts.verdicts.push({ erp: order.erp, code: order.code, name: result.name, qty: order.qty, stuffing: order.stuffing, enteredOn: order.enterOn ?? 0, ...result })
  console.log(`  ${order.erp} ${result.name}: ${result.verdict}${result.pulled ? ` (${result.pulled} steps pulled earlier)` : ''}`)
  if (pictures.clear && !result.refused) {
    await mark([{ n: 1, at: page.locator('text=/steps cannot be made to this date|Every department can make this/').first(), where: 'left', dx: -6 }])
    const rows = page.locator('tbody tr')
    await shot(pictures.clear, await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(Math.min(7, (await rows.count()) - 1)), 6))
  }
  if (pictures.refused && result.refused) {
    const flagged = page.locator('tbody tr').filter({ hasNotText: /Clear/ })
    await mark([
      { n: 1, at: page.locator('text=/steps cannot be made to this date|Every department can make this/').first(), where: 'left', dx: -6 },
      ...((await flagged.count()) ? [{ n: 2, at: flagged.first().locator('td').last().locator('span').first(), where: 'right', dx: 4 }] : []),
      { n: 3, at: page.locator('[data-testid="accept-anyway"]'), where: 'right', dx: 4 },
    ])
    const rows = page.locator('tbody tr')
    await shot(pictures.refused, await topOf(title('Can we take this order?'), 30), await bottomOf(rows.nth(Math.min(7, (await rows.count()) - 1)), 6))
  }
  await takeIt(order, result)
  if (order.secondLine) await addSecondLine(order)
  return result
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
    { timeout: 120_000 },
  )
  await settle(400)
}

/** The DEMO rows on the open day: aria-labels of their Good inputs. */
async function demoRows() {
  return page.$$eval('[data-testid="production-worklist"] input[aria-label^="Good, DEMO-"]', (els) =>
    [...new Set(els.map((e) => e.getAttribute('aria-label')))],
  )
}
const rowOf = (label) => page.locator(`tr:visible:has(input[aria-label="${label}"])`).first()

/**
 * Who came in for a department on a date — `short` fewer than are on the
 * books — and the overtime hours for the day, all people together. Its own
 * entry whether or not the department has work that day: attendance is the
 * morning's first thing, before anybody looks at a list.
 */
async function enterAttendance(code, date, { short = 0, overtime = 0 } = {}) {
  await openProduction(code, date)
  const people = page.locator('input[aria-label^="People present"]').first()
  if (!(await people.count())) return { onBooks: null, present: null, overtime: 0, text: 'no attendance panel' }
  // A department whose rates carry no crew size cannot be scaled by who came
  // in; the box is disabled and the screen says so. Noted, not fatal.
  if (await people.isDisabled()) return { onBooks: null, present: null, overtime: 0, text: await text(page.locator('[data-testid="todays-capacity"]').first()) }
  const onBooks = num((await page.locator('text=/\\d+ on the books/').first().innerText().catch(() => '')).match(/(\d+) on the books/)?.[1])
  const present = Math.max(1, onBooks - short)
  await people.fill(String(present))
  const ot = page.locator('input[aria-label^="Overtime hours"]').first()
  if (await ot.count()) await ot.fill(overtime ? String(overtime) : '')
  await page.locator('[data-testid="todays-capacity"] button:has-text("Save")').first().click()
  await page.waitForFunction((n) => new RegExp(`\\b${n}\\b\\s*of\\s*\\d+ in`).test(document.body.innerText), present, { timeout: 60_000 })
  if (overtime) await page.waitForFunction(() => /overtime hours add/.test(document.body.innerText), null, { timeout: 60_000 })
  await settle(500)
  const t = (await page.locator('text=/of \\d+ in/').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  return { onBooks, present, overtime, text: t }
}

/** Puts `qty` of a row's rejects down to the first cause on the list; returns what the line said. */
async function whyRejected(label, qty) {
  const [erp, ...rest] = label.replace(/^Good, /, '').split(' ')
  const component = rest.join(' ')
  const why = page.locator(`[data-testid="why-rejected-${erp}-${component}"]:visible`).first()
  await why.waitFor({ timeout: 60_000 })
  const cause = why.locator('select')
  await cause.selectOption({ index: 1 })
  const causeName = await cause.locator('option:checked').innerText()
  await why.locator('input[type=number]').fill(String(qty))
  await why.locator('button:has-text("Add")').click()
  await page.waitForFunction(
    ([e, c, q]) => document.querySelector(`[data-testid="why-rejected-${e}-${c}"]`)?.getAttribute('data-accounted') === String(q),
    [erp, component, qty],
    { timeout: 60_000 },
  )
  return { cause: causeName, qty, text: await text(why) }
}

/** Enters a day for one department: good = planned × factor, rejected on the first row, and a cause for them. */
async function enterDay(code, date, { factor = 1, rejected = 0, why = false } = {}) {
  await openProduction(code, date)
  const entries = []
  const attendanceText = (await page.locator('text=/of \\d+ in/').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const labels = await demoRows()
  let first = true
  let cause = null
  for (const label of labels) {
    const row = rowOf(label)
    const cells = await row.locator('td').allInnerTexts()
    const planned = num(cells[2])
    // A job planned for a fraction of a unit on this day rounds up to one —
    // what a HOD would enter — never to the zero that leaves the row unsaved.
    if (planned <= 0) continue
    const good = Math.max(1, Math.round(planned * factor))
    const good$ = row.locator('input[aria-label^="Good,"]')
    await good$.fill(String(good))
    if (first && rejected) await row.locator('input[aria-label^="Rejected,"]').fill(String(rejected))
    await good$.press('Enter')
    // "Entered" comes back with the refetched worklist. Two hours into a run
    // the browser's Postgres can take its time; wait, and press once more
    // before giving up — entering a day again corrects, never doubles.
    // Exactly "Entered": a substring match also fits "Not yet entered", and
    // let a save that never took slip through as "0 of 1 entered".
    const entered = row.locator('td').last().locator('text=/^Entered$/')
    await entered.waitFor({ timeout: 90_000 }).catch(async () => {
      const status = await text(row.locator('td').last())
      const errors = await page.$$eval('.text-flag', (els) => els.map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3))
      console.log(`  (${label}: not entered after 90 s — status "${status}"${errors.length ? `, errors: ${errors.join(' | ')}` : ''}; pressing Enter again)`)
      await good$.press('Enter')
      await entered.waitFor({ timeout: 90_000 })
    })
    entries.push({ order: label.replace(/^Good, /, '').split(' ')[0], planned, good, rejected: first ? rejected : 0 })
    if (first && rejected && why) cause = await whyRejected(label, rejected)
    first = false
  }
  const header = await page.locator('section').filter({ has: page.locator('header > b', { hasText: 'What you were asked for' }) }).first().locator('header').innerText()
  return { entries, cause, attendance: attendanceText, header: header.replace(/\s+/g, ' ').replace(/^What you were asked for\s*/i, '').trim() }
}

/** Counts in everything handed to a department for the demo orders. */
async function countIn(code, { shortBy = 0 } = {}) {
  await go('#/production', '[data-testid="production-department"]')
  await page.selectOption('[data-testid="production-department"]', code)
  await settle(800)
  const received = () => page.locator('input[aria-label^="Received, DEMO-"]:visible').first()
  let first = true
  let counted = 0
  let shortfall = ''
  while (await received().count()) {
    const row = page.locator('tr:visible:has(input[aria-label^="Received, DEMO-"])').first()
    if (first && shortBy) {
      const declared = Number(await received().inputValue())
      await received().fill(String(declared - shortBy))
      shortfall = (await page.locator('[data-testid="shortfall"]:visible').first().innerText().catch(() => '')).trim()
    }
    const before = await page.locator('input[aria-label^="Received, DEMO-"]').count()
    await row.locator('button:has-text("Count in")').click()
    await page.waitForFunction((n) => document.querySelectorAll('input[aria-label^="Received, DEMO-"]').length < n, before, { timeout: 60_000 })
    await settle(400)
    first = false
    counted++
  }
  return { counted, shortfall }
}

/** Which departments have DEMO work planned on a date, and the day's planned figure. */
async function plannedOn(date) {
  const out = []
  for (const d of departments) {
    await openProduction(d.code, date)
    const labels = await demoRows()
    if (!labels.length) continue
    let planned = 0
    for (const label of labels) planned += num((await rowOf(label).locator('td').allInnerTexts())[2])
    out.push({ code: d.code, name: d.name, rows: labels.length, planned })
  }
  return out
}

/** The plan for one order from the Schedule, per department. */
async function readPlan(erp) {
  await go('#/gantt', '[data-testid="gantt-scroll"]')
  const g = page.locator(`[data-testid="gantt-order"]:has-text("${erp}")`).first()
  await g.waitFor({ timeout: 60_000 })
  if ((await g.getAttribute('data-expanded')) !== 'yes') await g.locator('button').first().click()
  await settle(400)
  const titles = await g.locator('[data-testid="gantt-bar"]').evaluateAll((bars) => bars.map((b) => b.title))
  const made = await g.locator('[data-testid="gantt-made"]').count()
  const pulled = await g.locator('[data-testid="gantt-pulled"]').count()
  const bars = titles
    .map((t) => {
      const m = /^(.+?): (\d+ \w+ \d{4}) → (\d+ \w+ \d{4}) · ([\d,]+) units(?: · (.*?))? — drag/.exec(t)
      return m ? { code: codeOf.get(m[1]) ?? m[1], name: m[1], start: isoOf(m[2]), end: isoOf(m[3]), qty: num(m[4]), reason: m[5] ?? '' } : null
    })
    .filter(Boolean)
  return { bars, made, pulled, breaches: num(await g.getAttribute('data-breaches')), passed: (await g.locator('[data-testid="gantt-passed"]').count()) > 0 }
}

async function readPlans(list) {
  const out = {}
  for (const o of list) out[o.erp] = await readPlan(o.erp)
  return out
}

/** Drags one order's bar for a department by `days`, with a reason: a pin. */
async function pinBar(erp, code, days, reason) {
  await go('#/gantt', '[data-testid="gantt-scroll"]')
  const g = page.locator(`[data-testid="gantt-order"]:has-text("${erp}")`).first()
  await g.waitFor({ timeout: 60_000 })
  if ((await g.getAttribute('data-expanded')) !== 'yes') await g.locator('button').first().click()
  await settle(400)
  const name = nameOf.get(code) ?? code
  const bar = g.locator(`[data-testid="gantt-bar"][title^="${name}:"]`).first()
  if (!(await bar.count())) return null
  await bar.scrollIntoViewIfNeeded()
  const before = await bar.getAttribute('title')
  const pxPerDay = Number(await page.locator('[data-testid="gantt-scroll"]').getAttribute('data-px-per-day')) || 20
  const b = await bar.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + days * pxPerDay, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForSelector('text=Pin this task', { timeout: 30_000 })
  await mark([{ n: 1, at: page.locator('input[placeholder="Line free after the Nordic run"]'), where: 'inside-right', dx: -8 }]).catch(() => {})
  await tryShot('pin-dialog', async () => {
    const modal = page.locator('[data-testid="modal"]').last()
    await shot('d2-pin', await topOf(modal, 6), await bottomOf(modal, 6))
  })
  await page.fill('input[placeholder="Line free after the Nordic run"]', reason)
  await page.click('button:has-text("Pin it")')
  await page.waitForFunction((r) => document.body.innerText.includes(r), reason, { timeout: 120_000 })
  await settle(1000)
  const after = await g.locator(`[data-testid="gantt-bar"][title^="${name}:"]`).first().getAttribute('title').catch(() => '')
  return { code, name, days, reason, before, after }
}

/** Books a machine of a department down on the Machines screen. */
async function bookMachine(code, from, to, kind, reason) {
  await go('#/machines', '[data-testid="machines-master"]')
  await settle(600)
  // A venue with no machines recorded for this department — the live project
  // has none at all — gets two added for the week, through the screen, so
  // the breakdown has something to happen to. Said in the document.
  const listed = () => page.$$eval('[data-testid^="machine-"][data-down]', (rows, c) => rows.filter((r) => r.getAttribute('data-testid').startsWith(`machine-${c}`)).length, code)
  let added = []
  if ((await listed()) === 0) {
    for (const n of [1, 2]) {
      await page.click('[data-testid="add-machine"]')
      const form = page.locator('[data-testid="modal"]').last()
      await form.waitFor({ timeout: 30_000 })
      await form.getByPlaceholder('STITCH-09').fill(`${code}-W${n}`)
      await form.getByPlaceholder('Lockstitch 9').fill(`${nameOf.get(code) ?? code} machine ${n}`)
      await form.locator('select').first().selectOption({ label: nameOf.get(code) ?? code })
      await form.getByPlaceholder('Juki DDL-8700').fill('Added for the demo week')
      await form.locator('button:has-text("Add machine")').click()
      await page.waitForSelector(`[data-testid="machine-${code}-W${n}"]`, { timeout: 60_000 })
      await settle(600)
      added.push(`${code}-W${n}`)
    }
  }
  const before = await page.locator(`[data-testid="machines-short-${code}"]`).getAttribute('data-available').catch(() => null)
  await page.click('[data-testid="book-downtime"]')
  const modal = page.locator('[data-testid="modal"]')
  await modal.waitFor()
  const machine = await modal.locator('select').first().evaluate((sel, c) => [...sel.options].find((o) => o.value.startsWith(c))?.value ?? '', code)
  if (!machine) return { machine: '', before, after: null, machines: null, added }
  await modal.locator('select').first().selectOption(machine)
  const kinds = modal.locator(`select:has(option[value="${kind}"])`).first()
  if (await kinds.count()) await kinds.selectOption(kind)
  const dates = modal.locator('input[type=date]')
  if ((await dates.count()) >= 2) {
    await dates.nth(0).fill(from)
    await dates.nth(1).fill(to)
  }
  await modal.getByPlaceholder('Hook timing gone — spares ordered').fill(reason)
  await modal.locator('button:has-text("Book it")').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), null, { timeout: 60_000 })
  await settle(800)
  const after = await page.locator(`[data-testid="machines-short-${code}"]`).getAttribute('data-available').catch(() => null)
  const machines = await page.locator(`[data-testid="machines-short-${code}"]`).getAttribute('data-machines').catch(() => null)
  await mark([{ n: 1, at: page.locator(`[data-testid="machine-${machine}"]`).first(), where: 'left', dx: 2 }]).catch(() => {})
  await shot('d2-machines', await topOf(page.locator('[data-testid="machines-master"]'), 60), await bottomOf(page.locator('[data-testid="machines-master"]'), 10))
  return { machine, kind, reason, before: before ?? String(added.length || ''), after, machines, added }
}

async function hodDay(label, date, rules) {
  console.log(`${label}: the floor`)
  const planned = await plannedOn(date)
  const entered = []
  for (const [i, dept] of planned.entries()) {
    // `first` is the first department with work that day, whichever it is:
    // Ply Cutting on the demonstration route, Machining on U&M's.
    const rule = { ...(i === 0 ? rules.first ?? {} : {}), ...(rules[dept.code] ?? {}) }
    const r = await enterDay(dept.code, date, rule)
    // A department whose only job that day is planned for less than half a
    // unit has nothing to enter; it is not a row in the day's table.
    if (!r.entries.length) {
      console.log(`  ${dept.name}: nothing to enter (planned under a unit)`)
      continue
    }
    entered.push({ code: dept.code, name: dept.name, ...r })
    console.log(`  ${dept.name}: ${r.header}${r.cause ? ` · ${r.cause.qty} rejected: ${r.cause.cause}` : ''}`)
  }
  return { planned, entered }
}

const afterRun = async (date, extra = {}) => ({
  commandCentre: await readCommandCentre(),
  attention: await readAttention(),
  dashboard: await readDashboard(date),
  wip: await readWip(),
  schedule: await readSchedule(),
  ...extra,
})

// =============================================================================
// Day 0 — the book, and what the plan said
// =============================================================================
console.log('day 0: clearing the book')
if (CLEAR.length) {
  await clearOrders(CLEAR)
  // Every deletion re-plans; on the live site those runs queue behind one
  // another. Let them finish before the first check joins the queue.
  await go('', 'text=Bottleneck utilisation')
  await page.waitForSelector('[data-testid="bottlenecks"][data-state="ready"]', { state: 'attached', timeout: 240_000 })
  await settle(4000)
}

console.log('day 0: the orders through Accept an order')
facts.verdicts = []
for (const order of ORDERS) await calibrate(order)
for (const order of ORDERS) {
  if (order.enterOn) continue
  await enterOrder(order, { clear: order.erp === 'DEMO-01' ? 'd0-accept-clear' : undefined, refused: order.erp === 'DEMO-06' ? 'd0-accept-refused' : undefined })
}

// The book.
await go('#/orders', 'text=Order book')
await page.waitForSelector('[data-testid="order-book-state"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
{
  const rows = page.locator('tbody tr').filter({ hasText: /DEMO-/ })
  await mark([
    { n: 1, at: rows.first().locator('td').first(), where: 'left', dx: 2 },
    ...((await page.locator('[data-testid="order-against-plan"]').count()) ? [{ n: 2, at: page.locator('[data-testid="order-against-plan"]').first(), where: 'right', dx: 4 }] : []),
    { n: 3, at: rows.first().locator('td').last(), where: 'right', dx: -8 },
  ])
  facts.book = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())))
  await shot('d0-book', await topOf(page.locator('thead').first(), 10), await bottomOf(rows.last(), 6))
}

console.log('day 0: what the plan said')
facts.plans0 = await readPlans(ORDERS.filter((o) => !o.enterOn).slice(0, 4))
{
  await go('#/gantt', '[data-testid="gantt-scroll"]')
  await page.locator('[data-testid="gantt-collapse-all"]').click().catch(() => {})
  await settle(400)
  const groups = page.locator('[data-testid="gantt-order"]').filter({ hasText: /DEMO-/ })
  await mark([
    { n: 1, at: groups.first().locator('span.font-semibold').first(), where: 'left', dx: 0 },
    { n: 2, at: page.locator('[data-testid="gantt-today"]').first(), where: 'above', dy: -2 },
  ]).catch(() => {})
  await shot('d0-schedule', await topOf(title('Schedule'), 30), await bottomOf(groups.nth(Math.min(7, (await groups.count()) - 1)), 10))
}
facts.days.d0 = {
  commandCentre: await readCommandCentre(),
  heatmap: await readHeatmap(),
  attention: await readAttention(),
  dashboard: await readDashboard(D1),
  schedule: await readSchedule(),
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
// The week
// =============================================================================
const [, D2, D3, D4, D5] = DATES

// --- Day 1: the first morning and evening ------------------------------------
if (DAYS >= 1) {
  facts.days.d1 = {}
  console.log('day 1: attendance')
  facts.days.d1.attendance = { STITCH: await enterAttendance('STITCH', D1, { short: 2 }) }
  console.log(`  Stitching: ${facts.days.d1.attendance.STITCH.text}`)
  facts.days.d1.display = await readDisplay('STITCH')
  await tryShot('d1-display', async () => shot('d1-display', 0, await bottomOf(page.locator('[data-testid="display-waiting"]'), 24)))
  facts.days.d1.floor = await hodDay('day 1', D1, {
    first: { rejected: 4, why: true },
    MACHINE: { factor: 0.5 },
  })
  await tryShot('d1-stitching-attendance', async () => {
    await openProduction('STITCH', D1)
    await mark([
      { n: 1, at: page.locator('input[aria-label^="People present"]').first(), where: 'inside', dx: 6, dy: 14 },
      { n: 2, at: page.locator('text=/of \\d+ in/').first(), where: 'right', dx: 4 },
    ])
    await shot('d1-stitching-attendance', await topOf(title('What you can do today'), 30), await bottomOf(page.locator('[data-testid="todays-capacity"]'), 10))
  })
  await tryShot('d1-why-rejected', async () => {
    const withCause = facts.days.d1.floor.entered.find((e) => e.cause)
    if (!withCause) throw new Error('no department put a cause down')
    await openProduction(withCause.code, D1)
    const why = page.locator('[data-testid^="why-rejected-"]:visible').first()
    await mark([{ n: 1, at: why, where: 'left', dx: 2 }])
    await shot('d1-why-rejected', await topOf(title('What you were asked for'), 30), await bottomOf(why, 10))
  })
  await tryShot('d1-machining', async () => {
    await openProduction('MACHINE', D1)
    await mark([{ n: 1, at: page.locator('[data-testid="production-worklist"] tr:visible').nth(1).locator('td').nth(2), where: 'inside', dx: 4, dy: 10 }])
    await shot('d1-machining', await topOf(title('What you were asked for'), 30), await bottomOf(page.locator('[data-testid="production-worklist"]'), 10))
  })
  await run()
  facts.days.d1.after = await afterRun(D1, { plans: await readPlans(ORDERS.slice(0, 3)) })
  await tryShot('d1-dashboard-grid', async () => {
    await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
    await page.waitForSelector('[data-testid="plan-vs-made-grid"]', { timeout: 60_000 })
    const grid = page.locator('[data-testid="plan-vs-made-grid"]')
    const machineRow = grid.locator('button[data-code="MACHINE"]')
    await mark([
      { n: 1, at: grid, where: 'top-left', dx: -6, dy: -2 },
      ...((await machineRow.count()) ? [{ n: 2, at: machineRow, where: 'inside-right', dx: -6 }] : []),
    ])
    await shot('d1-dashboard-grid', await topOf(title('Planned against made'), 30), await bottomOf(grid, 44))
  })
}

// --- Day 2: counting in, a breakdown, a new order, a pin ----------------------
if (DAYS >= 2) {
  console.log('day 2: counting in, a machine down, a new order, a pin')
  facts.days.d2 = { handovers: {} }
  for (const d of departments) {
    const r = await countIn(d.code, { shortBy: d.code === 'ASSY' ? 2 : 0 })
    if (r.counted) facts.days.d2.handovers[d.code] = r
  }
  // From day 1: every day of the run is entered on one real day, and the
  // machines-available figure the screens show is today's.
  facts.days.d2.machine = await bookMachine('STITCH', D1, D3, 'breakdown', 'Thread take-up lever bent — spares ordered')
  console.log(`  machine: ${facts.days.d2.machine.machine || 'none'} ${facts.days.d2.machine.before ?? '?'} → ${facts.days.d2.machine.after ?? '?'}`)
  for (const order of ORDERS.filter((o) => o.enterOn === 2)) await enterOrder(order)
  facts.days.d2.pin = await pinBar('DEMO-01', (await readPlan('DEMO-01')).bars[1]?.code ?? 'STITCH', 2, 'Line free after the Nordic run')
  console.log(`  pin: ${facts.days.d2.pin?.name ?? 'none'} +2 days`)
  facts.days.d2.floor = await hodDay('day 2', D2, { MACHINE: { factor: 0.85 } })
  await run()
  facts.days.d2.after = await afterRun(D2, { board: null, display: await readDisplay('STITCH'), manpower: await readManpower(D2) })
  await tryShot('d2-attention', async () => {
    await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
    const findings = page.locator('[data-testid^="finding-"]')
    const machineCard = page.locator('[data-testid="finding-machine-down"]').first()
    if (await machineCard.count()) await mark([{ n: 1, at: machineCard, where: 'inside', dx: -40, dy: 0 }])
    await shot('d2-attention', (await box(page.locator('header.gridpaper'))).y - 8, await bottomOf(findings.nth(Math.min(3, (await findings.count()) - 1)), 10))
  })
  await tryShot('d2-board-assembly', async () => {
    await go('#/board', 'text=What you owe')
    await page.selectOption('[data-testid="board-department"]', 'ASSY')
    await page.waitForSelector('[data-testid="board-queue"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
    await page.waitForSelector('[data-testid="board-inbound"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
    facts.days.d2.after.board = (await page.locator('[data-testid="board-inbound"]').innerText()).replace(/\s+/g, ' ').slice(0, 400)
    await shot('d2-board-assembly', await topOf(title('Holding you up'), 30), await bottomOf(page.locator('[data-testid="board-inbound"]'), 10))
  })
  await tryShot('d2-display', async () => {
    await readDisplay('STITCH')
    await shot('d2-display', 0, await bottomOf(page.locator('[data-testid="display-waiting"]'), 24))
  })
  await tryShot('d2-schedule-pin', async () => {
    await go('#/gantt', '[data-testid="gantt-scroll"]')
    const g = page.locator('[data-testid="gantt-order"]:has-text("DEMO-01")').first()
    if ((await g.getAttribute('data-expanded')) !== 'yes') await g.locator('button').first().click()
    await settle(400)
    const pinned = g.locator('button:has-text("Pin ×")').first()
    await pinned.scrollIntoViewIfNeeded()
    await mark([{ n: 1, at: pinned, where: 'right', dx: 4 }])
    await shot('d2-schedule-pin', await topOf(g, 6), await bottomOf(g, 6))
  })
}

// --- Day 3: overtime, a stock count ------------------------------------------
if (DAYS >= 3) {
  console.log('day 3: overtime in Stitching, one on leave in Sanding, a stock count')
  facts.days.d3 = {}
  for (const d of departments) await countIn(d.code)
  facts.days.d3.attendance = {
    STITCH: await enterAttendance('STITCH', D3, { short: 0, overtime: 12 }),
    SAND: await enterAttendance('SAND', D3, { short: 1 }),
  }
  console.log(`  Stitching: ${facts.days.d3.attendance.STITCH.text}`)
  await tryShot('d3-overtime', async () => {
    await openProduction('STITCH', D3)
    await mark([
      { n: 1, at: page.locator('input[aria-label^="Overtime hours"]').first(), where: 'inside', dx: 6, dy: 14 },
      { n: 2, at: page.locator('text=/overtime hours add/').first(), where: 'right', dx: 4 },
    ])
    await shot('d3-overtime', await topOf(title('What you can do today'), 30), await bottomOf(page.locator('[data-testid="todays-capacity"]'), 10))
  })
  await tryShot('d3-material', async () => {
    await go('#/material', '[data-testid="material-stock"][data-state="ready"]')
    const target = page.locator('[data-testid^="material-"][data-status="short"], [data-testid^="material-"][data-status="not counted"]').first()
    if (!(await target.count())) throw new Error('nothing short or uncounted')
    const code = (await target.getAttribute('data-testid')).replace('material-', '')
    const status = await target.getAttribute('data-status')
    await target.locator('button').first().click()
    // Enough to cover what the plan needs, read from the row: with sixteen
    // orders a round 9,000 was not.
    const required = Number(await target.getAttribute('data-required')) || 9000
    const count = Math.ceil(required * 1.1 + 100)
    const input = page.locator('input[type=number]:visible').first()
    await input.fill(String(count))
    await input.press('Enter')
    await page.waitForFunction((c) => document.querySelector(`[data-testid="material-${c}"]`)?.getAttribute('data-status') === 'covered', code, { timeout: 60_000 })
    facts.days.d3.material = { code, before: status, after: 'covered', count, required }
    await mark([{ n: 1, at: page.locator(`[data-testid="material-${code}"]`), where: 'left', dx: 2 }])
    await shot('d3-material', await topOf(title('Against the store'), 30), await bottomOf(page.locator(`[data-testid="material-${code}"]`), 10))
  })
  facts.days.d3.floor = await hodDay('day 3', D3, { MACHINE: { factor: 1 }, STITCH: { factor: 1.1 } })
  await run()
  facts.days.d3.after = await afterRun(D3, { manpower: await readManpower(D3) })
  await tryShot('d3-manpower', async () => {
    await readManpower(D3)
    const card = page.locator('[data-testid="manpower-dept-STITCH"]').first()
    await mark([{ n: 1, at: card.locator('[data-testid="manpower-ot"]').first(), where: 'right', dx: 4 }])
    await shot('d3-manpower', await topOf(title('Who is in'), 30), await bottomOf(card, 10))
  })
}

// --- Day 4: an order refused and taken anyway, a what-if --------------------
if (DAYS >= 4) {
  console.log('day 4: a refused order taken anyway, a what-if, more overtime')
  facts.days.d4 = {}
  for (const d of departments) await countIn(d.code)
  facts.days.d4.attendance = { STITCH: await enterAttendance('STITCH', D4, { short: 0, overtime: 12 }) }
  for (const order of ORDERS.filter((o) => o.enterOn === 4)) await enterOrder(order, { refused: 'd4-accept-refused' })
  await tryShot('d4-whatif', async () => {
    await go('#/whatif', 'text=Try a change')
    await page.fill('input[placeholder="Second shift on stitching through November"]', 'Second shift in Stitching')
    await page.selectOption('form select', { label: nameOf.get('STITCH') ?? 'Stitching' })
    await page.click('button:text-is("Second shift")')
    await page.click('button:has-text("Run it")')
    await page.waitForSelector('text=What changed', { timeout: 240_000 })
    await settle(800)
    facts.days.d4.whatIf = {
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
    await shot('d4-whatif', await topOf(title('Try a change'), 30), await bottomOf(page.locator('.label:text-is("Flagged days in this scenario")'), 60))
  })
  facts.days.d4.floor = await hodDay('day 4', D4, { first: { rejected: 3, why: true }, MACHINE: { factor: 1.25 } })
  await run()
  facts.days.d4.after = await afterRun(D4)
  await tryShot('d4-quality', async () => {
    await go('#/quality', '[data-testid="quality-by-department"][data-state="ready"]')
    facts.days.d4.quality = (await page.locator('[data-testid="quality-by-department"]').innerText()).replace(/\s+/g, ' ').slice(0, 300)
    await shot('d4-quality', await topOf(title('Where the losses come from'), 30), await bottomOf(page.locator('[data-testid="defect-pareto"]'), 10))
  })
}

// --- Day 5: the week read ----------------------------------------------------
if (DAYS >= 5) {
  console.log('day 5: the week read by the MD')
  facts.days.d5 = {}
  for (const d of departments) await countIn(d.code)
  facts.days.d5.floor = await hodDay('day 5', D5, {})
  await run()
  facts.days.d5.after = await afterRun(D5, { plans: await readPlans(ORDERS.filter((o) => !o.enterOn || o.enterOn <= DAYS)), heatmap: await readHeatmap() })
  await tryShot('d5-dashboard', async () => {
    await go('#/dashboard', '[data-testid="md-kpis"][data-state="ready"]')
    await page.waitForSelector('[data-testid="plan-vs-made-grid"]', { timeout: 60_000 })
    await shot('d5-dashboard', await topOf(title('Is the factory on track today?'), 30), await bottomOf(page.locator('[data-testid="plan-vs-made-grid"]'), 44))
  })
  await tryShot('d5-wip', async () => {
    await go('#/wip', '[data-testid="wip-running"][data-state="ready"]')
    const lines = page.locator('[data-testid="wip-running"] [data-testid="wip-line"]').filter({ hasText: /DEMO-/ })
    await lines.first().locator('button').first().click()
    await settle(400)
    await shot('d5-wip', await topOf(title('In progress'), 30), await bottomOf(lines.nth(Math.min(2, (await lines.count()) - 1)), 10))
  })
  await tryShot('d5-schedule', async () => {
    await go('#/gantt', '[data-testid="gantt-scroll"]')
    await page.locator('[data-testid="gantt-collapse-all"]').click().catch(() => {})
    await settle(400)
    const passed = page.locator('[data-testid="gantt-passed"]').first()
    if (await passed.count()) await mark([{ n: 1, at: passed, where: 'right', dx: 4 }])
    const groups = page.locator('[data-testid="gantt-order"]').filter({ hasText: /DEMO-/ })
    await shot('d5-schedule', await topOf(title('Schedule'), 30), await bottomOf(groups.nth(Math.min(7, (await groups.count()) - 1)), 10))
  })
  await tryShot('d5-forecast', async () => {
    await go('#/forecast', '[data-testid="forecast-readiness"][data-state="ready"]')
    facts.days.d5.forecast = {
      declarations: num(await page.locator('[data-testid="forecast-readiness"]').getAttribute('data-declarations')),
      text: (await page.locator('[data-testid="forecast-readiness"]').innerText()).replace(/\s+/g, ' ').slice(0, 240),
    }
    await shot('d5-forecast', await topOf(title('How much of this is worth believing'), 30), await bottomOf(page.locator('[data-testid="forecast-readiness"]'), 10))
  })
  await tryShot('d5-money', async () => {
    await go('#/money', '[data-testid="cash-out"]')
    await page.waitForSelector('[data-testid="cash-out"][data-state="ready"]', { state: 'attached', timeout: 60_000 })
    facts.days.d5.money = (await page.locator('[data-testid="cash-out"]').innerText()).replace(/\s+/g, ' ').slice(0, 240)
    await shot('d5-money', await topOf(title('Money out, week by week'), 30), await bottomOf(page.locator('[data-testid="cash-out"]'), 10))
  })
  await tryShot('d5-attention', async () => {
    await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
    const findings = page.locator('[data-testid^="finding-"]')
    await shot('d5-attention', (await box(page.locator('header.gridpaper'))).y - 8, await bottomOf(findings.nth(Math.min(4, (await findings.count()) - 1)), 10))
  })
}

await browser.close()
stopServer()

facts.generatedAt = new Date().toISOString()
facts.shots = shots
await writeFile(factsFile, JSON.stringify(facts, null, 1))
await writeFile(`${repoRoot}docs/demo-week.html`, demoWeekPage({ facts }))
console.log(`\nWrote docs/demo-week.html and ${Object.keys(shots).length} pictures.`)

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s) while capturing:`)
  for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  process.exit(1)
}
