/**
 * Writes the illustrated walkthrough of the sample (DBBS/UM/KRAM/09): numbered
 * screenshots of the hosted system, and the page that explains them.
 *
 *   node scripts/make-walkthrough.mjs <email> <password> [baseUrl]
 *   node scripts/make-pdf.mjs docs/sample-walkthrough.html
 *
 * ---------------------------------------------------------------------------
 * Why the pictures and the words come out of one script.
 *
 * A guide with screenshots goes stale in the most visible way there is: the
 * reader holds a picture that says 18 beside a screen that says 21. The
 * demonstration script (KRAM/07) is regenerated from the live project for that
 * reason, and this goes one further — every figure quoted in the text is read
 * off the same page, in the same visit, as the screenshot beside it. They
 * cannot disagree, and the moment of capture is stamped at the top.
 *
 * ---------------------------------------------------------------------------
 * A screenshot has to be of a screen that has finished loading.
 *
 * `verify-hosted-ui` photographs each screen as soon as its heading appears,
 * which is right for a check that only asks whether the screen rendered and
 * wrong for a picture somebody will be shown: on 4 Oct its Command centre
 * image read "No run yet" above four empty tiles, taken a moment before the
 * figures arrived. Every stop here waits on the data itself — a count that is
 * not a dash, a state attribute, a row that exists.
 *
 * ---------------------------------------------------------------------------
 * What it does to the hosted project.
 *
 * It reads, with two exceptions that are what a planner would do in the first
 * five minutes and that leave the live plan alone:
 *
 * - **One acceptance check.** `check_order_acceptance` plans a hypothetical
 *   line and rolls it away; it leaves no trace.
 * - **One what-if scenario.** This *does* leave something: a row in the Runs
 *   list, marked as a scenario, never the live plan. Pass `--no-scenario` to
 *   skip it and reuse the last one's picture.
 *
 * It adds no order, declares no production and edits no master.
 *
 * ---------------------------------------------------------------------------
 * The pictures are not committed.
 *
 * `docs/walkthrough/` is ignored, as `docs/*.pdf` and `screenshots/` are: they
 * are renderings, and the script is the source. `make-pdf.mjs` inlines them
 * when it builds the PDF, so the PDF is self-contained and the HTML is not.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { walkthroughPage } from './lib/walkthrough-page.mjs'
import { box as boxIn, mark as markIn } from './lib/marks.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [email, password, baseArg] = args.filter((a) => !a.startsWith('--'))
const baseUrl = baseArg ?? 'http://localhost:5173'
const outDir = `${repoRoot}docs/walkthrough`
const factsFile = `${outDir}/facts.json`
const only = [...flags].find((f) => f.startsWith('--only='))?.slice(7).split(',')

if (!email || !password) {
  console.error(
    'Usage: make-walkthrough.mjs <email> <password> [baseUrl] [--no-scenario] [--only=a,b]',
  )
  process.exit(1)
}
await mkdir(outDir, { recursive: true })

// --- the server, started if nobody else has ---------------------------------
async function alive(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok
  } catch {
    return false
  }
}
let server = null
if (!(await alive(baseUrl))) {
  if (baseArg) {
    console.error(`Nothing is answering on ${baseUrl}.`)
    process.exit(1)
  }
  console.log('Starting the hosted dev server…')
  server = spawn('npx', ['vite', '--mode', 'hosted', '--port', '5173'], { stdio: 'ignore' })
  const by = Date.now() + 60_000
  while (!(await alive(baseUrl))) {
    if (Date.now() > by) {
      server.kill()
      console.error('The dev server never came up. Run `npm run dev:hosted` to see why.')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}
const stopServer = () => server && !server.killed && server.kill()

// --- the browser -------------------------------------------------------------
/*
 * 1180 wide, not the 1440 the checks use. The picture is printed 186 mm across;
 * at 1440 the screen's 14px text comes out near five points, which is a
 * screenshot nobody can read without zooming. 1180 keeps the desktop layout —
 * two panels side by side — and prints the same text a third larger.
 */
const WIDTH = 1180
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: 1.5,
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const settle = async (ms = 900) => {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}
const go = async (hash, waitFor) => {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(waitFor, { timeout: 90_000 })
  await settle()
}

