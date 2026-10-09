/**
 * Writes DBBS/UM/KRAM/11 — every click: what you press, what changes, why.
 *
 *   node scripts/make-click-guide.mjs
 *   node scripts/make-pdf.mjs docs/click-guide.html
 *
 * ---------------------------------------------------------------------------
 * What it is.
 *
 * Every control a person operates in Kram, photographed three times: the
 * screen before, the control marked; the dialog if there is one; the screen
 * after, with what changed marked. Beside each, the steps in words, what
 * moved, and why it matters. It runs on the **demonstration build** — the one
 * with invented figures that has something on every screen — so it can add
 * orders, declare production and move pins without touching the client's
 * data, and every run starts from the same seed, so the pictures are the same
 * each time they are taken.
 *
 * The browser check (`scripts/screenshot.mjs`) performs most of these actions
 * already, as a test; this performs them to be looked at. The two share their
 * selectors and nothing else, deliberately: a test may abort on the first
 * failure, a guide has to carry on and say which page is missing.
 *
 * ---------------------------------------------------------------------------
 * Why the words are in here and not in the page module.
 *
 * Each sentence quotes what the screen showed — "18 breaches became 21", "11
 * in became 10". Those figures are read in the same visit as the picture, so
 * the sentence has to be written where the figure is known. The page module
 * only lays the manifest out.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { clickGuidePage } from './lib/click-guide-page.mjs'
import { box as boxIn, mark as markIn, unmark } from './lib/marks.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const only = [...flags].find((f) => f.startsWith('--only='))?.slice(7).split(',')
const outDir = `${repoRoot}docs/click-guide`
const PORT = 5185
const WIDTH = 1180

// --- the demonstration server, on its own port --------------------------------
async function alive(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}
const baseUrl = `http://localhost:${PORT}`
if (await alive(baseUrl)) throw new Error(`Something is already on ${baseUrl}; stop it first.`)
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: repoRoot, stdio: 'ignore' })
const by = Date.now() + 90_000
while (!(await alive(baseUrl))) {
  if (Date.now() > by) {
    server.kill()
    throw new Error('The demonstration server never came up.')
  }
  await new Promise((r) => setTimeout(r, 400))
}
const stopServer = () => !server.killed && server.kill()

if (!only) await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: 1.5,
  acceptDownloads: true,
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const box = (l) => boxIn(page, l)
const mark = (t) => markIn(page, t)
const title = (t) => page.locator(`section > header > b:text-is("${t}")`)
const panelWith = (t) =>
  page.locator('section').filter({ has: page.locator('header > b', { hasText: t }) }).last()
const modal = () => page.locator('[data-testid="modal"]')
const editor = () => page.locator('input[type=number]:visible').first()

const settle = async (ms = 700) => {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page
    .waitForFunction(() => !/Loading…|Running every check…|Working…|Saving…/.test(document.body.innerText), null, { timeout: 60_000 })
    .catch(() => {})
  await page.waitForTimeout(ms)
}
const go = async (hash, waitFor) => {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(waitFor, { timeout: 120_000 })
  await settle()
}
async function until(label, fn, arg, timeout = 60_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout })
  } catch {
    throw new Error(`timed out waiting for ${label}`)
  }
}

/**
 * One picture: the region round `around` (a locator or several), full width,
 * with `marks` drawn first. Returns the manifest entry for the image.
 */
async function shot(id, label, { around, marks = [], pad = 18, maxHeight = 1500, notes = [], clipTo = null }) {
  if (marks.length) await mark(marks)
  const targets = Array.isArray(around) ? around : [around]
  let top = Infinity
  let bottom = -Infinity
  for (const t of targets) {
    const b = await box(t)
    top = Math.min(top, b.y)
    bottom = Math.max(bottom, b.y + b.height)
  }
  const y = Math.max(0, Math.round(top - pad))
  const height = Math.min(maxHeight, Math.round(bottom + pad - y))
  // Full width by default. `clipTo` narrows to one element's columns, for a
  // panel that shares its row with another and would otherwise drag it in.
  let x = 0
  let width = WIDTH
  if (clipTo) {
    const b = await box(clipTo)
    x = Math.max(0, Math.round(b.x - pad))
    width = Math.min(WIDTH - x, Math.round(b.width + pad * 2))
  }
  const file = `${id}-${label}.png`
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: true, clip: { x, y, width, height } })
  await unmark(page)
  return { file, label, notes, width, height }
}

const previous = only
  ? (JSON.parse(await readFile(`${outDir}/manifest.json`, 'utf8').catch(() => '{"actions":[]}')).actions ?? [])
  : []
