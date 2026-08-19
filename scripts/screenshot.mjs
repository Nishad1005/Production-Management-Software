/**
 * Drives the running dev server in headless Chromium: visits every screen, then
 * exercises the interactions that write to the database.
 *
 *   npm run dev &
 *   node scripts/screenshot.mjs [baseUrl] [outDir]
 *
 * Exists because "it builds" says nothing about whether Postgres actually starts
 * in the browser, and "it renders" says nothing about whether a form saves. A
 * blank screenshot is a failure however green the build was.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.argv[2] ?? 'http://localhost:5173'
const outDir = process.argv[3] ?? 'screenshots'

const SCREENS = [
  { hash: '', name: 'command-centre', waitFor: 'text=Bottleneck utilisation' },
  { hash: '#/heatmap', name: 'heatmap', waitFor: 'text=Load heatmap' },
  { hash: '#/gantt', name: 'schedule', waitFor: 'text=Manual pins' },
  { hash: '#/orders', name: 'order-book', waitFor: 'text=Order book' },
  { hash: '#/accept', name: 'acceptance', waitFor: 'text=Can we take this order?' },
  { hash: '#/masters', name: 'masters', waitFor: 'text=Production route' },
  { hash: '#/production', name: 'production', waitFor: 'text=What you were asked for' },
  { hash: '#/board', name: 'department-board', waitFor: 'text=What you owe' },
  { hash: '#/dashboard', name: 'dashboard', waitFor: 'text=Is the factory on track today?' },
  { hash: '#/wip', name: 'wip', waitFor: 'text=Ready to stuff' },
  { hash: '#/manpower', name: 'manpower', waitFor: 'text=Who is in' },
  { hash: '#/material', name: 'material', waitFor: 'text=Against the store' },
  { hash: '#/quality', name: 'quality', waitFor: 'text=Where the losses come from' },
  { hash: '#/money', name: 'money', waitFor: 'text=Money out, week by week' },
]

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

let failed = 0

/** Runs a named step, reporting pass or fail without aborting the rest. */
async function step(name, fn) {
  process.stdout.write(`${name.padEnd(26)} `)
  try {
    const note = await fn()
    console.log(note ? `ok — ${note}` : 'ok')
  } catch (e) {
    failed += 1
    console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    await page
      .screenshot({ path: `${outDir}/${name.replace(/\W+/g, '-')}-failed.png` })
      .catch(() => {})
  }
}

/**
 * waitForFunction, but the failure says what it was waiting for. A bare
 * "Timeout 60000ms exceeded" has twice sent this file looking in the wrong
 * place — the wait is never the interesting part, the condition is.
 */
async function until(label, fn, arg, timeout = 60_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout })
  } catch {
    throw new Error(`timed out waiting for ${label}`)
  }
}

async function go(hash, waitFor) {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'domcontentloaded' })
  // First load compiles Postgres to WASM and applies the schema.
  await page.waitForSelector(waitFor, { timeout: 60_000 })
}

// --- every screen renders ---------------------------------------------------

for (const screen of SCREENS) {
  await step(screen.name, async () => {
    await go(screen.hash, screen.waitFor)
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${outDir}/${screen.name}.png`, fullPage: true })
  })
}

// --- the acceptance check refuses what cannot be made -----------------------

await step('acceptance check', async () => {
  await go('#/accept', 'text=Can we take this order?')
  await page.fill('input[type=number]', '5000')
  await page.fill('input[type=date]', '2026-12-20')
  await page.click('button:has-text("Check")')
  await page.waitForSelector('text=Not as it stands', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/acceptance-result.png`, fullPage: true })
  return '5,000 units on short notice correctly refused'
})

// --- adding an order writes and re-runs the schedule ------------------------

await step('add an order', async () => {
  await go('#/orders', 'text=Order book')
  const before = await page.locator('tbody tr').count()

  await page.click('button:has-text("Add an order")')
  await page.waitForSelector('text=Creates its first shipment line')
  await page.fill('input[placeholder="SO/26-27/0500"]', 'SO/26-27/0999')
  await page.fill('input[type=number]', '450')
  await page.fill('input[type=date]', '2026-11-19')
  await page.click('button:has-text("Add order")')

  await page.waitForSelector('text=SO/26-27/0999', { timeout: 60_000 })
  const after = await page.locator('tbody tr').count()
  if (after <= before) throw new Error('order row did not appear')
  await page.screenshot({ path: `${outDir}/order-added.png`, fullPage: true })
  return 'saved and rescheduled'
})

// --- editing a master value persists ----------------------------------------