const box = (locator) => boxIn(page, locator)
const mark = (targets) => markIn(page, targets)

const shots = {}
/** A clip of the page between two heights, full width. */
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

const bottomOf = async (locator, pad = 14) => {
  const b = await box(locator)
  return b.y + b.height + pad
}
const topOf = async (locator, pad = 14) => (await box(locator)).y - pad
const wants = (name) => !only || only.includes(name)

// What was read off the screens. Kept between runs so `--only` and
// `--no-scenario` can rebuild the page without redoing the slow stops.
const facts = JSON.parse(await readFile(factsFile, 'utf8').catch(() => '{}'))

// --- sign in -----------------------------------------------------------------
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=Sign in', { timeout: 60_000 })
if (wants('login')) {
  await mark([
    { n: 1, at: page.locator('input[type=email]') },
    { n: 2, at: page.locator('input[type=password]') },
    { n: 3, at: page.locator('button:has-text("Sign in")') },
  ])
  // The card and its heading, not the full width: the form is a third of the
  // page and would print the size of a stamp.
  const card = await box(page.locator('form'))
  const clip = {
    x: Math.round(card.x - 110),
    y: Math.round(Math.max(0, card.y - 150)),
    width: Math.round(card.width + 220),
    height: Math.round(card.height + 230),
  }
  await page.screenshot({ path: `${outDir}/login.png`, fullPage: true, clip })
  shots.login = { width: clip.width, height: clip.height }
  console.log(`  login.png — ${clip.width}×${clip.height}`)
}
await page.fill('input[type=email]', email)
await page.fill('input[type=password]', password)
await page.click('button:has-text("Sign in")')
await page.waitForSelector('text=Bottleneck utilisation', { timeout: 60_000 })

/** A panel's title is a <b> in its dark bar; there is no heading element. */
const title = (t) => page.locator(`section > header > b:text-is("${t}")`)
const titleHas = (t) => page.locator('section > header > b', { hasText: t })
// `has` is matched relative to each candidate, so the inner locator must not
// start from `section` again — that would look for a panel inside a panel.
const panelWith = (t) =>
  page.locator('section').filter({ has: page.locator('header > b', { hasText: t }) }).last()

// --- 1 · command centre ------------------------------------------------------
if (wants('command-centre')) {
  console.log('command centre')
  await go('', 'text=Bottleneck utilisation')
  // The figures, not the frame: the tiles show a dash until the run arrives.
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('main')?.innerText.match(/Scheduled tasks\s*\n\s*(\S+)/i)?.[1] ?? ''),
    null,
    { timeout: 90_000 },
  )
  await page.waitForSelector('text=Constraint', { timeout: 90_000 })
  await settle(600)

  const text = await page.locator('main').innerText()
  const read = (label) => Number(text.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'))?.[1].replace(/,/g, ''))
  facts.lines = read('Shipment lines')
  facts.tasks = read('Scheduled tasks')
  facts.breaches = read('Breaches')
  facts.flaggedDays = read('Flagged days')
  facts.constraint = (await page.locator('tr:has-text("Constraint") td').first().innerText())
    .replace(/constraint/i, '')
    .trim()

  await mark([
    { n: 1, at: page.locator('[data-testid="provisional-banner"]'), where: 'inside-right', dx: -14 },
    { n: 2, at: page.locator('nav a:has-text("Users")'), where: 'right' },
    { n: 3, at: page.locator('button:has-text("Run the schedule")'), where: 'right', ring: true },
    { n: 4, at: page.locator('.label:text-is("Breaches")'), where: 'right' },
    { n: 5, at: page.locator('tr:has-text("Constraint") >> text=/^Constraint$/i'), where: 'right' },
    { n: 6, at: page.locator('text=Sorted by how much time is left'), where: 'top-left', dx: -18, dy: 10 },
  ])
  const rows = page.locator('tr:has-text("Constraint") ~ tr')
  await shot('command-centre', 0, await bottomOf(rows.nth(2), 6))
}