const manifest = []
async function action(id, screen, name, fn) {
  if (only && !only.includes(id)) {
    const kept = previous.find((m) => m.id === id)
    manifest.push(kept ?? { id, screen, name, failed: 'not taken on this run' })
    return
  }
  process.stdout.write(`${screen.padEnd(16)} ${name.padEnd(44)}`)
  try {
    const entry = await fn()
    manifest.push({ id, screen, name, ...entry })
    console.log('ok')
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e)
    manifest.push({ id, screen, name, failed: why })
    console.log(`FAILED — ${why}`)
    await page.screenshot({ path: `${outDir}/failed-${id}.png`, fullPage: true }).catch(() => {})
  }
}

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''))
const readMetric = async (label) => {
  const text = await page.locator('main').innerText()
  return num(text.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'))?.[1] ?? 'NaN')
}

// --- boot --------------------------------------------------------------------
console.log('The demonstration build (Postgres starts in the browser; the first load takes a moment)')
await go('', 'text=Bottleneck utilisation')
await page.waitForSelector('text=/^Constraint$/i', { timeout: 120_000 })

// =============================================================================
// COMMAND CENTRE
// =============================================================================
await action('run-schedule', 'Command centre', 'Run the schedule', async () => {
  await go('', 'text=Bottleneck utilisation')
  await page.waitForSelector('text=/^Constraint$/i', { timeout: 60_000 })
  const panel = panelWith('Schedule run')
  const stampBefore = (await panel.locator('header span').innerText()).trim()
  const tasks = await readMetric('Scheduled tasks')
  const breaches = await readMetric('Breaches')
  const tiles = page.locator('.label:text-is("Flagged days")').locator('..')
  const before = await shot('run-schedule', 'before', {
    around: [panel, tiles],
    marks: [
      { n: 1, at: page.locator('.label:text-is("Include orders")'), where: 'right' },
      { n: 2, at: page.locator('button:has-text("Run the schedule")'), where: 'right', ring: true },
      { n: 3, at: panel.locator('header span'), where: 'left' },
    ],
    notes: ['Which orders to include: confirmed only, confirmed and probable, or everything', 'Run the schedule', 'When the current plan was made, and how long it took'],
  })
  await page.click('button:has-text("Run the schedule")')
  await until('a new run stamp', (was) => {
    const h = [...document.querySelectorAll('section > header')].find((x) => x.textContent?.includes('Schedule run'))
    const span = h?.querySelector('span')?.textContent?.trim()
    return span && span !== was && !/running/i.test(span)
  }, stampBefore)
  await settle()
  const stampAfter = (await panel.locator('header span').innerText()).trim()
  const after = await shot('run-schedule', 'after', {
    around: [panel, tiles],
    marks: [
      { n: 1, at: panel.locator('header span'), where: 'left' },
      { n: 2, at: page.locator('.label:text-is("Scheduled tasks")'), where: 'right' },
    ],
    notes: ['A new stamp: the moment of this run and the time it took', 'The four figures, recomputed from nothing'],
  })
  return {
    steps: ['Choose which orders to plan with the three buttons.', 'Press Run the schedule.', 'Wait for the stamp beside the title to change.'],
    images: [before, after],
    changed: `A new plan was written as its own version (${stampAfter}). Every order was planned again from nothing: ${tasks} jobs, ${breaches} that do not fit — the same figures, because nothing had changed since the last run.`,
    why: 'Every run is kept and none is overwritten, so pressing this is never destructive. It is the one button that turns everything on Masters, the Capacity sheet and the Order book into dates.',
  }
})

// =============================================================================
// ATTENTION
// =============================================================================
await action('attention-link', 'Attention', 'Follow a finding to the screen that fixes it', async () => {
  await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
  const card = page.locator('[data-testid^="finding-"]').first()
  const cardTitle = (await card.locator('p, div').first().innerText()).split('\n')[0].trim()
  const link = card.locator('a').first()
  const before = await shot('attention-link', 'before', {
    around: [title('Needs an answer today'), page.locator('[data-testid^="finding-"]').nth(2)],
    marks: [
      { n: 1, at: card, where: 'inside', dx: -40 },
      { n: 2, at: link, where: 'right' },
    ],
    notes: ['One finding: what is wrong, why, and when it ships', 'The link to the screen where it can be dealt with'],
  })
  await link.click()
  await page.waitForTimeout(400)
  await settle()
  const landed = (await page.locator('section > header > b').first().innerText()).trim()
  const after = await shot('attention-link', 'after', {
    around: [page.locator('main')],
    maxHeight: 760,
    marks: [{ n: 1, at: page.locator('section').first(), where: 'inside', dx: -40, dy: 10 }],
    notes: [`The screen the finding points at: ${landed}`],
  })
  return {
    steps: ['Read the card. The first line says what is wrong; the second says why and when it ships.', 'Press "Go to the screen that fixes this".'],
    images: [before, after],
    changed: `"${cardTitle}" opened ${landed}, the screen where that kind of problem is handled.`,
    why: 'A finding with nowhere to go is a complaint. Every card on Attention names the screen that fixes it, and there is deliberately no way to dismiss one while it is still true.',
  }
})

// =============================================================================
// LOAD HEATMAP
// =============================================================================
await action('heatmap-cell', 'Load heatmap', 'Open one day of one department', async () => {
  await go('#/heatmap', '[data-testid="heatmap-grid"]')
  const grid = page.locator('[data-testid="heatmap-grid"]')
  const worst = await page.evaluate(() => {
    let best = null
    for (const b of document.querySelectorAll('[data-testid="heatmap-grid"] button[title]')) {
      const m = b.title.match(/^(\w+) · (\d{4}-\d{2}-\d{2}) · ([\d.]+) of capacity/)
      if (m && (!best || Number(m[3]) > best.value)) best = { code: m[1], date: m[2], value: Number(m[3]), title: b.title }
    }
    return best
  })
  const cell = grid.locator(`button[title="${worst.title}"]`)
  const before = await shot('heatmap-cell', 'before', {
    around: [title('Load heatmap'), grid],
    marks: [{ n: 1, at: cell, where: 'above', ring: true }],
    notes: [`The fullest square on the map: ${worst.code}, ${worst.date}, asked for ${Math.round(worst.value * 100)}% of a day`],
  })
  await cell.click()
  await page.locator('section > header > b', { hasText: `${worst.code} —` }).first().waitFor({ timeout: 30_000 })
  await settle(400)
  const detail = panelWith(`${worst.code} —`)
  const rows = await detail.locator('tbody tr').count()
  const after = await shot('heatmap-cell', 'after', {
    around: [detail],
    marks: [{ n: 1, at: detail.locator('header > b'), where: 'left' }],
    notes: ['The day opened: every job on it, the share of the day each takes'],
  })
  return {
    steps: ['Find the square: one row per department, one square per working day, red when the day is over-full.', 'Click it.'],
    images: [before, after],
    changed: `A panel opened below the map listing the ${rows} jobs on ${worst.code} that day, with the share of the day each one takes. Together they come to ${Math.round(worst.value * 100)}%.`,
    why: 'The heatmap shows which days hurt; this shows what is on them. A department can be making several things at once, and the shares add even when the pieces do not.',
  }
})

// =============================================================================
// SCHEDULE
// =============================================================================
await action('schedule-filter', 'Schedule', 'Show one department, and only the problems', async () => {
  await go('#/gantt', '[data-testid="gantt-order"]')
  const orders = page.locator('[data-testid="gantt-order"]')
  const all = await orders.count()
  const dept = page.locator('select').first()
  const breachesOnly = page.locator('label:has-text("Breaches only")')
  const before = await shot('schedule-filter', 'before', {
    around: [title('Schedule'), orders.nth(3)],
    maxHeight: 900,
    marks: [
      { n: 1, at: dept, where: 'above', dy: 2 },
      { n: 2, at: breachesOnly, where: 'right' },
      { n: 3, at: orders.first(), where: 'inside', dx: -40, dy: 4 },
    ],
    notes: ['Department: show one department\u2019s work only', 'Breaches only: hide everything that fits', 'One strip per shipment line: its span, the container day, red where a step cannot be made in time'],
  })
  await dept.selectOption('STITCH')
  await settle(500)
  const stitch = await orders.count()
  await breachesOnly.locator('input').check()
  await settle(500)
  const red = await orders.count()
  await page.click('[data-testid="gantt-expand-all"]')
  await page.waitForSelector('[data-testid="gantt-bar"]', { timeout: 30_000 })
  await settle(400)
  const redBars = await page.locator('[data-testid="gantt-bar"]').count()
  const after = await shot('schedule-filter', 'after', {
    around: [title('Schedule'), page.locator('main')],
    maxHeight: 900,
    marks: [{ n: 1, at: page.locator('[data-testid="gantt-bar"]').first(), where: 'left', ring: true }],
    notes: ['What is left, opened: only stitching, and only the bars that cannot be done in time'],
  })
  await page.click('[data-testid="gantt-collapse-all"]')
  await breachesOnly.locator('input').uncheck()
  await dept.selectOption('')
  return {
    steps: ['Pick a department from the first list.', 'Tick "Breaches only".', 'Press Expand all to see the bars.'],
    images: [before, after],
    changed: `${all} shipment lines became ${stitch} with stitching work, then ${red} with a stitching breach: ${redBars} red ${redBars === 1 ? 'bar' : 'bars'} once opened.`,
    why: 'With hundreds of live orders the full schedule is unreadable. A department head wants their own rows; a planner wants the red ones.',
  }
})

await action('schedule-pin', 'Schedule', 'Drag a bar to pin a job to a date', async () => {
  await go('#/gantt', '[data-testid="gantt-order"]')
  const row = page.locator('[data-testid="gantt-order"]').first()
  await row.locator('button').first().click()
  await page.waitForSelector('[data-testid="gantt-bar"]', { timeout: 30_000 })
  await settle(400)
  const bar = page.locator('[data-testid="gantt-bar"]').first()
  const before = await shot('schedule-pin', 'before', {
    around: [row],
    maxHeight: 700,
    marks: [{ n: 1, at: bar, where: 'left', ring: true }],
    notes: ['The bar to drag: one department\u2019s work on one order'],
  })
  const b = await bar.boundingBox()
  const track = await bar.evaluateHandle((el) => el.parentElement)
  const trackBox = await track.asElement().boundingBox()
  const distance = Math.max(80, trackBox.width * 0.2)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 - distance, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForSelector('text=Pin this task', { timeout: 30_000 })
  const reason = 'Pulled forward to protect the December container'
  await page.fill('input[placeholder="Line free after the Nordic run"]', reason)
  const during = await shot('schedule-pin', 'dialog', {
    around: [modal()],
    marks: [
      { n: 1, at: page.locator('input[placeholder="Line free after the Nordic run"]'), where: 'inside-right' },
      { n: 2, at: page.locator('button:has-text("Pin it")'), where: 'right', ring: true },
    ],
    notes: ['Why: the reason is kept with the pin and shown to whoever asks later', 'Pin it'],
  })
  await page.click('button:has-text("Pin it")')
  await page.waitForSelector(`text=${reason}`, { timeout: 60_000 })
  await settle()
  const pins = panelWith('Manual pins')
  const after = await shot('schedule-pin', 'after', {
    around: [pins],
    marks: [
      { n: 1, at: pins.locator('header > b'), where: 'left' },
      { n: 2, at: pins.locator('button:has-text("Release")').first(), where: 'right', ring: true },
    ],
    notes: ['The pin, listed with its reason and dates', 'Release: let the next run place the job itself again'],
  })
  return {
    steps: ['Open a shipment line, then press on a bar and drag it left or right. The days move as you drag.', 'Let go. A dialog asks why.', 'Type the reason and press Pin it.'],
    images: [before, during, after],
    changed: `The job was fixed to the date it was dropped on, the plan re-ran around it, and a "Manual pins" panel now lists it with the reason "${reason}". Every later run will honour the pin until it is released.`,
    why: 'The engine does not know about a customer visit or a machine arriving on Tuesday. A pin is how a planner overrules it, and the reason is what stops that becoming a mystery in six weeks.',
  }
})

await action('schedule-release', 'Schedule', 'Release a pin', async () => {
  await go('#/gantt', 'text=Manual pins')
  const pins = panelWith('Manual pins')
  const countBefore = await pins.locator('button:has-text("Release")').count()
  const before = await shot('schedule-release', 'before', {
    around: [pins],
    marks: [{ n: 1, at: pins.locator('button:has-text("Release")').first(), where: 'right', ring: true }],
    notes: ['Release this pin'],
  })
  await pins.locator('button:has-text("Release")').first().click()
  await until('the pin to go', (n) => {
    const s = [...document.querySelectorAll('section')].find((x) => x.querySelector('header > b')?.textContent === 'Manual pins')
    return !s || s.querySelectorAll('button').length < n
  }, countBefore)
  await settle()
  const stillThere = await page.locator('section > header > b:text-is("Manual pins")').count()
  const first = page.locator('[data-testid="gantt-order"]').first()
  await first.locator('button').first().click()
  await page.waitForSelector('[data-testid="gantt-bar"]', { timeout: 30_000 })
  await settle(400)
  const after = await shot('schedule-release', 'after', {
    around: [title('Schedule'), first],
    maxHeight: 700,
    marks: [{ n: 1, at: page.locator('[data-testid="gantt-bar"]').first(), where: 'left', ring: true }],
    notes: ['The bar, back where the engine puts it'],
  })
  return {
    steps: ['Find the pin in the "Manual pins" panel.', 'Press Release.'],
    images: [before, after],
    changed: `The pin was removed and the plan re-ran. ${stillThere ? 'The panel still lists the other pins.' : 'With no pins left, the panel itself disappears.'}`,
    why: 'A pin is a decision with a date on it. When the reason has passed, releasing it hands the job back to the engine.',
  }
})

// =============================================================================
// ORDER BOOK
// =============================================================================
await action('order-add', 'Order book', 'Add an order', async () => {
  await go('#/orders', 'tbody tr')
  const rowsBefore = await page.locator('tbody tr').count()
  const addButton = page.locator('button:has-text("Add an order")')
  const before = await shot('order-add', 'before', {
    around: [title('Order book'), page.locator('tbody tr').nth(2)],
    marks: [{ n: 1, at: addButton, where: 'left', ring: true }],
    notes: ['Add an order'],
  })
  await addButton.click()
  await page.waitForSelector('text=Creates its first shipment line')
  await page.fill('input[placeholder="SO/26-27/0500"]', 'SO/26-27/0999')
  await page.fill('input[type=number]', '450')
  await page.fill('input[type=date]', '2026-11-19')
  const during = await shot('order-add', 'dialog', {
    around: [modal()],
    marks: [
      { n: 1, at: page.locator('input[placeholder="SO/26-27/0500"]'), where: 'inside-right' },
      { n: 2, at: page.locator('[data-testid="modal"] input[type=number]').first(), where: 'inside-right' },
      { n: 3, at: page.locator('[data-testid="modal"] input[type=date]').first(), where: 'inside-right' },
      { n: 4, at: page.locator('button:has-text("Add order")'), where: 'right', ring: true },
    ],
    notes: ['The order number from the ERP', 'Quantity', 'The stuffing date, which everything is counted back from', 'Add order'],
  })
  await page.click('button:has-text("Add order")')
  await page.waitForSelector('text=SO/26-27/0999', { timeout: 60_000 })
  await settle(1500)
  const row = page.locator('tbody tr', { hasText: 'SO/26-27/0999' }).first()
  const breaches = (await row.locator('td').last().innerText()).trim()
  const after = await shot('order-add', 'after', {
    around: [title('Order book'), page.locator('tbody tr').last()],
    marks: [{ n: 1, at: row.locator('td').first(), where: 'left', dx: 2, ring: true }],
    notes: ['The new order, already planned: its breaches column is filled in'],
  })
  return {
    steps: ['Press Add an order.', 'Enter the ERP number, the customer, the article, the quantity, the stuffing date and the confidence.', 'Press Add order.'],
    images: [before, during, after],
    changed: `The book went from ${rowsBefore} orders to ${rowsBefore + 1}, and the schedule ran immediately: the new line shows ${breaches === '—' ? 'no breaches' : `${breaches} steps that cannot be made in time`} before anyone has looked at it.`,
    why: 'An order is planned the moment it exists. Nobody has to remember to re-plan, and the first thing anyone sees about a new order is whether it fits.',
  }
})

await action('order-lines', 'Order book', 'Open an order to see its shipment lines', async () => {
  await go('#/orders', 'tbody tr')
  const row = page.locator('tbody tr').first()
  const orderNo = (await row.locator('td').first().innerText()).trim()
  const before = await shot('order-lines', 'before', {
    around: [title('Order book'), page.locator('tbody tr').nth(3)],
    marks: [{ n: 1, at: row.locator('td').first(), where: 'left', dx: 2 }],
    notes: ['Click anywhere on an order’s row'],
  })
  await row.click()
  await page.waitForSelector('button:has-text("Add a shipment line")', { timeout: 30_000 })
  await settle(400)
  const lines = page.locator('button:has-text("Add a shipment line")')
  const after = await shot('order-lines', 'after', {
    around: [row, lines],
    marks: [
      { n: 1, at: page.locator('tbody tr').nth(1), where: 'inside', dx: -40, dy: 8 },
      { n: 2, at: lines, where: 'right' },
    ],
    notes: ['The order’s shipment lines: each has its own quantity, container and stuffing date', 'Add a shipment line: split the order across more than one container'],
  })
  return {
    steps: ['Click the order’s row.'],
    images: [before, after],
    changed: `${orderNo} opened to show its shipment lines, each with a quantity, a container reference, a stuffing date and a confidence. The row offers "Add a shipment line" and a way to delete the order.`,
    why: 'An order is not one dated promise. It ships in phases, and each phase is planned backwards from its own container. The shipment line is the unit the whole system works in.',
  }
})

// =============================================================================
// ACCEPT AN ORDER
// =============================================================================
await action('accept-no', 'Accept an order', 'Ask whether an order can be taken — and hear no', async () => {
  await go('#/accept', 'text=Can we take this order?')
  await page.fill('input[type=number]', '5000')
  await page.fill('input[type=date]', '2026-12-20')
  const before = await shot('accept-no', 'before', {
    around: [title('Can we take this order?'), page.locator('button:has-text("Check")')],
    marks: [
      { n: 1, at: page.locator('select'), where: 'inside-right', dx: -34 },
      { n: 2, at: page.locator('input[type=number]'), where: 'inside-right' },
      { n: 3, at: page.locator('input[type=date]'), where: 'inside-right', dx: -30 },
      { n: 4, at: page.locator('button:has-text("Check")'), where: 'above', ring: true },
    ],
    notes: ['The article', 'The quantity: 5,000', 'The stuffing date: 20 December', 'Check'],
  })
  await page.click('button:has-text("Check")')
  await page.waitForSelector('text=Not as it stands', { timeout: 120_000 })
  await settle()
  const verdict = (await page.locator('text=/steps cannot be made to this date/').first().innerText()).trim()
  const result = panelWith('Not as it stands')
  const flagged = result.locator('tbody tr').filter({ hasNotText: /Clear/ })
  const after = await shot('accept-no', 'after', {
    around: [result],
    maxHeight: 900,
    marks: [
      { n: 1, at: page.locator('text=/steps cannot be made to this date/').first(), where: 'left', dx: -6 },
      { n: 2, at: flagged.first().locator('td').last(), where: 'left', dx: 44 },
    ],
    notes: ['The answer in one line', 'Which steps fail, and why'],
  })
  return {
    steps: ['Choose the article, type the quantity and the stuffing date.', 'Press Check and wait: the whole factory is planned again with this line added, then the line is removed.'],
    images: [before, after],
    changed: `"${verdict}" Every department is listed with the dates it would need; the ones that fail say why. Nothing was added to the order book.`,
    why: 'This is the question that matters before anyone promises a buyer. The answer comes from the same engine as the real plan, against everything already committed.',
  }
})

await action('accept-yes', 'Accept an order', 'Ask again with a quantity that fits', async () => {
  await go('#/accept', 'text=Can we take this order?')
  await page.fill('input[type=number]', '40')
  await page.fill('input[type=date]', '2027-02-10')
  await page.click('button:has-text("Check")')
  await page.waitForSelector('text=/Every department can make this|steps cannot be made/', { timeout: 120_000 })
  await settle()
  const yes = (await page.locator('section > header > b').nth(1).innerText()).trim()
  const verdict = (await page.locator('text=/Every department can make this|steps cannot be made/').first().innerText()).trim()
  const result = panelWith(yes)
  const after = await shot('accept-yes', 'after', {
    around: [result],
    maxHeight: 700,
    marks: [{ n: 1, at: result.locator('header > b'), where: 'left' }],
    notes: [`The answer: ${yes}`],
  })
  return {
    steps: ['The same screen, with 40 pieces for 10 February 2027.', 'Press Check.'],
    images: [after],
    changed: `"${verdict}" The panel title reads "${yes}".`,
    why: 'The same check, the other answer. A merchandiser can try quantities and dates until one fits, and only then promise it.',
  }
})

// =============================================================================
// WHAT IF
// =============================================================================
await action('whatif-run', 'What if', 'Try a change on a copy of the plan', async () => {
  await go('#/whatif', 'text=Try a change')
  await page.fill('input[placeholder="Second shift on stitching through November"]', 'Stitching down for a fortnight')
  await page.selectOption('form select', { label: 'Stitching' })
  await page.click('button:has-text("Department down")')
  const before = await shot('whatif-run', 'before', {
    around: [panelWith('Try a change')],
    marks: [
      { n: 1, at: page.locator('input[placeholder="Second shift on stitching through November"]'), where: 'inside-right' },
      { n: 2, at: page.locator('form select'), where: 'inside-right', dx: -30 },
      { n: 3, at: page.locator('button:has-text("Department down")'), where: 'below', ring: true },
      { n: 4, at: page.locator('button:has-text("Run it")'), where: 'above', dy: 2 },
    ],
    notes: ['What you are trying, in your own words', 'The department', 'The change: department down, overtime, or a second shift', 'Run it'],
  })
  await page.click('button:has-text("Run it")')
  await page.waitForSelector('text=What changed', { timeout: 120_000 })
  await settle()
  const main = await page.locator('main').innerText()
  const tile = (l) => num(main.match(new RegExp(`${l}\\s*\\n\\s*([\\d,]+)`, 'i'))?.[1] ?? 'NaN')
  const now = tile('Breaches now')
  const then = tile('Breaches in this scenario')
  const changed = await panelWith('What changed').locator('tbody tr').count()
  const after = await shot('whatif-run', 'after', {
    around: [page.locator('.label:text-is("Breaches now")'), panelWith('Stitching down for a fortnight').locator('tbody tr').nth(4)],
    maxHeight: 900,
    marks: [
      { n: 1, at: page.locator('.label:text-is("Breaches in this scenario")'), where: 'right' },
      { n: 2, at: panelWith('Stitching down for a fortnight').locator('header > b'), where: 'left' },
    ],
    notes: ['Before and after, in four tiles', 'Department by department against the live plan'],
  })
  return {
    steps: ['Name the scenario.', 'Choose the department and the change. Department down means no output at all; overtime adds a fifth; a second shift doubles.', 'Press Run it and wait about a minute on the live system, a second or two here.'],
    images: [before, after],
    changed: `Breaches went from ${now} in the live plan to ${then} in the scenario, and ${changed} jobs moved. The live plan was not touched.`,
    why: 'Taking a department out for a fortnight cannot make the plan better, and the screen says exactly how much worse. The same lever answers "would a second shift fix it?" before anyone is hired.',
  }
})

await action('whatif-promote', 'What if', 'Make a scenario the plan', async () => {
  await go('#/whatif', 'text=Try a change')
  await page.fill('input[placeholder="Second shift on stitching through November"]', 'Overtime on stitching')
  await page.selectOption('form select', { label: 'Stitching' })
  await page.click('button:has-text("Overtime")')
  await page.click('button:has-text("Run it")')
  await page.waitForSelector('text=What changed', { timeout: 120_000 })
  await settle()
  const promote = page.locator('button:has-text("Make this the plan")')
  const before = await shot('whatif-promote', 'before', {
    around: [panelWith('Overtime on stitching')],
    maxHeight: 900,
    marks: [
      { n: 1, at: promote, where: 'right', ring: true },
      { n: 2, at: page.locator('button:has-text("Discard")'), where: 'right' },
    ],
    notes: ['Make this the plan', 'Discard: keep the run in the list, but do nothing with it'],
  })
  await promote.click()
  await until('the scenario to become the live plan', () =>
    [...document.querySelectorAll('tr')].some((r) => r.textContent?.includes('Live plan') && r.textContent?.includes('Overtime on stitching')),
  )
  await settle()
  const runs = panelWith('Runs')
  const liveRow = runs.locator('tr', { hasText: 'Live plan' }).first()
  const after = await shot('whatif-promote', 'after', {
    around: [runs.locator('header'), runs.locator('tbody tr').nth(3)],
    marks: [{ n: 1, at: liveRow.locator('td').first(), where: 'left', dx: 2, ring: true }],
    notes: ['The scenario is now marked as the live plan; the plan it replaced is still in the list'],
  })
  return {
    steps: ['Run a scenario, or press Compare on one in the Runs list.', 'Press Make this the plan.'],
    images: [before, after],
    changed: 'The scenario "Overtime on stitching" became the live plan. Every screen now reads from it. The plan it replaced is still in the Runs list and can be compared or brought back.',
    why: 'Deciding is a separate step from trying. Nothing becomes the plan until somebody says so, and the previous plan is never lost.',
  }
})

// =============================================================================
// WIP
// =============================================================================
await action('wip-expand', 'WIP', 'Open an order in progress to see its route', async () => {
  await go('#/wip', 'text=Ready to stuff')
  const running = page.locator('[data-testid="wip-running"]')
  const card = running.locator('button').first()
  const before = await shot('wip-expand', 'before', {
    around: [title('In progress'), running],
    maxHeight: 600,
    marks: [{ n: 1, at: card, where: 'inside', dx: -40, dy: 6 }],
    notes: ['An order part-way through the factory. Click it.'],
  })
  await card.click()
  await settle(500)
  const after = await shot('wip-expand', 'after', {
    around: [title('In progress'), running],
    maxHeight: 900,
    marks: [{ n: 1, at: running.locator('text=Ply Cutting').first(), where: 'left' }],
    notes: ['Every department on the route, and what each has made and handed on'],
  })
  const text = await running.innerText()
  const pct = text.match(/(\d+)%/)?.[1]
  return {
    steps: ['Click the order card under "In progress".'],
    images: [before, after],
    changed: `The card opened to show the route department by department: what each was asked for, what it declared, and what the next department counted in. The line is ${pct ?? '—'}% of the way through.`,
    why: 'Counted, not valued: every figure here is something a department declared against what the plan asked for. It is where "where is my order?" is answered without a phone call.',
  }
})

// =============================================================================
// MY DEPARTMENT
// =============================================================================
await action('board-pick', 'My department', 'Choose a department and read its day', async () => {
  await go('#/board', 'text=What you owe')
  const select = page.locator('[data-testid="board-department"]')
  const before = await shot('board-pick', 'before', {
    around: [select, page.locator('[data-testid="board-queue"]')],
    maxHeight: 700,
    marks: [{ n: 1, at: select, where: 'right' }],
    notes: ['Pick the department'],
  })
  await select.selectOption('STAPLE')
  await settle(900)
  const inbound = page.locator('[data-testid="board-inbound"]')
  const queue = page.locator('[data-testid="board-queue"]')
  const after = await shot('board-pick', 'after', {
    around: [inbound, queue],
    maxHeight: 1100,
    marks: [
      { n: 1, at: inbound, where: 'inside', dx: -40, dy: 6 },
      { n: 2, at: queue, where: 'inside', dx: -40, dy: 6 },
    ],
    notes: ['What is coming in, and from which department', 'What this department owes, late work first'],
  })
  return {
    steps: ['Pick a department from the list.'],
    images: [before, after],
    changed: 'Stapling’s board: what it is waiting for from Foam Pasting and Stitching, then what it owes, with late work separated from work not yet due.',
    why: 'A department head needs one list: what can I start, and what am I holding up. The feeders are named from the route, so nobody has to know the whole factory to read it.',
  }
})

// =============================================================================
// PRODUCTION
// =============================================================================
await action('production-declare', 'Production', 'Write down what was made', async () => {
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STITCH')
  await settle(800)
  const empty = page.locator('[data-testid="production-empty"]')
  if (await empty.count()) {
    await empty.locator('button').first().click()
    await settle(800)
  }
  const list = page.locator('[data-testid="production-worklist"]')
  const good = list.locator('input[type=number]:visible').first()
  const before = await shot('production-declare', 'before', {
    around: [page.locator('[data-testid="production-department"]'), list],
    maxHeight: 900,
    marks: [
      { n: 1, at: page.locator('[data-testid="production-department"]'), where: 'below' },
      { n: 2, at: page.locator('[data-testid="production-date"]'), where: 'below' },
      { n: 3, at: good, where: 'left', ring: true },
    ],
    notes: ['The department', 'The day', 'Good pieces made: type the number and press Enter'],
  })
  await good.fill('26')
  await good.press('Enter')
  await page.waitForSelector('text=Entered', { timeout: 60_000 })
  await settle()
  const after = await shot('production-declare', 'after', {
    around: [list],
    maxHeight: 700,
    marks: [{ n: 1, at: list.getByText('Entered', { exact: true }).locator('visible=true').first(), where: 'left', ring: true }],
    notes: ['Entered: the figure is in the ledger'],
  })
  return {
    steps: ['Choose the department and the day. If the day has no work, the screen offers the days that do.', 'Type the good pieces, and any rejected, against each job.', 'Press Enter, or Save.'],
    images: [before, after],
    changed: 'Stitching declared 26 good pieces against one job. The button reads "Entered". Dates did not move: declaring output never changes the plan, it records what happened against it.',
    why: 'Two minutes a day per department is what brings WIP, the dashboard, quality and the forecast to life. Good and rejected are counted separately; the percentage is worked out, never typed.',
  }
})

await action('production-handover', 'Production', 'Count in what the previous department handed over', async () => {
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STAPLE')
  await page.waitForSelector('[data-testid="pending-acceptance"]', { timeout: 60_000 })
  await settle(500)
  const pending = page.locator('[data-testid="pending-acceptance"]')
  const received = pending.locator('input[type=number]:visible').first()
  const before = await shot('production-handover', 'before', {
    around: [pending],
    maxHeight: 700,
    marks: [{ n: 1, at: received, where: 'left', ring: true }],
    notes: ['What stitching declared, waiting for stapling to count it: type what actually arrived'],
  })
  await received.fill('24')
  const shortfall = page.locator('[data-testid="shortfall"]:visible').first()
  await shortfall.waitFor({ timeout: 10_000 })
  const said = (await shortfall.innerText()).trim()
  const countIn = page.locator('button:visible', { hasText: 'Count in' }).first()
  const during = await shot('production-handover', 'typed', {
    around: [pending],
    maxHeight: 700,
    marks: [
      { n: 1, at: shortfall, where: 'right' },
      { n: 2, at: countIn, where: 'right', ring: true },
    ],
    notes: [`The difference, worked out as you type: ${said}`, 'Count in'],
  })
  await countIn.click()
  await until('the handover to leave the queue', () => !document.querySelector('[data-testid="pending-acceptance"]'))
  await settle()
  const after = await shot('production-handover', 'after', {
    around: [page.locator('[data-testid="production-department"]'), page.locator('main')],
    maxHeight: 700,
    marks: [{ n: 1, at: title('What you can do today'), where: 'left' }],
    notes: ['The queue is empty: the handover is counted and the shortfall kept'],
  })
  return {
    steps: ['Choose the receiving department. Anything the previous department declared and this one has not counted sits at the top.', 'Type what actually arrived.', 'Press Count in.'],
    images: [before, during, after],
    changed: `Stitching had declared 26; stapling counted 24. The shortfall of ${said.split(' ')[0]} is kept against the handover rather than smoothed away, and the item left the queue.`,
    why: 'Two-sided counting is what makes WIP believable. One department’s claim is not the record; the next department’s count is.',
  }
})

await action('production-attendance', 'Production', 'Say who came in, and watch the day’s capacity follow', async () => {
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STITCH')
  await settle(800)
  const cap = page.locator('[data-testid="todays-capacity"]')
  const who = cap.locator('input[type=number]:visible').first()
  const save = cap.locator('button:has-text("Save")').first()
  const textBefore = (await cap.innerText()).replace(/\s+/g, ' ')
  const before = await shot('production-attendance', 'before', {
    around: [cap],
    maxHeight: 600,
    marks: [
      { n: 1, at: who, where: 'inside-right' },
      { n: 2, at: save, where: 'right', ring: true },
    ],
    notes: ['Who came in: the head count for this shift today', 'Save'],
  })
  await who.fill('5')
  await save.click()
  await until('the capacity line to change', (was) => {
    const el = document.querySelector('[data-testid="todays-capacity"]')
    return el && el.innerText.replace(/\s+/g, ' ') !== was && !/Saving/.test(el.innerText)
  }, textBefore)
  await settle()
  const after = await shot('production-attendance', 'after', {
    around: [cap],
    maxHeight: 600,
    marks: [{ n: 1, at: cap.locator('text=/of \\d+ in|came in|capacity/i').first(), where: 'left' }],
    notes: ['The day’s capacity, moved in proportion to the crew'],
  })
  const textAfter = (await cap.innerText()).split('\n').filter((l) => /in\b|capacity|rate/i.test(l)).slice(0, 2).join(' · ')
  return {
    steps: ['Under "What you can do today", type how many people are in on the shift.', 'Press Save.'],
    images: [before, after],
    changed: `Five in against a sanctioned crew moved the day’s capacity in proportion (${textAfter}). The plan re-ran with that day shorter.`,
    why: 'The standing rate assumes the crew it was measured with. Half the people means half the day, and the engine should know that before the day is planned, not after it is missed.',
  }
})

// =============================================================================
// MANPOWER
// =============================================================================
await action('manpower-out', 'Manpower', 'Mark one person out', async () => {
  await go('#/manpower', 'text=Who is in')
  await page.selectOption('[data-testid="manpower-department"]', 'STITCH')
  await settle(900)
  const card = page.locator('[data-testid="manpower-dept-STITCH"]')
  const present = Number(await card.getAttribute('data-present'))
  const person = page
    .locator('[data-testid="manpower-people"] > div > div')
    .filter({ has: page.locator('button.border-blue:has-text("In")') })
    .first()
  const name = (await person.innerText()).split('\n')[0]
  const before = await shot('manpower-out', 'before', {
    around: [card, person],
    maxHeight: 900,
    marks: [
      { n: 1, at: card, where: 'inside', dx: -40, dy: 6 },
      { n: 2, at: person.getByRole('button', { name: 'Out' }), where: 'right', ring: true },
    ],
    notes: [`Stitching today: ${present} in`, `${name}: press Out`],
  })
  await person.getByRole('button', { name: 'Out' }).click()
  await until('the head count to drop', (n) => document.querySelector('[data-testid="manpower-dept-STITCH"]')?.getAttribute('data-present') === String(n), present - 1)
  await settle()
  const after = await shot('manpower-out', 'after', {
    around: [card, person],
    maxHeight: 900,
    marks: [{ n: 1, at: card, where: 'inside', dx: -40, dy: 6 }],
    notes: [`Stitching today: ${present - 1} in`],
  })
  return {
    steps: ['Choose the department.', 'Find the person and press Out (or On leave).'],
    images: [before, after],
    changed: `${name} is marked out. Stitching’s head count went from ${present} to ${present - 1} without anyone typing a total, and the Production screen’s "what you can do today" reads the same figure.`,
    why: 'Attendance is recorded once, per person, and the department’s number is derived from it. Two ways to say how many came in is how a wrong number ends up looking normal.',
  }
})

// =============================================================================
// MATERIAL
// =============================================================================
await action('material-count', 'Material', 'Count a material in the store', async () => {
  await go('#/material', 'text=Against the store')
  await settle(500)
  const row = page.locator('[data-testid^="material-"][data-status="not counted"]').first()
  const code = (await row.getAttribute('data-testid')).replace('material-', '')
  const button = row.locator('button').first()
  const before = await shot('material-count', 'before', {
    around: [title('Against the store'), row],
    maxHeight: 900,
    marks: [{ n: 1, at: button, where: 'left', ring: true }],
    notes: ['On hand: click the dash and type the count'],
  })
  await button.click()
  await editor().fill('999999')
  await editor().press('Enter')
  await until(`${code} to be counted`, (c) => document.querySelector(`[data-testid="material-${c}"]`)?.getAttribute('data-status') === 'covered', code)
  await settle()
  const after = await shot('material-count', 'after', {
    around: [title('Against the store'), row],
    maxHeight: 900,
    marks: [{ n: 1, at: row, where: 'inside', dx: -40, dy: 4 }],
    notes: ['The row moved from "not counted" to "covered"'],
  })
  return {
    steps: ['Under "Against the store", click the On hand figure on a row.', 'Type the count and press Enter.'],
    images: [before, after],
    changed: `${code} went from "not counted" to "covered". Counting the store did not re-run the schedule: it changes whether the plan can be met, which is a different question from what the plan is.`,
    why: '"Nobody has counted it" and "there is none" are kept apart on purpose. A material that is short raises a warning; one that is past its ordering date raises a critical finding; one that is uncounted says so.',
  }
})

// =============================================================================
// MONEY
// =============================================================================
await action('money-breakdown', 'Money', 'Open an article’s cost sheet', async () => {
  await go('#/money', 'text=Money out, week by week')
  await settle(500)
  const costed = page.locator('[data-testid="cost-UD354 SPPL WAL"]')
  const before = await shot('money-breakdown', 'before', {
    around: [title('Article costs').or(page.locator('[data-testid="article-costs"]')).first(), costed],
    maxHeight: 700,
    marks: [{ n: 1, at: costed, where: 'inside', dx: -40, dy: 4 }],
    notes: ['An article with a cost sheet behind it: click the row'],
  })
  await costed.click()
  await settle(400)
  const detail = page.locator('[data-testid="article-costs"]')
  const after = await shot('money-breakdown', 'after', {
    around: [detail],
    maxHeight: 1100,
    marks: [{ n: 1, at: costed, where: 'inside', dx: -40, dy: 4 }],
    notes: ['The cost lines, summing to the unit cost'],
  })
  return {
    steps: ['Under article costs, click an article that shows a breakdown.'],
    images: [before, after],
    changed: 'The Betsy chair opened into its cost lines: leather, foam, labour and the rest, summing to the unit cost that the cash-out panel uses.',
    why: 'Cash out by week is only as honest as the costs behind it. The panel says what it cannot price rather than totalling only what it can.',
  }
})

// =============================================================================
// CAPACITY SHEET
// =============================================================================
/** The view and the filter persist across hash navigation; start each action from the default. */
const resetCapacitySheet = async () => {
  await page.click('button:text-is("Units per day")')
  await page.fill('input[placeholder="Code or name"]', '')
  await settle(400)
}

await action('capacity-views', 'Capacity sheet', 'Switch between rate, crew and day-count; find one article', async () => {
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await resetCapacitySheet()
  const before = await shot('capacity-views', 'before', {
    around: [title('Capacity sheet'), page.locator('[data-testid="capacity-grid"] tbody tr').nth(2)],
    maxHeight: 800,
    marks: [
      { n: 1, at: page.locator('button:text-is("Units per day")'), where: 'below' },
      { n: 2, at: page.locator('button:text-is("Manpower")'), where: 'below' },
      { n: 3, at: page.locator('button:text-is("D-minus")'), where: 'below' },
      { n: 4, at: page.locator('input[placeholder="Code or name"]'), where: 'inside-right' },
    ],
    notes: ['Units per day: how many pieces a day, working on nothing else', 'Manpower: the crew behind that rate', 'D-minus: days before stuffing the department must finish', 'Find an article by code or name'],
  })
  await page.click('button:text-is("D-minus")')
  await page.fill('input[placeholder="Code or name"]', 'UD354')
  await settle(500)
  const after = await shot('capacity-views', 'after', {
    around: [title('Capacity sheet'), page.locator('[data-testid="capacity-grid"]')],
    maxHeight: 800,
    marks: [{ n: 1, at: page.locator('[data-testid="capacity-grid"] tbody tr').first(), where: 'inside', dx: -40, dy: 6 }],
    notes: ['One article, one row, in days before stuffing'],
  })
  return {
    steps: ['Press one of the three views.', 'Type part of a code or a name to show one article.'],
    images: [before, after],
    changed: 'The grid switched to day-counts and narrowed to the Betsy chair. Each cell is one article in one department; a blank means the article does not go there.',
    why: 'One number per cell, because three across a thousand cells is not something anyone can read. This is the grid every other number in the system is arithmetic on.',
  }
})

await action('capacity-rate', 'Capacity sheet', 'Enter a rate, and route an article through a department', async () => {
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await resetCapacitySheet()
  const pairings = await readMetric('Department pairings')
  // The first blank cell in the first row — "does not go here" — whichever
  // department that is in this build's data.
  const blank = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('[data-testid="capacity-grid"] thead th')].map((h) => h.textContent?.trim())
    const row = document.querySelector('[data-testid="capacity-grid"] tbody tr')
    const tds = [...(row?.querySelectorAll('td') ?? [])]
    for (let i = 1; i < tds.length; i += 1) {
      const b = tds[i].querySelector('button')
      if (b && /^[·—–-]?$/.test(b.textContent?.trim() ?? '')) return { col: i, dept: heads[i] }
    }
    return null
  })
  if (!blank) throw new Error('no blank cell in the first row to enter a rate into')
  const article = (await page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('td').first().innerText()).split('\n')[0].trim()
  const cell = page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('td').nth(blank.col).locator('button').first()
  const before = await shot('capacity-rate', 'before', {
    around: [page.locator('.label:text-is("Articles routed")'), page.locator('[data-testid="capacity-grid"] tbody tr').last()],
    maxHeight: 900,
    marks: [
      { n: 1, at: page.locator('.label:text-is("Department pairings")'), where: 'inside-right', dx: 30 },
      { n: 2, at: cell, where: 'left', ring: true },
    ],
    notes: [`Department pairings: ${pairings}`, `A blank cell: ${article} does not pass through ${blank.dept} yet`],
  })
  await cell.click()
  await editor().fill('42')
  await editor().press('Enter')
  await page.waitForSelector('button:has-text("42")', { timeout: 60_000 })
  await until('the pairing count to rise', (n) => {
    const t = document.querySelector('main')?.innerText ?? ''
    return Number(t.match(/Department pairings\s*\n\s*([\d,]+)/i)?.[1]?.replace(/,/g, '')) > n
  }, pairings)
  await settle()
  const after = await shot('capacity-rate', 'after', {
    around: [page.locator('.label:text-is("Articles routed")'), page.locator('[data-testid="capacity-grid"] tbody tr').last()],
    maxHeight: 900,
    marks: [
      { n: 1, at: page.locator('.label:text-is("Department pairings")'), where: 'inside-right', dx: 30 },
      { n: 2, at: page.locator('[data-testid="capacity-grid"] button:has-text("42")').first(), where: 'left', ring: true },
    ],
    notes: [`Department pairings: ${pairings + 1}`, 'The rate, saved'],
  })
  return {
    steps: ['Click a blank cell under Units per day.', 'Type the rate and press Enter.'],
    images: [before, after],
    changed: `A rate of 42 routed ${article} through ${blank.dept}: pairings went from ${pairings} to ${pairings + 1}, and the schedule re-ran with a new job in it.`,
    why: 'A units figure means "this article passes through here at this speed". Clearing it removes the step. The rate is what the department makes in a day doing nothing else, which is what lets several products share a day.',
  }
})