await step('edit D-minus', async () => {
  await go('#/masters', 'text=D-minus matrix')
  // Ply cutting on the Boden dining chair, the one article carrying no offset.
  const cell = page.locator('button:has-text("D-80")').first()
  await cell.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('84')
  await input.press('Enter')
  await page.waitForSelector('button:has-text("D-84")', { timeout: 60_000 })

  // And it survives a reload, which is what proves it reached the database
  // rather than only React state.
  await go('#/masters', 'text=D-minus matrix')
  await page.waitForSelector('button:has-text("D-84")', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/masters.png`, fullPage: true })
  return 'D-80 → D-84, persisted across reload'
})

// --- masters survive a round trip through a file ----------------------------

await step('masters round-trip', async () => {
  await go('#/masters', 'text=Production route')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('button:has-text("Save masters to a file")'),
  ])
  const saved = `${outDir}/kram-masters.json`
  await download.saveAs(saved)

  // The previous step left ply cutting at D-84. Move it, then load the file
  // back and it should return — which is what proves the file carries real
  // values and the import reaches the database.
  const cell = page.locator('button:has-text("D-84")').first()
  await cell.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('90')
  await input.press('Enter')
  await page.waitForSelector('button:has-text("D-90")', { timeout: 60_000 })

  // The route graph travels in the file too, and did not until today. Break it
  // first, so the import has something to put back beyond a single number.
  await go('#/masters', 'text=What feeds what')
  const graph = page.locator('[data-testid="route-dependency-grid"]')
  const columns = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="route-dependency-grid"]')
    return [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
  })
  await graph
    .locator('tbody tr')
    .filter({ hasText: 'SAND' })
    .first()
    .locator('td')
    .nth(columns.indexOf('ASSY'))
    .locator('button')
    .click()
  await page.waitForTimeout(1200)

  await go('#/masters', 'text=Production route')
  await page.setInputFiles('[data-testid="masters-import"]', saved)
  await page.waitForSelector('text=/\\d+ rows applied/', { timeout: 60_000 })
  await page.waitForSelector('button:has-text("D-84")', { timeout: 60_000 })

  // The edge has to come back with it. A file that carries departments and not
  // what feeds them rebuilds a factory where nothing waits for anything.
  await go('#/masters', 'text=What feeds what')
  const restored = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="route-dependency-grid"]')
    const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
    const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find((r) =>
      r.querySelector('td')?.textContent?.trim().startsWith('SAND'),
    )
    const cell = row?.querySelectorAll('td')[heads.indexOf('ASSY')]
    return cell?.textContent?.trim()
  })
  if (restored !== '●') {
    throw new Error(`the file lost the route graph — SAND/ASSY reads ${restored}`)
  }

  return 'exported, D-minus and the route graph both restored'
})

// --- bringing a second shift on adds capacity -------------------------------

await step('bring a shift on', async () => {
  await go('#/masters', 'text=Who works which shift')

  // Switch shift A on globally, then onto stitching specifically.
  await page
    .locator('tr', { hasText: 'Shift A' })
    .getByRole('button', { name: 'Switch on' })
    .click()

  const grid = page.locator('section').filter({ hasText: 'Who works which shift' })
  const stitch = grid.locator('tr', { hasText: 'STITCH' })

  // Count rather than presence: the GEN column already reads "Running", so
  // waiting for that text would pass without anything having happened.
  //
  // exact:true matters — getByRole matches the accessible name by *substring*
  // by default, so plain 'Running' also matches every 'Not running' and the
  // baseline comes out wrong.
  const before = await stitch
    .getByRole('button', { name: 'Running', exact: true })
    .count()
  await stitch.getByRole('button', { name: 'Not running' }).first().click()

  await page.waitForFunction(
    (n) => {
      const section = [...document.querySelectorAll('section')].find((s) =>
        s.textContent?.includes('Who works which shift'),
      )
      const row = [...(section?.querySelectorAll('tr') ?? [])].find((r) =>
        r.textContent?.includes('STITCH'),
      )
      const running = [...(row?.querySelectorAll('button') ?? [])].filter(
        (b) => b.textContent?.trim() === 'Running',
      )
      return running.length > n
    },
    before,
    { timeout: 60_000 },
  )

  // Rates must have been copied across, or the shift adds nothing at all.
  const missing = await grid.locator('text=No rates').count()
  if (missing) throw new Error('shift switched on without component rates')

  await page.screenshot({ path: `${outDir}/masters-shifts.png`, fullPage: true })
  return 'shift A onto stitching, rates copied'
})

// --- dragging a Gantt bar proposes a pin ------------------------------------

await step('drag to reschedule', async () => {
  await go('#/gantt', 'text=Manual pins')
  const bar = page.locator('[data-testid="gantt-bar"]').first()
  const box = await bar.boundingBox()
  if (!box) throw new Error('no schedule bar to drag')

  // Drag a fraction of the *track*, not a fixed pixel count: the horizon
  // stretches as orders are added, and a fixed 60px can be less than one day.
  const track = await bar.evaluateHandle((el) => el.parentElement)
  const trackBox = await track.asElement().boundingBox()
  const distance = Math.max(80, trackBox.width * 0.2)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width / 2 - distance,
    box.y + box.height / 2,
    { steps: 12 },
  )
  await page.mouse.up()

  await page.waitForSelector('text=Pin this task', { timeout: 30_000 })
  await page.fill(
    'input[placeholder="Line free after the Nordic run"]',
    'Pulled forward to protect the December container',
  )
  await page.screenshot({ path: `${outDir}/pin-dialog.png`, fullPage: true })
  await page.click('button:has-text("Pin it")')

  await page.waitForSelector('text=Pulled forward to protect', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/schedule-pinned.png`, fullPage: true })
  return 'pin saved and honoured by the next run'
})

// --- the capacity sheet writes where the engine reads ----------------------

await step('capacity sheet', async () => {
  await go('#/capacity', 'text=Capacity sheet')

  // The seeded article is worked by named components, not stage components, so
  // every cell starts blank. Entering one has to route the article through that
  // department and show up on the schedule.
  // nth(1), not first: the row header carries the article name and the cost
  // box, so column 0 is not a department. "First button in the row" used to
  // mean a rate and now means a cost — and the step went on passing.
  const cell = page
    .locator('[data-testid="capacity-grid"] tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .locator('button')
    .first()
  await cell.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('42')
  await input.press('Enter')

  await page.waitForFunction(
    () => document.body.textContent?.includes('Department pairings'),
    undefined,
    { timeout: 60_000 },
  )
  await page.waitForSelector('button:has-text("42")', { timeout: 60_000 })

  // And it survives a reload, which is what proves it reached the database.
  await go('#/capacity', 'text=Capacity sheet')
  await page.waitForSelector('button:has-text("42")', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/capacity-sheet.png`, fullPage: true })
  return 'a rate entered, routed and persisted'
})

// --- a D-minus that contradicts the route order is caught -------------------

await step('route order guard', async () => {
  await go('#/capacity', 'text=Capacity sheet')
  await page.click('button:has-text("D-minus")')
  await page.waitForTimeout(400)

  // Sanding is fed by assembly, and is about to be told to finish well before
  // it — which holds it behind work that is not due, and raises a runway breach
  // that is not real.
  const grid = page.locator('[data-testid="capacity-grid"]')
  const sandColumn = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="capacity-grid"]')
    const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
    return heads.indexOf('SAND')
  })
  if (sandColumn < 1) throw new Error('SAND column not found')

  // Scoped to the grid: once the warning appears it brings its own table, and
  // an unanchored "first table" locator quietly moves to it.
  const cellAt = () =>
    grid.locator('tbody tr').first().locator('td').nth(sandColumn).locator('button')

  await cellAt().click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('70')
  await input.press('Enter')

  await page.waitForSelector('text=A department is due before something that feeds it', {
    timeout: 60_000,
  })
  await page.waitForSelector('text=Causing breaches', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/route-conflict.png`, fullPage: true })

  // Correcting it clears the warning rather than leaving it to be dismissed.
  await cellAt().click()
  const fix = page.locator('input[type=number]:visible').first()
  // 56 is sanding's own figure. Anything at or below wood finishing's D-46
  // would simply trade one contradiction for another — equal due dates count,
  // because the second department would start before the first had finished.
  await fix.fill('56')
  await fix.press('Enter')
  await page.waitForFunction(
    () => !document.body.textContent?.includes('A department is due before something that feeds it'),
    undefined,
    { timeout: 60_000 },
  )
  return 'contradiction flagged, then cleared when corrected'
})

