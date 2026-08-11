/**
 * Drives the running dev server in headless Chromium and captures each screen.
 *
 *   npm run dev &
 *   node scripts/screenshot.mjs [baseUrl] [outDir]
 *
 * Exists because "it builds" says nothing about whether Postgres actually
 * starts in the browser. Every screen is visited, every console error is
 * reported, and a blank screenshot is a failure however green the build was.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.argv[2] ?? 'http://localhost:5173'
const outDir = process.argv[3] ?? 'screenshots'

const SCREENS = [
  { hash: '', name: 'command-centre', waitFor: 'text=Bottleneck utilisation' },
  { hash: '#/heatmap', name: 'heatmap', waitFor: 'text=Load heatmap' },
  { hash: '#/gantt', name: 'schedule', waitFor: 'text=Schedule' },
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

let failed = false

for (const screen of SCREENS) {
  const url = `${baseUrl}/${screen.hash}`
  process.stdout.write(`${screen.name.padEnd(16)} `)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // First load compiles Postgres to WASM and applies the schema, so this is
    // generous on purpose.
    await page.waitForSelector(screen.waitFor, { timeout: 60_000 })
    await page.waitForTimeout(700)
    await page.screenshot({
      path: `${outDir}/${screen.name}.png`,
      fullPage: true,
    })
    console.log('ok')
  } catch (e) {
    failed = true
    console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    await page
      .screenshot({ path: `${outDir}/${screen.name}-failed.png` })
      .catch(() => {})
  }
}

// One interaction, so the run proves more than that the shell painted.
process.stdout.write('acceptance check  ')
try {
  await page.goto(`${baseUrl}/#/accept`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Can we take this order?', { timeout: 60_000 })
  await page.fill('input[type=number]', '5000')
  await page.fill('input[type=date]', '2026-12-20')
  await page.click('button:has-text("Check")')
  await page.waitForSelector('text=Not as it stands', { timeout: 60_000 })
  await page.screenshot({ path: `${outDir}/acceptance-result.png`, fullPage: true })
  console.log('ok — 5,000 units on short notice correctly refused')
} catch (e) {
  failed = true
  console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
}

await browser.close()

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`)
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`)
}

process.exit(failed || errors.length ? 1 : 0)