// --- 2 · attention -----------------------------------------------------------
if (wants('attention')) {
  console.log('attention')
  await go('#/attention', '[data-testid="attention-critical"][data-state="ready"]')
  facts.critical = Number(
    await page.locator('[data-testid="attention-critical"]').getAttribute('data-count'),
  )
  facts.warnings = Number(
    await page.locator('[data-testid="attention-warning"]').getAttribute('data-count'),
  )
  const findings = page.locator('[data-testid^="finding-"]')
  const conflict = page.locator('[data-testid="finding-route-conflict"]')
  const hasConflict = (await conflict.count()) > 0
  facts.sameDay = await conflict.count()
  // The first card's own sentence, so the guide quotes what the picture shows.
  facts.firstFinding = (await findings.first().locator('p, div, span, b, strong').first().innerText())
    .split('\n')[0]
    .trim()
  await mark([
    { n: 1, at: page.locator('[data-testid="attention-badge"]'), where: 'left', ring: true },
    { n: 2, at: findings.first(), where: 'inside', dx: -40, dy: 0 },
    { n: 3, at: page.locator('text=Go to the screen that fixes this').first(), where: 'right' },
    ...(hasConflict ? [{ n: 4, at: conflict.first(), where: 'inside', dx: -40, dy: 0 }] : []),
  ])
  const header = await box(page.locator('header.gridpaper'))
  const last = hasConflict ? conflict.first() : findings.nth(3)
  await shot('attention', header.y - 8, await bottomOf(last, 10))
}

// --- 3 · schedule ------------------------------------------------------------
if (wants('schedule')) {
  console.log('schedule')
  await go('#/gantt', '[data-testid="gantt-order"]')
  // Orders open collapsed: one strip each. Open the first for its bars —
  // unless it is already open, since the toggle would then close it.
  const groups = page.locator('[data-testid="gantt-order"]')
  if ((await groups.first().getAttribute('data-expanded')) !== 'yes') {
    await groups.first().locator('button').first().click()
  }
  await page.waitForSelector('[data-testid="gantt-bar"]', { timeout: 30_000 })
  await settle(400)
  const bars = page.locator('[data-testid="gantt-bar"]')
  const heading = groups.first().locator('span.font-semibold').first()
  facts.scheduleOrder = (await heading.innerText()).trim().replace(/\s+line \d+$/, '')
  const label = page.locator('text=/^Runway$/i').first()
  // The department labels down the left are plain text; the fifth row of the
  // first order is Sanding, the first production step the sample cannot fit.
  await mark([
    { n: 1, at: heading, where: 'left', dx: 0 },
    { n: 2, at: bars.nth(0), where: 'right' },
    { n: 3, at: bars.nth(4), where: 'left', ring: true },
    { n: 4, at: label, where: 'left' },
    { n: 5, at: page.locator('label:has-text("Breaches only")'), where: 'right' },
  ])
  const top = await topOf(title('Schedule'), 30)
  await shot('schedule', top, (await box(groups.nth(1))).y - 12)
}

// --- 4 · heatmap -------------------------------------------------------------
if (wants('heatmap')) {
  console.log('heatmap')
  await go('#/heatmap', '[data-testid="heatmap-grid"]')
  const grid = page.locator('[data-testid="heatmap-grid"]')
  facts.heatDepartments = Number(await grid.getAttribute('data-departments'))
  facts.heatDays = Number(await grid.getAttribute('data-days'))
  facts.heatOver = Number(await grid.getAttribute('data-over'))

  // The fullest day Sanding has: the cell that makes the point of the screen.
  // Read from the cell's data attributes, not its hover text — the text is
  // for people and changed wording on 9 Oct, which broke this capture.
  const worst = await page.evaluate(() => {
    let best = null
    for (const b of document.querySelectorAll('[data-testid="heatmap-grid"] button[data-department="SAND"][data-utilisation]')) {
      const value = Number(b.getAttribute('data-utilisation'))
      if (!best || value > best.value) best = { date: b.getAttribute('data-date'), value, title: b.title }
    }
    return best
  })
  if (!worst) throw new Error('no Sanding cell with a figure on the heatmap')
  facts.heatCell = worst
  const cell = page.locator(`[data-testid="heatmap-grid"] button[data-department="SAND"][data-date="${worst.date}"]`)
  await cell.click()
  // The detail panel is titled with the department's name since 9 Oct; the
  // cell's hover text carries that name before its first separator.
  const deptName = worst.title.split(' · ')[0]
  await titleHas(`${deptName} —`).first().waitFor({ timeout: 30_000 })
  await settle(500)
  const detail = titleHas(`${deptName} —`)
  facts.heatCellJobs = await panelWith(`${deptName} —`).locator('tbody tr').count()

  await mark([
    { n: 1, at: grid.locator('text=SAND').first(), where: 'left', dx: 2 },
    { n: 2, at: cell, where: 'above', ring: true },
    { n: 3, at: page.locator('text=/Over capacity · \\d+/').first(), where: 'below', dy: -2 },
    { n: 4, at: detail, where: 'left', dx: 0 },
  ])
  const top = await topOf(title('Load heatmap'), 30)
  await shot('heatmap', top, await bottomOf(panelWith(`${deptName} —`), 16))
}