await action('capacity-conflict', 'Capacity sheet', 'Enter a day-count the route contradicts, and correct it', async () => {
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await resetCapacitySheet()
  await page.click('button:text-is("D-minus")')
  await settle(400)
  const grid = page.locator('[data-testid="capacity-grid"]')
  const sand = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('[data-testid="capacity-grid"] thead th')].map((h) => h.textContent?.trim())
    return heads.indexOf('SAND')
  })
  const cellAt = () => grid.locator('tbody tr').first().locator('td').nth(sand).locator('button')
  const was = (await cellAt().innerText()).trim()
  const assyCol = await page.evaluate(() => [...document.querySelectorAll('[data-testid="capacity-grid"] thead th')].map((h) => h.textContent?.trim()).indexOf('ASSY'))
  const assy = (await grid.locator('tbody tr').first().locator('td').nth(assyCol).locator('button').innerText()).trim().replace(/\D/g, '')
  const before = await shot('capacity-conflict', 'before', {
    around: [title('Capacity sheet'), grid.locator('tbody tr').last()],
    maxHeight: 800,
    marks: [{ n: 1, at: cellAt(), where: 'left', ring: true }],
    notes: [`Sanding’s day-count on this article: ${was}. Assembly, which feeds it, is at D-${assy}.`],
  })
  await cellAt().click()
  await editor().fill('70')
  await editor().press('Enter')
  await page.waitForSelector('text=A department is due before something that feeds it', { timeout: 60_000 })
  await page.waitForSelector('text=Causing breaches', { timeout: 60_000 })
  await settle()
  const warning = panelWith('A department is due before something that feeds it')
  const during = await shot('capacity-conflict', 'warning', {
    around: [warning],
    maxHeight: 700,
    marks: [{ n: 1, at: warning.locator('header > b'), where: 'left' }],
    notes: ['The warning, naming both departments and whether it is causing breaches now'],
  })
  await cellAt().click()
  await editor().fill(was.replace(/\D/g, ''))
  await editor().press('Enter')
  await until('the warning to clear', () => !document.body.textContent?.includes('A department is due before something that feeds it'))
  await settle()
  const after = await shot('capacity-conflict', 'after', {
    around: [title('Capacity sheet'), grid.locator('tbody tr').last()],
    maxHeight: 800,
    marks: [{ n: 1, at: cellAt(), where: 'left', ring: true }],
    notes: ['Back to the original figure; the warning is gone'],
  })
  return {
    steps: [`Under D-minus, click sanding’s cell and type 70. Assembly feeds sanding and is at D-${assy}, so sanding would be due before assembly had finished.`, 'Read the warning panel that appears above the grid.', `Type ${was.replace(/\D/g, '')} again.`],
    images: [before, during, after],
    changed: `The warning "A department is due before something that feeds it" appeared, marked "Causing breaches": sanding at D-70 against assembly at D-${assy}. Correcting the figure cleared it rather than leaving it to be dismissed.`,
    why: 'The software will not guess which of the two numbers is wrong. While the contradiction stands, the engine holds the work behind something not yet due and reports breaches that are not real, so it says so loudly.',
  }
})