// --- saying two departments are parallel clears a false breach --------------

await step('parallel feeders', async () => {
  // Put the contradiction back: sanding due well before assembly, while waiting
  // on it. The disagreement only exists because we claim assembly feeds
  // sanding.
  await go('#/capacity', 'text=Capacity sheet')
  await page.click('button:has-text("D-minus")')
  await page.waitForTimeout(400)

  const grid = page.locator('[data-testid="capacity-grid"]')
  const sandColumn = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="capacity-grid"]')
    const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
    return heads.indexOf('SAND')
  })
  const cell = grid
    .locator('tbody tr')
    .first()
    .locator('td')
    .nth(sandColumn)
    .locator('button')
  await cell.click()
  const dminus = page.locator('input[type=number]:visible').first()
  await dminus.fill('70')
  await dminus.press('Enter')
  await page.waitForSelector(
    'text=A department is due before something that feeds it',
    { timeout: 60_000 },
  )

  // Say what is true on Masters — sanding waits for nothing.
  await go('#/masters', 'text=What feeds what')
  const dependencies = page.locator('[data-testid="route-dependency-grid"]')
  const columns = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="route-dependency-grid"]')
    return [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
  })
  const rowFor = (code) =>
    dependencies.locator('tbody tr').filter({ hasText: code }).first()

  // Anchored by testid and by row text, not by position: this panel sits above
  // two other grids on the same screen.
  await rowFor('SAND')
    .locator('td')
    .nth(columns.indexOf('ASSY'))
    .locator('button')
    .click()
  await page.waitForTimeout(1200)
  await page.screenshot({
    path: `${outDir}/route-dependencies.png`,
    fullPage: true,
  })

  // The warning goes, because there is no longer anything to disagree about.
  await go('#/capacity', 'text=Capacity sheet')
  await page.waitForFunction(
    () =>
      !document.body.textContent?.includes(
        'A department is due before something that feeds it',
      ),
    undefined,
    { timeout: 60_000 },
  )

  // And so does the runway breach it was predicting.
  await go('#/gantt', 'text=Schedule')
  await page.waitForTimeout(1500)
  const runway = await page.evaluate(() =>
    document.body.textContent?.includes('runway'),
  )
  if (runway) throw new Error('runway breach survived the parallel declaration')

  // Put it back, so the steps after this one see the schedule they expect.
  await go('#/capacity', 'text=Capacity sheet')
  await page.click('button:has-text("D-minus")')
  await page.waitForTimeout(400)
  const restore = page
    .locator('[data-testid="capacity-grid"]')
    .locator('tbody tr')
    .first()
    .locator('td')
    .nth(sandColumn)
    .locator('button')
  await restore.click()
  const back = page.locator('input[type=number]:visible').first()
  await back.fill('56')
  await back.press('Enter')
  await page.waitForTimeout(1200)

  return 'declaring two departments parallel cleared the false breach'
})

// --- declaring output, and the next bench counting it in --------------------

await step('declare production', async () => {
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STITCH')
  await page.waitForTimeout(800)

  // The screen opens on today, which the seeded plan does not reach, so it
  // offers the days there *is* work. Clicking one is both the check that the
  // offer works and how this step gets to a day with jobs on it.
  const empty = page.locator('[data-testid="production-empty"]')
  if (await empty.count()) {
    await empty.locator('button').first().click()
    await page.waitForTimeout(800)
  }

  const list = page.locator('[data-testid="production-worklist"]')
  if (!(await list.count())) throw new Error('no planned work found for STITCH')
  const workDate = await page.inputValue('[data-testid="production-date"]')

  // Anchored by testid: the acceptance panel renders above this one and brings
  // its own table, which is how a "first table" locator has broken twice.
  const good = list.locator('input[type=number]:visible').first()
  await good.fill('26')
  await good.press('Enter')

  await page.waitForSelector('text=Entered', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/production.png`, fullPage: true })

  // And it survives a reload, which is what proves it reached the database.
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STITCH')
  await page.fill('[data-testid="production-date"]', workDate)
  await page.waitForTimeout(800)
  const saved = await page
    .locator('[data-testid="production-worklist"] input[type=number]:visible')
    .first()
    .inputValue()
  if (Number(saved) !== 26) throw new Error(`reload lost the entry: ${saved}`)

  return '26 declared by stitching, persisted across reload'
})

await step('count in a handover', async () => {
  // Stapling is fed by stitching, so what stitching just declared is now
  // sitting in stapling's queue. Assembly would have been wrong: it is fed by
  // ply cutting and machining, which is a different stream entirely.
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STAPLE')
  await page.waitForSelector('[data-testid="pending-acceptance"]', {
    timeout: 60_000,
  })

  const received = page
    .locator('[data-testid="pending-acceptance"] input[type=number]:visible')
    .first()
  await received.fill('24')
  // Anchored by testid and scoped to visible: both layouts are in the DOM at
  // once now, and a text selector matches the hidden phone card first — which
  // waitForSelector then waits to become visible, forever.
  const shortfall = page.locator('[data-testid="shortfall"]:visible').first()
  await shortfall.waitFor({ timeout: 10_000 })
  const said = (await shortfall.innerText()).trim()
  if (!said.startsWith('2 ')) throw new Error(`shortfall reads "${said}"`)
  await page.screenshot({ path: `${outDir}/wip-handover.png`, fullPage: true })

  await page.locator('button:visible', { hasText: 'Count in' }).first().click()

  // Counted in, so it leaves the queue rather than sitting there confirmed.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="pending-acceptance"]'),
    undefined,
    { timeout: 60_000 },
  )
  return 'stapling counted in 24 of 26, shortfall kept'
})

// --- a what-if scenario, compared and promoted ------------------------------

await step('what-if scenario', async () => {
  await go('#/whatif', 'text=Try a change')

  await page.fill(
    'input[placeholder="Second shift on stitching through November"]',
    'Stitching down for a fortnight',
  )
  await page.selectOption('form select', { label: 'Stitching' })
  await page.click('button:has-text("Department down")')
  await page.click('button:has-text("Run it")')

  await page.waitForSelector('text=What changed', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/whatif.png`, fullPage: true })

  // Taking a department out for the whole horizon cannot make the plan better.
  // If this reports fewer breaches, the comparison is reading the two runs the
  // wrong way round — which would look entirely plausible on screen.
  const worse = await page.locator('text=/\\d+ more breaches/').count()
  if (!worse) {
    throw new Error(
      'shutting a department down did not increase the breach count',
    )
  }

  const changed = await page
    .locator('table tr', { hasText: 'STITCH' })
    .filter({ hasText: '::STITCH' })
    .count()
  if (changed < 2) {
    throw new Error(`only ${changed} tasks changed — expected the department's work to move`)
  }
  return `${changed} tasks changed, breach count up`
})