// --- 5 · order book ----------------------------------------------------------
if (wants('order-book')) {
  console.log('order book')
  await go('#/orders', 'tbody tr:has-text("SAMPLE-")')
  facts.orders = await page.locator('tbody tr').count()
  facts.orderBreaches = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr')].map((r) => ({
      order: r.firstElementChild?.textContent?.trim(),
      breaches: Number(r.lastElementChild?.textContent?.replace(/\D/g, '') || 0),
    })),
  )
  const firstRow = page.locator('tbody tr').first()
  await mark([
    { n: 1, at: firstRow.locator('td').first(), where: 'left', dx: 2 },
    { n: 2, at: page.locator('th:has-text("First stuffing")'), where: 'above', dy: 4 },
    { n: 3, at: firstRow.locator('td').last(), where: 'left', dx: 44 },
    { n: 4, at: page.locator('button:has-text("Add an order")'), where: 'left', ring: true },
  ])
  const top = await topOf(title('Order book'), 30)
  await shot('order-book', top, await bottomOf(page.locator('tbody tr').last(), 60))
}

// --- 6 · accept an order -----------------------------------------------------
if (wants('acceptance')) {
  console.log('accept an order (this plans the factory once — about a minute)')
  await go('#/accept', 'text=Can we take this order?')
  await page.waitForFunction(() => document.querySelectorAll('select option').length > 5, null, {
    timeout: 60_000,
  })
  const ask = { sku: '125043138', qty: 150, date: '2026-12-15' }
  const value = await page.evaluate(
    (sku) => [...document.querySelectorAll('select option')].find((o) => o.textContent.startsWith(sku))?.value,
    ask.sku,
  )
  await page.selectOption('select', value)
  await page.fill('input[type=number]', String(ask.qty))
  await page.fill('input[type=date]', ask.date)
  await page.click('button:has-text("Check")')
  const verdict = page.locator('text=/steps cannot be made to this date|Every department can make this/')
  await verdict.first().waitFor({ timeout: 200_000 })
  await settle(500)
  facts.accept = {
    ...ask,
    name: (await page.locator('select option:checked').innerText()).replace(/^\S+\s+—\s+/, ''),
    verdict: (await verdict.first().innerText()).trim(),
    title: (await page.locator('section > header > b').nth(1).innerText()).trim(),
    failing: await page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')]
        .filter((r) => !/Clear/i.test(r.lastElementChild?.textContent ?? ''))
        .map((r) => r.firstElementChild?.textContent?.trim()),
    ),
  }
  const flagged = page.locator('tbody tr').filter({ hasNotText: /Clear/ })
  await mark([
    { n: 1, at: page.locator('select'), where: 'inside-right', dx: -34 },
    { n: 2, at: page.locator('button:has-text("Check")'), where: 'above', ring: true },
    { n: 3, at: verdict.first(), where: 'left', dx: -6 },
    ...((await flagged.count())
      ? [{ n: 4, at: flagged.first().locator('td').last().locator('text=/^Runway$/i'), where: 'right' }]
      : []),
  ])
  const top = await topOf(title('Can we take this order?'), 30)
  // Down to the first step that fails and two rows past it; the whole table is
  // twenty rows and the point is made by the fifth.
  const rows = page.locator('tbody tr')
  const firstBad = (await flagged.count())
    ? await page.evaluate(() =>
        [...document.querySelectorAll('tbody tr')].findIndex(
          (r) => !/Clear/i.test(r.lastElementChild?.textContent ?? ''),
        ),
      )
    : 4
  const until = Math.min((await rows.count()) - 1, Math.max(firstBad + 2, 6))
  await shot('acceptance', top, await bottomOf(rows.nth(until), 8))
}