await action('capacity-cost', 'Capacity sheet', 'Give an article a cost, and read it on the dashboard', async () => {
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await resetCapacitySheet()
  await page.fill('input[placeholder="Code or name"]', 'UT263')
  await settle(500)
  const costButton = page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('[data-testid="article-cost"] button').first()
  const before = await shot('capacity-cost', 'before', {
    around: [title('Capacity sheet'), page.locator('[data-testid="capacity-grid"]')],
    maxHeight: 700,
    marks: [{ n: 1, at: costButton, where: 'right', ring: true }],
    notes: ['cost: one rupee figure per article, beside its name'],
  })
  await costButton.click()
  await editor().fill('16760')
  await editor().press('Enter')
  await settle(1500)
  await go('#/dashboard', 'text=Is the factory on track today?')
  await until('WIP value to appear', () => !/WIP value[\s\S]*?capacity sheet/i.test(document.querySelector('[data-testid="md-kpis"]')?.textContent ?? ''))
  await settle()
  const kpis = page.locator('[data-testid="md-kpis"]')
  const wip = kpis.locator('> div').filter({ hasText: 'WIP value' }).first()
  const figure = (await wip.innerText()).split('\n').slice(0, 3).join(' ')
  const after = await shot('capacity-cost', 'after', {
    around: [kpis],
    maxHeight: 800,
    marks: [{ n: 1, at: wip, where: 'inside', dx: -40, dy: 6 }],
    notes: ['WIP value on the dashboard, with how many lines in progress it covers'],
  })
  // Put it back, so the dashboard can go on refusing to invent a figure.
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await page.fill('input[placeholder="Code or name"]', 'UT263')
  await settle(400)
  await page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('[data-testid="article-cost"] button').first().click()
  await editor().fill('')
  await editor().press('Enter')
  await page.waitForSelector('[data-testid="article-cost"] button:has-text("cost")', { timeout: 30_000 })
  return {
    steps: ['Find the article and click "cost" in its row header.', 'Type the unit cost and press Enter.', 'Open the Dashboard.'],
    images: [before, after],
    changed: `A cost of 16,760 on the article in progress gave the dashboard a WIP value (${figure}). Before it, the tile said what it was waiting for rather than showing a zero.`,
    why: 'WIP value is the figure an MD quotes first and the one most easily invented. It is computed only from articles that have a cost, and it says how many lines it covers.',
  }
})