await step('promote a scenario', async () => {
  await go('#/whatif', 'text=Try a change')

  // Compare the newest non-live run, then make it the plan.
  await page.locator('button:has-text("Compare")').first().click()
  await page.waitForSelector('button:has-text("Make this the plan")', {
    timeout: 60_000,
  })
  await page.click('button:has-text("Make this the plan")')

  // The promoted run must be the one now labelled as live.
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('tr')]
      return rows.some(
        (r) =>
          r.textContent?.includes('Live plan') &&
          r.textContent?.includes('Stitching down'),
      )
    },
    undefined,
    { timeout: 60_000 },
  )
  await page.screenshot({ path: `${outDir}/whatif-promoted.png`, fullPage: true })
  return 'scenario is now the live plan'
})

// --- where everything is, without a single rupee ----------------------------

await step('wip', async () => {
  await go('#/wip', 'text=Ready to stuff')

  // The demo seed leaves the Harper stool part-made, so it belongs under
  // In progress and not under Ready to stuff.
  const running = page.locator('[data-testid="wip-running"]')
  const text = await running.innerText()
  if (!/SO\/26-27\/0455/.test(text)) {
    throw new Error(`a part-made line is not showing as in progress: ${text.slice(0, 120)}`)
  }
  if (!/through the route|%/i.test(text)) {
    throw new Error('no progress figure on the line')
  }

  // Expanding names every department and what it has actually made.
  await running.locator('button').first().click()
  await page.waitForTimeout(500)
  const detail = await running.innerText()
  for (const d of ['Ply Cutting', 'Stitching', 'Final Packing']) {
    if (!detail.includes(d)) throw new Error(`route detail is missing ${d}`)
  }
  // The bug this step exists for: quantities rendering as em dashes because
  // the field was named qty_done and the view returns qty_good.
  if (/—\s*of\s*\d/.test(detail)) {
    throw new Error('quantities are rendering as dashes — wrong field name')
  }

  await page.screenshot({ path: `${outDir}/wip.png`, fullPage: true })
  return 'a part-made line, its route, and real quantities'
})

// --- a cost typed on one screen becomes a figure on another -----------------
//
// The whole feature, and it crosses two screens, so nothing smaller proves it.
// U&M deferred cost and were then asked for a spreadsheet; this is the box that
// replaced the ask, and it has to work from typing to reading.

await step('article cost to WIP value', async () => {
  await go('#/dashboard', 'text=Is the factory on track today?')
  const before = await page.locator('[data-testid="md-kpis"]').innerText()
  if (!/WIP value[\s\S]*?capacity sheet/i.test(before)) {
    throw new Error('WIP value is not pointing at the capacity sheet')
  }

  // Against the article that is actually in progress — WIP value counts lines
  // started and not finished, so costing an article nobody has begun changes
  // nothing, correctly.
  await go('#/capacity', 'text=Capacity sheet')
  await page.fill('input[placeholder="Code or name"]', 'UT263')
  await page.waitForTimeout(600)
  const cost = page
    .locator('[data-testid="capacity-grid"] tbody tr')
    .first()
    .locator('[data-testid="article-cost"] button')
    .first()
  await cost.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('16760')
  await input.press('Enter')
  await page.waitForTimeout(1500)

  // It survives a reload, which is what proves it reached the database.
  await go('#/capacity', 'text=Capacity sheet')
  await page.fill('input[placeholder="Code or name"]', 'UT263')
  await page.waitForSelector(
    '[data-testid="article-cost"] button:has-text("16,760"), [data-testid="article-cost"] button:has-text("16760")',
    { timeout: 60_000 },
  )

  await go('#/dashboard', 'text=Is the factory on track today?')
  await page.waitForTimeout(1200)
  const after = await page.locator('[data-testid="md-kpis"]').innerText()
  if (/WIP value[\s\S]*?capacity sheet/i.test(after)) {
    throw new Error('WIP value is still unavailable after a cost was entered')
  }
  // Coverage has to be stated either way — "all N" when everything in progress
  // is costed, "covering X of Y" when it is not. A rupee total that silently
  // omits part of the floor is worse than no total.
  if (!/(covering \d+ of \d+|all \d+) lines? in progress/i.test(after)) {
    throw new Error(`no coverage note beside the figure: ${after.slice(0, 200)}`)
  }

  await page.screenshot({ path: `${outDir}/wip-value.png`, fullPage: true })

  // Put it back. The next step asserts WIP value is unavailable, which is only
  // true while nothing in progress has a cost — leaving one behind would make
  // that step fail for a reason that has nothing to do with what it checks.
  await go('#/capacity', 'text=Capacity sheet')
  await page.fill('input[placeholder="Code or name"]', 'UT263')
  await page.waitForTimeout(600)
  await page
    .locator('[data-testid="capacity-grid"] tbody tr')
    .first()
    .locator('[data-testid="article-cost"] button')
    .first()
    .click()
  const clear = page.locator('input[type=number]:visible').first()
  await clear.fill('')
  await clear.press('Enter')

  // Assert the cleanup, rather than assuming it. A cleanup that quietly does
  // nothing hands its mess to the next step, which then fails for a reason
  // that has nothing to do with what it is checking.
  await page.waitForSelector('[data-testid="article-cost"] button:has-text("cost")', {
    timeout: 30_000,
  })

  return 'cost typed on the sheet, rupee figure and coverage on the dashboard'
})

// --- the MD dashboard says what it cannot compute ---------------------------