// --- 7 · capacity sheet ------------------------------------------------------
if (wants('capacity-sheet')) {
  console.log('capacity sheet')
  await go('#/capacity', '[data-testid="capacity-grid"]')
  const main = await page.locator('main').innerText()
  facts.pairings = Number(main.match(/Department pairings\s*\n\s*([\d,]+)/i)?.[1].replace(/,/g, ''))
  facts.articles = Number(main.match(/Articles routed\s*\n\s*(\d+)/i)?.[1])
  facts.sheetConflicts = Number(main.match(/(\d+) to look at/i)?.[1] ?? 0)

  await page.click('button:text-is("D-minus")')
  await page.fill('input[placeholder="Code or name"]', '125043138')
  await settle(700)
  const grid = page.locator('[data-testid="capacity-grid"]')
  await mark([
    { n: 1, at: titleHas('A department is due before'), where: 'left', dx: 0 },
    { n: 2, at: page.locator('button:text-is("D-minus")'), where: 'above', ring: true },
    { n: 3, at: page.locator('input[placeholder="Code or name"]'), where: 'inside-right' },
    { n: 4, at: grid.locator('tbody tr').first().locator('th, td').first(), where: 'inside', dx: -38, dy: 2 },
  ])
  const top = await topOf(titleHas('A department is due before'), 30)
  await shot('capacity-sheet', top, await bottomOf(grid, 40))
}

// --- 8 · factory map ---------------------------------------------------------
if (wants('factory-map')) {
  console.log('factory map')
  // The map is ten columns across and scrolls sideways at any ordinary width.
  // Photographed once at a width that holds all of it, in two halves, so each
  // prints at a size the names can be read at.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await go('#/map', '[data-testid="map-node-MACHINE"]')
  // The page caps its own width at 1400; lifted for the photograph only, so
  // the drawing is whole rather than the first six columns of ten.
  await page.evaluate(() => {
    document.querySelector('main').style.maxWidth = 'none'
  })
  await settle(400)
  const map = await box(page.locator('[data-testid="factory-map"] svg'))
  facts.mapDepartments = await page.locator('[data-testid^="map-node-"]').count()
  await mark([
    { n: 1, at: page.locator('[data-testid="map-node-MACHINE"]'), where: 'top-left' },
    { n: 2, at: page.locator('[data-testid="map-node-WOODQC"]'), where: 'top-left' },
    { n: 3, at: page.locator('[data-testid="map-node-STAPLE"]'), where: 'top-left' },
    { n: 4, at: page.locator('[data-testid="map-node-EXFACT"]'), where: 'top-left' },
  ])
  // Cut between two columns rather than down the middle of a box, and trim
  // each half to the rows it actually uses — the end of the line is one box
  // deep and would otherwise print as a mostly empty frame.
  const nodes = await page.locator('[data-testid^="map-node-"]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }
    }),
  )
  const columns = [...new Set(nodes.map((n) => Math.round(n.x)))].sort((p, q) => p - q)
  const cut = columns[Math.ceil(columns.length / 2)]
  const halves = [
    { name: 'factory-map-1', from: map.x - 10, to: cut - 14, has: (n) => n.x < cut - 1 },
    { name: 'factory-map-2', from: cut - 40, to: map.x + map.width + 10, has: (n) => n.x >= cut - 1 },
  ]
  for (const h of halves) {
    const mine = nodes.filter(h.has)
    const top = Math.max(map.y - 10, Math.min(...mine.map((n) => n.y)) - 34)
    const bottom = Math.min(map.y + map.height + 10, Math.max(...mine.map((n) => n.y + n.h)) + 34)
    const clip = {
      x: Math.round(h.from),
      y: Math.round(top),
      width: Math.round(h.to - h.from),
      height: Math.round(bottom - top),
    }
    await page.screenshot({ path: `${outDir}/${h.name}.png`, fullPage: true, clip })
    shots[h.name] = { width: clip.width, height: clip.height }
    console.log(`  ${h.name}.png — ${clip.width}×${clip.height}`)
  }
  await page.setViewportSize({ width: WIDTH, height: 900 })
}