// =============================================================================
// MASTERS
// =============================================================================
await action('masters-yield', 'Masters', 'Change a department’s yield', async () => {
  await go('#/masters', 'text=Production route')
  const route = panelWith('Production route')
  const row = route.locator('tbody tr', { hasText: 'STITCH' }).first()
  const yieldCell = row.locator('button:has-text("%")').first()
  const was = (await yieldCell.innerText()).trim()
  const before = await shot('masters-yield', 'before', {
    around: [route.locator('header'), row],
    maxHeight: 800,
    marks: [{ n: 1, at: yieldCell, where: 'left', ring: true }],
    notes: [`Stitching’s yield: ${was}. Underlined values are editable: click, type, Enter.`],
  })
  await yieldCell.click()
  await editor().fill('95')
  await editor().press('Enter')
  await page.waitForSelector('button:has-text("95%")', { timeout: 60_000 })
  await settle()
  const after = await shot('masters-yield', 'after', {
    around: [route.locator('header'), row],
    maxHeight: 800,
    marks: [{ n: 1, at: row.locator('button:has-text("95%")').first(), where: 'left', ring: true }],
    notes: ['Saved, and the plan re-ran'],
  })
  await row.locator('button:has-text("95%")').first().click()
  await editor().fill(was.replace(/\D/g, ''))
  await editor().press('Enter')
  await page.waitForSelector(`button:has-text("${was}")`, { timeout: 60_000 })
  return {
    steps: ['Under Production route, click the yield figure on a department.', 'Type the new percentage and press Enter.'],
    images: [before, after],
    changed: `Stitching’s yield went from ${was} to 95% and the schedule re-ran: every department before stitching now has to make a little more, so that enough survives. (Put back to ${was} afterwards.)`,
    why: 'Losses compound down the route. A yield is not a note about a department; it changes how many pieces every earlier department is asked for.',
  }
})