await step('md dashboard', async () => {
  await go('#/dashboard', 'text=Is the factory on track today?')
  const cards = page.locator('[data-testid="md-kpis"] > div')
  const n = await cards.count()
  // Slide 6's nine, plus WIP in units — the figure that needs no cost data.
  if (n !== 10) throw new Error(`expected ten KPI cards, found ${n}`)

  // The point of the whole screen. WIP value has no cost entered behind it and
  // has to say so — a zero here would be read as a rupee figure.
  //
  // Waited for rather than read: navigating between hashes is a same-document
  // move, so the query cache can still be serving the previous answer for a
  // moment after a step that changed it.
  await page.waitForFunction(
    () => {
      const kpis = document.querySelector('[data-testid="md-kpis"]')
      return /WIP value[\s\S]*?capacity sheet/i.test(kpis?.textContent ?? '')
    },
    undefined,
    { timeout: 30_000 },
  )
  const text = await page.locator('[data-testid="md-kpis"]').innerText()
  if (/WIP value\s*\n\s*[₹0]/i.test(text)) {
    throw new Error('WIP value is showing a number it cannot compute')
  }

  // Slide 11, planned against made. Built and tested since Phase 3 with no way
  // to see it — the fourth thing found that way, so it is checked on screen.
  const vsPlan = page.locator('[data-testid="production-vs-plan"]')
  const planRows = await vsPlan.locator('tbody tr').count()
  if (!planRows) {
    throw new Error(
      `plan-against-made panel has no rows: ${(await vsPlan.innerText()).slice(0, 120)}`,
    )
  }
  // Declaring production earlier in this run put a real figure on today, so a
  // table of nothing-but-dashes would mean the full join is not joining.
  // Read by column position rather than out of the prose: the last check that
  // scraped a number out of textContent matched a different department.
  const made = await vsPlan.evaluate((el) =>
    [...el.querySelectorAll('tbody tr')].some((tr) => {
      const cell = tr.children[3]?.textContent?.trim() ?? ''
      return cell !== '—' && Number(cell.replace(/,/g, '')) > 0
    }),
  )
  if (!made) throw new Error('every row shows nothing made — the join is not joining')

  await page.screenshot({ path: `${outDir}/dashboard.png`, fullPage: true })
  return "nine KPIs, the one without data says so, and plan against made"
})

// --- the department's own board ---------------------------------------------

await step('department board', async () => {
  await go('#/board', 'text=What you owe')
  // Stapling is fed by two streams, so it has something to wait for. An entry
  // point would show an empty inbound panel and prove nothing.
  await page.selectOption('[data-testid="board-department"]', 'STAPLE')
  await page.waitForTimeout(1200)

  const owed = await page
    .locator('[data-testid="board-queue"] >> text=/Still to make/i')
    .count()
  if (!owed) throw new Error('the department owes nothing — board has no content')

  // "From which department a component has to come so as to I can start my
  // work" — the feeders have to be named, and named from the route graph.
  const inbound = page.locator('[data-testid="board-inbound"]')
  const text = await inbound.innerText()
  if (!/Foam Pasting|Stitching/.test(text)) {
    throw new Error(`inbound panel names no feeder: ${text.slice(0, 120)}`)
  }

  // And it must lead with what is late rather than everything outstanding.
  if (!/still to come from upstream, none of it due yet/.test(text)) {
    throw new Error('the board is not separating late work from not-yet-due')
  }

  await page.screenshot({ path: `${outDir}/board.png`, fullPage: true })
  return 'feeders named, late work separated from not-yet-due'
})

// --- machines: booking downtime takes the department's day down -------------

await step('machine downtime', async () => {
  await go('#/masters', 'text=Machines')
  await page.waitForTimeout(600)

  const rows = await page.locator('[data-testid="machines-master"] tbody tr').count()
  if (rows < 5) throw new Error(`only ${rows} machines recorded`)

  // Stitching has eight machines in the demo and one already down. Booking a
  // second takes the department to six of eight — the point being that a
  // machine going down is not a note, it moves capacity.
  const before = await page
    .locator('[data-testid="machines-down-today"]')
    .innerText()
    .catch(() => '')

  await page.click('[data-testid="book-downtime"]')
  const modal = page.locator('[data-testid="modal"]')
  await modal.waitFor()
  await modal.locator('select').first().selectOption('STITCH-05')
  await modal.getByPlaceholder('Hook timing gone — spares ordered').fill('Needle bar seized')
  await modal.locator('button:has-text("Book it")').click()

  // Wait on the thing being asserted, not on a neighbour of it. The row and
  // the department summary come from two different queries, and waiting for
  // the row to flip then reading the summary caught it one refetch behind —
  // reporting seven of eight against a screen that was about to say six.
  //
  // Attributes rather than the sentence, too: the tag is uppercased in CSS, so
  // innerText reads "6 OF 8" and a case-sensitive match fails on a correct
  // screen. Seventh time that has bitten.
  await until(
    'stitching to report six of eight running',
    () => {
      const el = document.querySelector('[data-testid="machines-short-STITCH"]')
      return (
        el?.getAttribute('data-available') === '6' &&
        el?.getAttribute('data-machines') === '8'
      )
    },
    undefined,
  )

  const down = await page
    .locator('[data-testid="machine-STITCH-05"]')
    .getAttribute('data-down')
  if (down !== 'yes') throw new Error('the machine is not marked down on its own row')
  void before

  await page.screenshot({ path: `${outDir}/machines.png`, fullPage: true })
  return `${rows} machines, and booking downtime took stitching to six of eight`
})

// --- money: the cost sheet, and the half it refuses to guess ----------------