// --- 9 · what if -------------------------------------------------------------
if (wants('what-if')) {
  await go('#/whatif', 'text=Try a change')
  const note = 'Sanding with a second shift'
  await page.fill('input[placeholder^="Second shift"]', note)
  await page.selectOption('select', 'SAND')
  await page.click('button:text-is("Second shift")')
  if (flags.has('--no-scenario')) {
    // Reopen the last scenario of this name instead of planning another: the
    // comparison is the same picture, and the Runs list does not grow.
    console.log('what if (reopening the last scenario)')
    const earlier = page.locator('tr', { hasText: note }).first()
    if (!(await earlier.count())) {
      throw new Error('No earlier scenario to reopen — run once without --no-scenario.')
    }
    await earlier.locator('text=Compare').click()
  } else {
    console.log('what if (one scenario — about a minute, and it stays in the Runs list)')
    await page.click('button:has-text("Run it")')
  }
  await title('What changed').waitFor({ timeout: 200_000 })
  await settle(700)

  const main = await page.locator('main').innerText()
  const tile = (label) => Number(main.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'))?.[1].replace(/,/g, ''))
  const scenario = panelWith(note)
  const row = scenario.locator('tbody tr', { has: page.locator('td:text-is("SAND")') }).first()
  const cells = await row.locator('td').allInnerTexts()
  facts.whatIf = {
    note,
    department: 'Sanding',
    code: 'SAND',
    breachesNow: tile('Breaches now'),
    breachesThen: tile('Breaches in this scenario'),
    flaggedNow: tile('Flagged days now'),
    flaggedThen: tile('Flagged days in this scenario'),
    deptBreachesNow: Number(cells.at(-2)),
    deptBreachesThen: Number(cells.at(-1)),
    rows: await scenario.locator('tbody tr').evaluateAll((all) =>
      all.map((r) => {
        const c = [...r.children].map((x) => x.textContent.trim())
        return { code: c[0], now: Number(c.at(-2)), then: Number(c.at(-1)) }
      }),
    ),
    tasksChanged: await panelWith('What changed').locator('tbody tr').count(),
  }
  await mark([
    { n: 1, at: page.locator('input[placeholder^="Second shift"]'), where: 'inside-right' },
    { n: 2, at: page.locator('select').first(), where: 'inside-right', dx: -30 },
    { n: 3, at: page.locator('button:text-is("Second shift")'), where: 'below', ring: true, dy: 2 },
    { n: 4, at: page.locator('button:has-text("Run it")'), where: 'above', dy: 2 },
    { n: 5, at: page.locator('.label:text-is("Breaches in this scenario")'), where: 'right' },
    { n: 6, at: row.locator('td').first(), where: 'left', dx: 2 },
  ])
  const top = await topOf(title('Try a change'), 30)
  // Down to Sanding's own row and two past it: the tiles and that one line are
  // the answer, and the other seventeen rows say "no change".
  const rows = scenario.locator('tbody tr')
  const at = await rows.evaluateAll((all) => all.findIndex((r) => r.firstElementChild?.textContent?.trim() === 'SAND'))
  await shot('what-if', top, await bottomOf(rows.nth(Math.min(at + 2, (await rows.count()) - 1)), 8))
}

await browser.close()
stopServer()

facts.generatedAt = new Date().toISOString()
facts.shots = { ...(facts.shots ?? {}), ...shots }
await writeFile(factsFile, JSON.stringify(facts, null, 1))

const sheet = JSON.parse(await readFile(`${repoRoot}scripts/data/um-sample-sheet.json`, 'utf8'))
const out = `${repoRoot}docs/sample-walkthrough.html`
await writeFile(out, walkthroughPage({ facts, sheet, site: 'kraam.netlify.app' }))
console.log(`\nWrote docs/sample-walkthrough.html and ${Object.keys(facts.shots).length} pictures.`)

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s) while capturing:`)
  for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  process.exit(1)
}