await action('masters-feeds', 'Masters', 'Change what feeds what', async () => {
  await go('#/masters', 'text=What feeds what')
  const grid = page.locator('[data-testid="route-dependency-grid"]')
  const columns = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="route-dependency-grid"] thead th')].map((h) => h.textContent?.trim()),
  )
  const cell = grid.locator('tbody tr').filter({ hasText: 'SAND' }).first().locator('td').nth(columns.indexOf('ASSY')).locator('button')
  const was = (await cell.innerText()).trim()
  const before = await shot('masters-feeds', 'before', {
    around: [title('What feeds what'), grid],
    maxHeight: 900,
    marks: [{ n: 1, at: cell, where: 'left', ring: true }],
    notes: [`Row SAND, column ASSY: ${was === '●' ? 'assembly feeds sanding' : 'no link'}. Click to toggle.`],
  })
  await cell.click()
  await until('the cell to toggle', ({ r, c, v }) => {
    const table = document.querySelector('[data-testid="route-dependency-grid"]')
    const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find((x) => x.querySelector('td')?.textContent?.trim().startsWith(r))
    return row?.querySelectorAll('td')[c]?.textContent?.trim() !== v
  }, { r: 'SAND', c: columns.indexOf('ASSY'), v: was })
  await settle()
  const after = await shot('masters-feeds', 'after', {
    around: [title('What feeds what'), grid],
    maxHeight: 900,
    marks: [{ n: 1, at: cell, where: 'left', ring: true }],
    notes: ['Toggled: sanding no longer waits for assembly'],
  })
  await cell.click()
  await until('the cell to toggle back', ({ r, c, v }) => {
    const table = document.querySelector('[data-testid="route-dependency-grid"]')
    const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find((x) => x.querySelector('td')?.textContent?.trim().startsWith(r))
    return row?.querySelectorAll('td')[c]?.textContent?.trim() === v
  }, { r: 'SAND', c: columns.indexOf('ASSY'), v: was })
  await settle()
  return {
    steps: ['Under What feeds what, find the row of the department that waits and the column of the one it waits for.', 'Click the cell to toggle the link.'],
    images: [before, after],
    changed: 'The link from assembly to sanding was removed and the plan re-ran: sanding no longer had to wait for assembly, so a runway breach that depended on that link went with it. The factory map redraws from the same grid. (Put back afterwards.)',
    why: 'The route is a graph, not a line. Departments that nothing connects run in parallel, and a false link holds work behind something it never waited for.',
  }
})