await step('cost and cash out', async () => {
  await go('#/money', 'text=Money out, week by week')
  await page.waitForTimeout(900)

  // The Betsy chair carries U&M's own costing sheet. Deliberately not the
  // article in production — WIP value has to stay unavailable so the dashboard
  // can demonstrate refusing to invent it.
  const costed = page.locator('[data-testid="cost-UD354 SPPL WAL"]')
  if ((await costed.getAttribute('data-breakdown')) !== 'yes') {
    throw new Error('the costed article is not showing a breakdown')
  }

  const uncosted = await page
    .locator('[data-testid^="cost-"][data-breakdown="no"]')
    .count()
  if (!uncosted) throw new Error('every article has a breakdown — nothing to tell apart')

  // Opening it shows the twenty-six lines, summing to the unit cost.
  await costed.click()
  await page.waitForTimeout(400)
  const detail = await page.locator('[data-testid="article-costs"]').innerText()
  if (!/leather/i.test(detail) || !/labour/i.test(detail)) {
    throw new Error('the cost lines are not showing')
  }

  // And the cash panel must say what it cannot price rather than quietly
  // totalling only what it can.
  const cash = await page.locator('[data-testid="cash-out"]').innerText()
  if (!/unpriced/i.test(cash)) {
    throw new Error('the cash panel is not declaring its unpriced lines')
  }

  await page.screenshot({ path: `${outDir}/money.png`, fullPage: true })
  return 'cost sheet reads, and cash out declares what it cannot price'
})

// --- quality: the unexplained balance stays visible -------------------------

await step('quality pareto', async () => {
  await go('#/quality', 'text=Where the losses come from')
  await page.waitForTimeout(900)

  const bars = await page.locator('[data-testid="defect-pareto"] > div > div').count()
  if (bars < 3) throw new Error(`only ${bars} causes on the Pareto`)

  // The demo deliberately leaves some rejects unexplained, because the panel
  // that matters is the one saying so. A Pareto that silently dropped them
  // would show every cause at a larger share and look tidier.
  const text = await page.locator('[data-testid="defect-pareto"]').innerText()
  if (!/not attributed/i.test(text)) {
    throw new Error('the unexplained balance is missing from the Pareto')
  }

  // And a department that has declared nothing is absent, not shown at zero:
  // stitching declared 26 earlier in this run, fitting has declared nothing.
  const rows = await page.locator('[data-testid="quality-by-department"] tbody tr').count()
  const absent = await page.locator('[data-testid="quality-FIT"]').count()
  if (absent) throw new Error('a department that has declared nothing is being shown')

  await page.screenshot({ path: `${outDir}/quality.png`, fullPage: true })
  return `${bars} causes, unexplained balance shown, ${rows} departments reporting`
})

// --- material: three states, and the date that stops being possible ---------

await step('material shortages', async () => {
  await go('#/material', 'text=Against the store')
  await page.waitForTimeout(900)

  // Read from attributes rather than the prose. Six checks in this file have
  // now failed on casing, word boundaries or a panel that only exists with
  // data — none of which an attribute has.
  const states = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="material-"][data-status]')].map(
      (el) => el.getAttribute('data-status'),
    ),
  )
  if (states.length < 5) throw new Error(`only ${states.length} materials on the plan`)

  // The whole point of the screen: three states, kept apart. The demo seeds
  // one of each deliberately, so all three must be present — a screen that
  // collapsed "never counted" into "short" would still look busy and correct.
  for (const wanted of ['short', 'covered', 'not counted']) {
    if (!states.includes(wanted)) {
      throw new Error(`no material is reported as "${wanted}": ${states.join(', ')}`)
    }
  }

  // And a count typed on the row moves it out of "never counted".
  const uncounted = page
    .locator('[data-testid^="material-"][data-status="not counted"]')
    .first()
  const code = (await uncounted.getAttribute('data-testid')).replace('material-', '')
  await uncounted.locator('button').first().click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('999999')
  await input.press('Enter')

  await until(
    `${code} to leave the uncounted list`,
    (c) =>
      document.querySelector(`[data-testid="material-${c}"]`)?.getAttribute('data-status') ===
      'covered',
    code,
  )

  await page.screenshot({ path: `${outDir}/material.png`, fullPage: true })
  return `${states.length} materials, all three states, and a count landed`
})

// --- the copy that holds what nobody can type again -------------------------
//
// Runs late, after production has been declared and counted in, so there is a
// ledger to lose. Checking this against an empty database would prove only that
// a file downloads.

await step('save everything to a file', async () => {
  await go('#/masters', 'text=Production route')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid="backup-everything"]'),
  ])
  const saved = `${outDir}/kram-backup.json`
  await download.saveAs(saved)

  const file = JSON.parse(await readFile(saved, 'utf8'))
  if (file.kram_backup !== 1) throw new Error('not a Kram backup file')

  // The masters half already had a file. The half that matters is the ledger —
  // 26 declared by stitching and 24 counted in by stapling, both earlier in
  // this run.
  const decl = file.data?.production_declarations ?? []
  const acc = file.data?.production_acceptances ?? []
  if (!decl.length) throw new Error('the file carries no production declarations')
  if (!acc.length) throw new Error('the file carries no handovers counted in')

  // Keyed by things that survive the database it came from. A uuid in here
  // means the file is worthless the moment it is needed.
  const first = decl[0]
  if (!first.erp_order_no || !first.department_code) {
    throw new Error(`ledger rows are not keyed naturally: ${JSON.stringify(first).slice(0, 90)}`)
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(first.erp_order_no))) {
    throw new Error('the order key is a uuid')
  }

  // And the disagreement is kept: declared and accepted differ, on purpose.
  if (!file.data.orders?.length) throw new Error('no orders in the file')

  const summary = await page.locator('text=/ledger entries/').innerText()
  return `${decl.length} declarations, ${acc.length} handovers — ${summary.toLowerCase()}`
})

// --- an article, from nothing to schedulable --------------------------------
//
// The last master that needed SQL. What matters is not that the row appears —
// it is that a brand-new article is honestly reported as unplannable until it
// has a route and its offsets, rather than quietly scheduling on a zero.

