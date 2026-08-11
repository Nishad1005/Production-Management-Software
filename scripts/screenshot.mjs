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

await browser.close()

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`)
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`)
}

if (failed || errors.length) process.exit(1)