await action('masters-shift', 'Masters', 'Switch a second shift on for a department', async () => {
  await go('#/masters', 'text=Who works which shift')
  const grid = panelWith('Who works which shift')
  const shiftRow = page.locator('tr', { hasText: 'Shift A' }).first()
  const on = shiftRow.getByRole('button', { name: 'Switch on' })
  const before = await shot('masters-shift', 'before', {
    around: [title('Shifts'), grid],
    maxHeight: 1000,
    marks: [{ n: 1, at: on, where: 'right', ring: true }],
    notes: ['Shift A exists but is switched off: switch it on'],
  })
  await on.click()
  await settle(800)
  const stitch = grid.locator('tr', { hasText: 'STITCH' })
  const notRunning = stitch.getByRole('button', { name: 'Not running' }).first()
  await notRunning.waitFor({ timeout: 30_000 })
  const during = await shot('masters-shift', 'department', {
    around: [grid],
    maxHeight: 900,
    marks: [{ n: 1, at: notRunning, where: 'right', ring: true }],
    notes: ['Stitching on shift A: Not running. Click it.'],
  })
  const runningBefore = await stitch.getByRole('button', { name: 'Running', exact: true }).count()
  await notRunning.click()
  await until('stitching to run on shift A', (n) => {
    const section = [...document.querySelectorAll('section')].find((s) => s.textContent?.includes('Who works which shift'))
    const row = [...(section?.querySelectorAll('tr') ?? [])].find((r) => r.textContent?.includes('STITCH'))
    return [...(row?.querySelectorAll('button') ?? [])].filter((b) => b.textContent?.trim() === 'Running').length > n
  }, runningBefore)
  await settle()
  const after = await shot('masters-shift', 'after', {
    around: [grid],
    maxHeight: 900,
    marks: [{ n: 1, at: stitch.getByRole('button', { name: 'Running', exact: true }).last(), where: 'right', ring: true }],
    notes: ['Running: the shift’s rates were copied from the first shift as a starting point'],
  })
  return {
    steps: ['Under Shifts, press Switch on beside the shift.', 'Under Who works which shift, click Not running on the department.'],
    images: [before, during, after],
    changed: 'Stitching now runs two shifts. Its rates on shift A were copied across, so the department’s day roughly doubled and the plan re-ran. The headcount beneath can be edited.',
    why: 'Capacity is per department per shift. The copied rates are a starting point and will be wrong if the second shift is staffed differently; a pairing switched on with no rates at all is flagged in red.',
  }
})

await action('masters-dminus', 'Masters', 'Edit the D-minus matrix', async () => {
  await go('#/masters', 'text=D-minus matrix')
  const matrix = panelWith('D-minus matrix')
  const cell = page.locator('button:has-text("D-80")').first()
  const before = await shot('masters-dminus', 'before', {
    around: [matrix.locator('header'), cell],
    maxHeight: 700,
    marks: [{ n: 1, at: cell, where: 'left', ring: true }],
    notes: ['A day-count: click, type, Enter'],
  })
  await cell.click()
  await editor().fill('84')
  await editor().press('Enter')
  await page.waitForSelector('button:has-text("D-84")', { timeout: 60_000 })
  await settle()
  const after = await shot('masters-dminus', 'after', {
    around: [matrix.locator('header'), page.locator('button:has-text("D-84")').first()],
    maxHeight: 700,
    marks: [{ n: 1, at: page.locator('button:has-text("D-84")').first(), where: 'left', ring: true }],
    notes: ['Saved; the plan re-ran with that step due four days earlier'],
  })
  return {
    steps: ['Under D-minus matrix, click a cell.', 'Type the number of days before stuffing and press Enter. Clearing it leaves the cell blank, and that article stops scheduling until it is filled.'],
    images: [before, after],
    changed: 'D-80 became D-84: that department must now finish four working days earlier on that article, and the schedule re-ran. A blank cell blocks scheduling rather than defaulting to zero.',
    why: 'This is the same grid as the Capacity sheet’s D-minus view, kept here beside the route. A silent zero would produce an impossible schedule that looks entirely normal on screen.',
  }
})

await action('masters-holiday', 'Masters', 'Declare a holiday', async () => {
  await go('#/masters', 'text=Holidays')
  const holidays = panelWith('Holidays')
  const add = page.locator('button:has-text("Add a holiday")')
  const rowsBefore = await holidays.locator('tbody tr, li').count()
  const before = await shot('masters-holiday', 'before', {
    around: [holidays],
    clipTo: holidays,
    maxHeight: 700,
    marks: [{ n: 1, at: add, where: 'right', ring: true }],
    notes: ['Add a holiday'],
  })
  await add.click()
  await modal().waitFor()
  await modal().locator('input[type=date]').fill('2026-11-11')
  await modal().getByPlaceholder('Diwali').fill('Stock-taking')
  const during = await shot('masters-holiday', 'dialog', {
    around: [modal()],
    marks: [
      { n: 1, at: modal().locator('input[type=date]'), where: 'inside-right', dx: -30 },
      { n: 2, at: modal().getByPlaceholder('Diwali'), where: 'inside-right' },
      { n: 3, at: modal().locator('button:has-text("Add holiday")'), where: 'right', ring: true },
    ],
    notes: ['The date', 'What it is', 'Add holiday'],
  })
  await modal().locator('button:has-text("Add holiday")').click()
  await until('the holiday to be listed', (n) => {
    const s = [...document.querySelectorAll('section')].find((x) => x.querySelector('header > b')?.textContent === 'Holidays')
    return (s?.querySelectorAll('tbody tr, li').length ?? 0) > n
  }, rowsBefore)
  await settle()
  const after = await shot('masters-holiday', 'after', {
    around: [holidays],
    clipTo: holidays,
    maxHeight: 700,
    marks: [{ n: 1, at: holidays.locator('text=Stock-taking').first(), where: 'left' }],
    notes: ['Listed; the working calendar was rebuilt and the plan re-ran'],
  })
  return {
    steps: ['Under Holidays, press Add a holiday.', 'Enter the date and what it is (here 11 November, stock-taking), and press Add holiday.'],
    images: [before, during, after],
    changed: 'The day closed. Every working-day count in the system was renumbered, so a job due 20 working days before stuffing now starts a day earlier if the holiday falls inside its window. Sundays are already closed and are not listed.',
    why: 'D-minus is counted in working days. A holiday is not a note on a calendar; it moves every date that counts across it.',
  }
})