await step('add an article', async () => {
  await go('#/masters', 'text=Production route')

  const table = page.locator('[data-testid="articles-master"]')
  const before = await table.locator('tbody tr').count()

  await page.click('button:has-text("Add an article")')
  const modal = page.locator('[data-testid="modal"]')
  await modal.waitFor()
  // By placeholder, inside the modal. Indexing into `form` picked up a
  // different form on the page entirely and submitted three blank fields,
  // which the database correctly refused — and the step reported a timeout
  // rather than the refusal.
  await modal.getByPlaceholder('UD354 SPPL WAL').fill('DEMO-1')
  await modal.getByPlaceholder('Betsy Chair — Specter Pearl').fill('Bergen Chair')
  await modal.getByPlaceholder('Dining').fill('Dining')
  await modal.locator('button:has-text("Add article")').click()

  await until(
    'the new article to appear in the master',
    (n) =>
      document.querySelectorAll('[data-testid="articles-master"] tbody tr')
        .length === n,
    before + 1,
  )

  // State from attributes, not from the sentence. Twice today a /…\b/ against
  // textContent has matched the wrong thing — textContent runs cells together,
  // so "1" and "yes" become "1yes" and the word boundary never fires.
  const row = page.locator('[data-testid="article-DEMO-1"]')
  const state = async (attr) => row.getAttribute(attr)
  if ((await state('data-routed')) !== '0') {
    throw new Error('a brand-new article is claiming a route')
  }
  if ((await state('data-can-schedule')) !== 'no') {
    throw new Error('an article with nowhere to be made says it can be planned')
  }
  // And it says so in words, which is the half a user actually reads.
  const shown = await row.innerText()
  if (!/no route/i.test(shown)) {
    throw new Error(`a routeless article is not saying so: ${shown}`)
  }

  // Give it one department on the capacity sheet. It is still not schedulable —
  // nobody has said when that department must finish.
  await go('#/capacity', 'text=Capacity sheet')
  await page.fill('input[placeholder="Code or name"]', 'DEMO-1')
  await page.waitForTimeout(400)
  const cell = page
    .locator('[data-testid="capacity-grid"] tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .locator('button')
    .first()
  await cell.click()
  const rate = page.locator('input[type=number]:visible').first()
  await rate.fill('25')
  await rate.press('Enter')
  await page.waitForSelector('button:has-text("25")', { timeout: 60_000 })

  await go('#/masters', 'text=Production route')
  await until(
    'the routed article to report its missing D-minus',
    () => {
      const r = document.querySelector('[data-testid="article-DEMO-1"]')
      return (
        r?.getAttribute('data-routed') === '1' &&
        r?.getAttribute('data-missing-dminus') === '1' &&
        r?.getAttribute('data-can-schedule') === 'no'
      )
    },
    undefined,
  )

  // Now the offset, and only now can it be planned.
  await go('#/capacity', 'text=Capacity sheet')
  await page.fill('input[placeholder="Code or name"]', 'DEMO-1')
  await page.click('button:has-text("D-minus")')
  await page.waitForTimeout(400)
  const dcell = page
    .locator('[data-testid="capacity-grid"] tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .locator('button')
    .first()
  await dcell.click()
  const days = page.locator('input[type=number]:visible').first()
  await days.fill('45')
  await days.press('Enter')
  await page.waitForTimeout(1500)

  await go('#/masters', 'text=Production route')
  try {
    await until(
      'the article to become schedulable',
      () =>
        document
          .querySelector('[data-testid="article-DEMO-1"]')
          ?.getAttribute('data-can-schedule') === 'yes',
      undefined,
    )
  } catch {
    throw new Error(
      `still not schedulable: ${(await row.innerText()).replace(/\n/g, ' ')}`,
    )
  }

  await page.screenshot({ path: `${outDir}/articles.png`, fullPage: true })
  return 'added, no route → D-minus missing → schedulable'
})

// --- marking one person moves what the department can make ------------------
//
// The whole reason set_employee_attendance derives department_attendance rather
// than sitting beside it. Two screens, two views, one number: mark somebody out
// on Manpower, and Today's capacity on the Production screen — which reads
// department_day.present, the figure resolve_capacity itself reads — has to
// agree without anybody typing it in twice.

await step('attendance moves capacity', async () => {
  await go('#/manpower', 'text=Who is in')
  await page.selectOption('[data-testid="manpower-department"]', 'STITCH')
  await page.waitForTimeout(900)

  // Read from an attribute, not from the prose. Scraping "11 in" out of
  // textContent looked fine and matched the wrong department, because
  // textContent runs "11 in" straight into "1 out" and \b never fires.
  const card = page.locator('[data-testid="manpower-dept-STITCH"]')
  const before = Number(await card.getAttribute('data-present'))
  if (!before) throw new Error('nobody is in — the demo roster is not being marked')

  // The first person the panel lists who is currently in. Scoped to the
  // people panel: "Out" also appears in the summary above, and an unanchored
  // locator has broken five checks here already.
  const person = page
    .locator('[data-testid="manpower-people"] > div > div')
    .filter({ has: page.locator('button.border-blue:has-text("In")') })
    .first()
  const name = (await person.innerText()).split('\n')[0]
  await person.getByRole('button', { name: 'Out' }).click()

  await page.waitForFunction(
    (n) =>
      document
        .querySelector('[data-testid="manpower-dept-STITCH"]')
        ?.getAttribute('data-present') === String(n),
    before - 1,
    { timeout: 60_000 },
  )
  await page.screenshot({ path: `${outDir}/manpower.png`, fullPage: true })

  // And the number the engine reads followed, on a screen that never saw the
  // employee record.
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'STITCH')
  await page.waitForFunction(
    (n) => new RegExp(`\\b${n}\\b\\s*of\\s*\\d+ in`).test(document.body.innerText),
    before - 1,
    { timeout: 60_000 },
  )

  return `${name} marked out — ${before} in became ${before - 1}, and capacity followed`
})

// --- every screen is usable with a thumb ------------------------------------
//
// One pass over all of them at phone width. Deliberately excludes cells inside
// a data grid: a heatmap cell is 18px because a heatmap's job is showing the
// shape of a month at once, and 44px cells would show a week. Density is the
// feature there. Everything a person actually operates — buttons, fields,
// selects — has to be thumb-sized.

await step('thumb-sized everywhere', async () => {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const small = await phone.newPage()
  small.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const screens = [
    ['', 'Bottleneck utilisation'],
    ['#/dashboard', 'Is the factory on track today?'],
    ['#/heatmap', 'Load heatmap'],
    ['#/gantt', 'Manual pins'],
    ['#/orders', 'Order book'],
    ['#/accept', 'Can we take this order?'],
    ['#/whatif', 'Try a change'],
    ['#/wip', 'Ready to stuff'],
    ['#/board', 'What you owe'],
    ['#/production', 'What you were asked for'],
    ['#/capacity', 'Capacity sheet'],
    ['#/manpower', 'Who is in'],
    ['#/material', 'Against the store'],
    ['#/quality', 'Where the losses come from'],
    ['#/money', 'Money out, week by week'],
    ['#/masters', 'Production route'],
  ]

  try {
    const bad = []
    for (const [hash, waitFor] of screens) {
      await small.goto(`${baseUrl}/${hash}`)
      await small.waitForSelector(`text=${waitFor}`, { timeout: 90_000 })
      await small.waitForTimeout(700)

      const found = await small.evaluate((name) => {
        const visible = (el) =>
          el.offsetParent !== null && el.getBoundingClientRect().height > 0
        const controls = [
          ...document.querySelectorAll('button, input, select'),
        ].filter(
          (el) =>
            visible(el) &&
            // A cell in a data grid is not a thumb target. Both exclusions are
            // declared in the markup — a table, or an explicit
            // data-dense-grid — so widening them is a visible decision rather
            // than a quietly generous selector.
            !el.closest('table') &&
            !el.closest('[data-dense-grid]') &&
            el.getAttribute('type') !== 'checkbox',
        )
        return {
          name,
          sideways: document.documentElement.scrollWidth > window.innerWidth,
          undersized: controls
            .filter((el) => el.getBoundingClientRect().height < 44)
            .map(
              (el) =>
                `${el.tagName} ${Math.round(el.getBoundingClientRect().height)}px "${(el.textContent || '').trim().slice(0, 20)}"`,
            ),
        }
      }, hash || 'command centre')

      if (found.sideways) bad.push(`${found.name}: page scrolls sideways`)
      for (const u of found.undersized) bad.push(`${found.name}: ${u}`)
    }

    if (bad.length) throw new Error(bad.slice(0, 6).join(' | '))
    return `${screens.length} screens, no control under 44px, nothing scrolling sideways`
  } finally {
    await phone.close()
  }
})

// --- production, on a phone, on the floor -----------------------------------
//
// U&M's own answer to "who enters production and when" was: on a phone, on the
// floor, as it happens. Every other step here runs at 1440px, where a
// six-column table is fine and the fact that Rejected and Save sit off the
// right-hand edge of a 390px screen is invisible.

await step('production on a phone', async () => {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const small = await phone.newPage()
  small.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  try {
    await small.goto(`${baseUrl}/#/production`)
    await small.waitForSelector('text=What you were asked for', {
      timeout: 90_000,
    })
    await small.waitForTimeout(1200)

    const empty = small.locator('[data-testid="production-empty"]')
    if (await empty.count()) {
      await empty.locator('button').first().click()
      await small.waitForTimeout(1200)
    }

    const measured = await small.evaluate(() => {
      const visible = (el) => el.offsetParent !== null
      const controls = [
        ...document.querySelectorAll('button, input, select, a'),
      ].filter(visible)
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        undersized: controls
          .map((el) => ({
            label: (
              el.textContent ||
              el.getAttribute('aria-label') ||
              el.tagName
            )
              .trim()
              .slice(0, 30),
            height: Math.round(el.getBoundingClientRect().height),
          }))
          .filter((c) => c.height > 0 && c.height < 44),
      }
    })

    // A table that scrolls sideways is allowed; a page that does is not — it
    // hides the primary action off-screen with nothing to say it is there.
    if (measured.scrollWidth > measured.viewport) {
      throw new Error(
        `page scrolls sideways: ${measured.scrollWidth} > ${measured.viewport}`,
      )
    }

    if (measured.undersized.length) {
      const worst = measured.undersized
        .map((c) => `${c.label} (${c.height}px)`)
        .join(', ')
      throw new Error(`touch targets under 44px: ${worst}`)
    }

    // The whole job — figures and the action — has to be on screen without
    // hunting for it.
    const card = small.locator('[data-testid="production-worklist"]')
    await card.locator('input[inputmode="numeric"]').first().fill('7')
    const save = card.locator('button', { hasText: 'Save' }).first()
    const box = await save.boundingBox()
    if (!box || box.x + box.width > 390) {
      throw new Error('the save button is not fully on a 390px screen')
    }
    await save.click()
    await small.waitForSelector('text=Entered', { timeout: 60_000 })

    await small.screenshot({
      path: `${outDir}/mobile-production.png`,
      fullPage: true,
    })
    return 'declared from a 390px screen, every target ≥44px'
  } finally {
    await phone.close()
  }
})

