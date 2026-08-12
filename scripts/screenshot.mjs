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
import { mkdir } from 'node:fs/promises'
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
  const cell = page.locator('button:has-text("D-60")').first()
  await cell.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('64')
  await input.press('Enter')
  await page.waitForSelector('button:has-text("D-64")', { timeout: 60_000 })

  // And it survives a reload, which is what proves it reached the database
  // rather than only React state.
  await go('#/masters', 'text=D-minus matrix')
  await page.waitForSelector('button:has-text("D-64")', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/masters.png`, fullPage: true })
  return 'D-60 → D-64, persisted across reload'
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

  // The previous step left wood at D-64. Move it, then load the file back and
  // it should return — which is what proves the file carries real values and
  // the import reaches the database.
  const cell = page.locator('button:has-text("D-64")').first()
  await cell.click()
  const input = page.locator('input[type=number]:visible').first()
  await input.fill('70')
  await input.press('Enter')
  await page.waitForSelector('button:has-text("D-70")', { timeout: 60_000 })

  await page.setInputFiles('[data-testid="masters-import"]', saved)
  await page.waitForSelector('text=/\\d+ rows applied/', { timeout: 60_000 })
  await page.waitForSelector('button:has-text("D-64")', { timeout: 60_000 })

  return 'exported, changed, re-imported, value restored'
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
  const cell = page.locator('table tbody tr').first().locator('button').first()
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

  // Fabric cutting sits after wood but is about to be told to finish ten days
  // before it — which holds it behind work that is not due, and raises a runway
  // breach that is not real.
  const grid = page.locator('[data-testid="capacity-grid"]')
  const fabcutColumn = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="capacity-grid"]')
    const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
    return heads.indexOf('FABCUT')
  })
  if (fabcutColumn < 1) throw new Error('FABCUT column not found')

  // Scoped to the grid: once the warning appears it brings its own table, and
  // an unanchored "first table" locator quietly moves to it.
  const cellAt = () =>
    grid.locator('tbody tr').first().locator('td').nth(fabcutColumn).locator('button')

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
  await fix.fill('50')
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
  // Put the contradiction back: fabric cutting due ten days before wood, while
  // waiting on it. The disagreement is real only because we claim wood feeds
  // fabric cutting, which it does not.
  await go('#/capacity', 'text=Capacity sheet')
  await page.click('button:has-text("D-minus")')
  await page.waitForTimeout(400)

  const grid = page.locator('[data-testid="capacity-grid"]')
  const fabcutColumn = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="capacity-grid"]')
    const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    )
    return heads.indexOf('FABCUT')
  })
  const cell = grid
    .locator('tbody tr')
    .first()
    .locator('td')
    .nth(fabcutColumn)
    .locator('button')
  await cell.click()
  const dminus = page.locator('input[type=number]:visible').first()
  await dminus.fill('70')
  await dminus.press('Enter')
  await page.waitForSelector(
    'text=A department is due before something that feeds it',
    { timeout: 60_000 },
  )

  // Say what is true on Masters — fabric cutting waits for nothing.
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
  await rowFor('FABCUT')
    .locator('td')
    .nth(columns.indexOf('WOOD'))
    .locator('button')
    .click()
  await page.waitForTimeout(1200)
  await rowFor('STITCH')
    .locator('td')
    .nth(columns.indexOf('WOOD'))
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
    .nth(fabcutColumn)
    .locator('button')
  await restore.click()
  const back = page.locator('input[type=number]:visible').first()
  await back.fill('50')
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
  const good = list.locator('input[type=number]').first()
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
    .locator('[data-testid="production-worklist"] input[type=number]')
    .first()
    .inputValue()
  if (Number(saved) !== 26) throw new Error(`reload lost the entry: ${saved}`)

  return '26 declared by stitching, persisted across reload'
})

await step('count in a handover', async () => {
  // Assembly is fed by stitching in the seeded graph, so what stitching just
  // declared is now sitting in assembly's queue.
  await go('#/production', 'text=What you were asked for')
  await page.selectOption('[data-testid="production-department"]', 'ASSY')
  await page.waitForSelector('[data-testid="pending-acceptance"]', {
    timeout: 60_000,
  })

  const received = page
    .locator('[data-testid="pending-acceptance"] input[type=number]')
    .first()
  await received.fill('24')
  await page.waitForSelector('text=2 short', { timeout: 10_000 })
  await page.screenshot({ path: `${outDir}/wip-handover.png`, fullPage: true })

  await page.click('button:has-text("Count in")')

  // Counted in, so it leaves the queue rather than sitting there confirmed.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="pending-acceptance"]'),
    undefined,
    { timeout: 60_000 },
  )
  return 'assembly counted in 24 of 26, shortfall kept'
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
    .filter({ hasText: 'COVER' })
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

await browser.close()

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`)
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`)
}

if (failed || errors.length) process.exit(1)