await action('masters-article', 'Masters', 'Add an article, and take it to schedulable', async () => {
  await go('#/masters', 'text=Production route')
  const table = page.locator('[data-testid="articles-master"]')
  const add = page.locator('button:has-text("Add an article")')
  const before = await shot('masters-article', 'before', {
    around: [title('Articles'), add],
    maxHeight: 600,
    marks: [{ n: 1, at: add, where: 'right', ring: true }],
    notes: ['Add an article'],
  })
  const countBefore = await table.locator('tbody tr').count()
  await add.click()
  await modal().waitFor()
  await modal().getByPlaceholder('UD354 SPPL WAL').fill('DEMO-1')
  await modal().getByPlaceholder('Betsy Chair — Specter Pearl').fill('Bergen Chair')
  await modal().getByPlaceholder('Dining').fill('Dining')
  const dialog = await shot('masters-article', 'dialog', {
    around: [modal()],
    marks: [
      { n: 1, at: modal().getByPlaceholder('UD354 SPPL WAL'), where: 'inside-right' },
      { n: 2, at: modal().locator('button:has-text("Add article")'), where: 'right', ring: true },
    ],
    notes: ['Code, name and category', 'Add article'],
  })
  await modal().locator('button:has-text("Add article")').click()
  await until('the article to appear', (n) => document.querySelectorAll('[data-testid="articles-master"] tbody tr').length === n, countBefore + 1)
  await settle()
  const row = page.locator('[data-testid="article-DEMO-1"]')
  const noRoute = await shot('masters-article', 'no-route', {
    around: [title('Articles'), row],
    maxHeight: 700,
    marks: [{ n: 1, at: row, where: 'inside', dx: -40, dy: 4 }],
    notes: ['The new article: no route, so it cannot be planned, and it says so'],
  })
  // a rate, then a day-count
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await resetCapacitySheet()
  await page.fill('input[placeholder="Code or name"]', 'DEMO-1')
  await settle(400)
  const cell = page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('td').nth(1).locator('button').first()
  await cell.click()
  await editor().fill('25')
  await editor().press('Enter')
  await page.waitForSelector('button:has-text("25")', { timeout: 60_000 })
  await go('#/masters', 'text=Production route')
  await until('the missing day-count to be reported', () => {
    const r = document.querySelector('[data-testid="article-DEMO-1"]')
    return r?.getAttribute('data-routed') === '1' && r?.getAttribute('data-missing-dminus') === '1'
  })
  await settle()
  const noDays = await shot('masters-article', 'no-dminus', {
    around: [title('Articles'), row],
    maxHeight: 700,
    marks: [{ n: 1, at: row, where: 'inside', dx: -40, dy: 4 }],
    notes: ['Routed through one department, but no day-count yet: still not schedulable'],
  })
  await go('#/capacity', '[data-testid="capacity-grid"]')
  await page.fill('input[placeholder="Code or name"]', 'DEMO-1')
  await page.click('button:text-is("D-minus")')
  await settle(400)
  const dcell = page.locator('[data-testid="capacity-grid"] tbody tr').first().locator('td').nth(1).locator('button').first()
  await dcell.click()
  await editor().fill('45')
  await editor().press('Enter')
  await settle(1500)
  await go('#/masters', 'text=Production route')
  await until('the article to become schedulable', () => document.querySelector('[data-testid="article-DEMO-1"]')?.getAttribute('data-can-schedule') === 'yes')
  await settle()
  const ready = await shot('masters-article', 'ready', {
    around: [title('Articles'), row],
    maxHeight: 700,
    marks: [{ n: 1, at: row, where: 'inside', dx: -40, dy: 4 }],
    notes: ['Rate and day-count both in: it can be planned'],
  })
  return {
    steps: ['Under Articles, press Add an article and fill in code, name and category.', 'On the Capacity sheet, give it a rate in one department.', 'Switch to D-minus and give it a day-count in the same department.'],
    images: [before, dialog, noRoute, noDays, ready],
    changed: 'The article went through three honest states: "no route" (nowhere to be made), "D-minus missing" (routed, but nobody has said when the step must finish), and schedulable. It was never quietly planned on a zero.',
    why: 'Every refusal here is deliberate. An article that scheduled with a missing figure would produce a plan that looks normal and is wrong, which is the worst outcome available.',
  }
})

await action('masters-downtime', 'Masters', 'Book a machine down', async () => {
  await go('#/masters', 'text=Machines')
  await settle(500)
  const short = page.locator('[data-testid="machines-short-STITCH"]')
  const book = page.locator('[data-testid="book-downtime"]')
  const availableBefore = await short.getAttribute('data-available')
  const machines = await short.getAttribute('data-machines')
  const before = await shot('masters-downtime', 'before', {
    around: [page.locator('[data-testid="machines-down-today"]'), book],
    maxHeight: 700,
    marks: [
      { n: 1, at: short, where: 'left' },
      { n: 2, at: book, where: 'right', ring: true },
    ],
    notes: [`Stitching: ${availableBefore} of ${machines} machines running`, 'Book downtime'],
  })
  await book.click()
  await modal().waitFor()
  await modal().locator('select').first().selectOption('STITCH-05')
  await modal().getByPlaceholder('Hook timing gone — spares ordered').fill('Needle bar seized')
  const dialog = await shot('masters-downtime', 'dialog', {
    around: [modal()],
    marks: [
      { n: 1, at: modal().locator('select').first(), where: 'inside-right', dx: -30 },
      { n: 2, at: modal().getByPlaceholder('Hook timing gone — spares ordered'), where: 'inside-right' },
      { n: 3, at: modal().locator('button:has-text("Book it")'), where: 'right', ring: true },
    ],
    notes: ['The machine', 'Why, and from when to when', 'Book it'],
  })
  await modal().locator('button:has-text("Book it")').click()
  await until('stitching to report one fewer machine', (n) => document.querySelector('[data-testid="machines-short-STITCH"]')?.getAttribute('data-available') === String(n), Number(availableBefore) - 1)
  await settle()
  const after = await shot('masters-downtime', 'after', {
    around: [page.locator('[data-testid="machines-down-today"]'), page.locator('[data-testid="machine-STITCH-05"]')],
    maxHeight: 900,
    marks: [
      { n: 1, at: short, where: 'left' },
      { n: 2, at: page.locator('[data-testid="machine-STITCH-05"]'), where: 'inside', dx: -40, dy: 4 },
    ],
    notes: [`Stitching: ${Number(availableBefore) - 1} of ${machines}`, 'The machine, marked down on its own row'],
  })
  return {
    steps: ['Under Machines, press Book downtime.', 'Choose the machine, say why and for how long, and press Book it.'],
    images: [before, dialog, after],
    changed: `Stitching went from ${availableBefore} of ${machines} machines to ${Number(availableBefore) - 1} of ${machines}, and the department’s capacity on those days fell in proportion when the plan re-ran.`,
    why: 'A machine going down is not a note. It moves capacity, and the plan should know before the day is missed.',
  }
})

await action('masters-file', 'Masters', 'Save the masters to a file, and load them back', async () => {
  await go('#/masters', 'text=Production route')
  const save = page.locator('button:has-text("Save masters to a file")')
  const load = page.locator('button:has-text("Load from a file")')
  const everything = page.locator('[data-testid="backup-everything"]')
  const before = await shot('masters-file', 'before', {
    around: [save, title('Production route')],
    maxHeight: 400,
    marks: [
      { n: 1, at: save, where: 'below' },
      { n: 2, at: load, where: 'below' },
      { n: 3, at: everything, where: 'below' },
    ],
    notes: ['Save masters to a file: route, shifts, rates, day-counts, holidays, bills of materials', 'Load from a file: merges by code, never wipes', 'Save everything to a file: the masters plus the order book and every production entry'],
  })
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()])
  const saved = `${outDir}/kram-masters.json`
  await download.saveAs(saved)
  await page.setInputFiles('[data-testid="masters-import"]', saved)
  await page.waitForSelector('text=/\\d+ rows applied/', { timeout: 60_000 })
  await settle()
  const note = page.locator('text=/\\d+ rows applied/').first()
  const applied = (await note.innerText()).trim()
  const after = await shot('masters-file', 'after', {
    around: [save, note],
    maxHeight: 400,
    marks: [{ n: 1, at: note, where: 'left' }],
    notes: ['The file loaded back: every row applied, by code'],
  })
  await rm(saved, { force: true })
  return {
    steps: ['Press Save masters to a file. A file downloads.', 'Press Load from a file and choose it.'],
    images: [before, after],
    changed: `The file came back and the screen reported "${applied}". Loading merges by code and never wipes what is already there, so a partly filled file is safe to apply.`,
    why: 'This is how real figures move between systems and the door PPC’s workbook goes through. "Save everything" is the copy U&M control; it is held, not loaded back casually, because replaying production entries is how a factory gets a day it made twice.',
  }
})

// =============================================================================
// FLOOR DISPLAY
// =============================================================================
await action('display-pick', 'Floor display', 'Point the wall screen at a department', async () => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${baseUrl}/#/display`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="floor-display"]', { timeout: 60_000 })
  await settle()
  const select = page.locator('[data-testid="display-department"]')
  const wasCode = await select.inputValue()
  const beforeFile = 'display-pick-before.png'
  await mark([{ n: 1, at: select, where: 'right' }])
  await page.screenshot({ path: `${outDir}/${beforeFile}` })
  await unmark(page)
  await select.selectOption('STITCH')
  await settle(800)
  const afterFile = 'display-pick-after.png'
  await mark([{ n: 1, at: page.locator('[data-testid="floor-display"] h1, [data-testid="floor-display"] [class*="display"]').first(), where: 'right' }])
  await page.screenshot({ path: `${outDir}/${afterFile}` })
  await unmark(page)
  await page.setViewportSize({ width: WIDTH, height: 900 })
  return {
    steps: ['Open the display address on the television’s browser.', 'Choose the department in the small list at the bottom. It is remembered after a power cut.'],
    images: [
      { file: beforeFile, label: 'before', notes: [`Showing ${wasCode}; the list at the bottom`] },
      { file: afterFile, label: 'after', notes: ['Stitching’s day, full screen, refreshing every minute'] },
    ],
    changed: 'The screen switched to Stitching: what is due today or overdue, what it is waiting on, who is in, and machines running. No menu, no chrome.',
    why: 'A wall display is not an application window. Nobody ten feet away reads a navigation bar, and nobody should have to touch it after a power cut.',
  }
})

await browser.close()
stopServer()

const sheetFree = manifest.filter((m) => !m.failed).length
await writeFile(`${outDir}/manifest.json`, JSON.stringify({ takenAt: new Date().toISOString(), actions: manifest }, null, 1))
const html = clickGuidePage({ takenAt: new Date().toISOString(), actions: manifest })
await writeFile(`${repoRoot}docs/click-guide.html`, html)
console.log(`\n${sheetFree} of ${manifest.length} actions photographed; wrote docs/click-guide.html`)
const failed = manifest.filter((m) => m.failed)
if (failed.length) {
  console.log('Not taken:')
  for (const f of failed) console.log(`  ${f.id}: ${f.failed}`)
  process.exitCode = 1
}
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 160)}`)
}