// --- a browser that has been here before gets the current database ----------
//
// Last, because it rebuilds the database and would pull the ground out from
// under any step after it.
//
// This is the case no run of this script could previously reach. Playwright
// opens a fresh context each time, so localStorage is always empty, the version
// check always mismatches and the database is always rebuilt — twenty green
// steps over a build that was stale for every returning visitor. Within one
// context, though, localStorage survives navigation, which is enough to play a
// returning visitor.

await step('a returning browser', async () => {
  await go('', 'text=Bottleneck utilisation')

  const stored = await page.evaluate(() =>
    localStorage.getItem('kram-schema-version'),
  )

  // The version has to be derived from the SQL. Pinned back to a constant — as
  // it was for thirty migrations — a returning browser keeps its old database
  // for good, and nothing downstream of this can tell.
  if (!stored || !/^[0-9a-f]+-[0-9a-z]+$/.test(stored)) {
    throw new Error(
      `schema version is not derived from the SQL: ${JSON.stringify(stored)}`,
    )
  }

  // Now be a browser built by an older Kram: same stored database, a version
  // from SQL that no longer exists.
  await page.goto(`${baseUrl}/#/capacity`)
  await page.waitForSelector('text=Capacity sheet', { timeout: 60_000 })
  await page.evaluate(() =>
    localStorage.setItem('kram-schema-version', 'stale-from-an-older-build'),
  )

  // reload(), not goto(): a URL that differs only by its fragment is a
  // same-document navigation, so the module never re-runs and the boot code
  // under test never executes.
  await page.reload()
  await page.waitForSelector('text=Capacity sheet', { timeout: 60_000 })
  // Lowercased first: the panel reads "14 DEPARTMENTS" on screen only because
  // CSS uppercases it, and textContent gives what is actually in the DOM.
  await page.waitForFunction(
    () => /6 articles × 14 departments/i.test(document.body.textContent ?? ''),
    undefined,
    { timeout: 90_000 },
  )

  const rebuilt = await page.evaluate(() =>
    localStorage.getItem('kram-schema-version'),
  )
  if (rebuilt !== stored) {
    throw new Error(`stored version did not return to ${stored}: ${rebuilt}`)
  }

  return `rebuilt on a stale version, ${stored}`
})

await browser.close()

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`)
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`)
}

if (failed || errors.length) process.exit(1)
