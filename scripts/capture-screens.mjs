/**
 * Photographs every screen, clean, for somebody who is going to redesign them.
 *
 *   node scripts/capture-screens.mjs <out-dir>                    # the demo
 *   node scripts/capture-screens.mjs <out-dir> <email> <password> # + the live project
 *
 * ---------------------------------------------------------------------------
 * Why this is not `npm run screenshot` or `npm run walkthrough`.
 *
 * Those two take pictures as a by-product. The browser check photographs each
 * screen the moment its heading exists, because it is asking whether the screen
 * rendered; the walkthrough draws yellow numbers over what it photographs,
 * because it is explaining. A designer needs neither: they need every screen,
 * finished loading, with nothing drawn on it, at a size they can zoom into.
 *
 * ---------------------------------------------------------------------------
 * Two sets, because each shows what the other cannot.
 *
 * - **The demonstration build** (no login, invented figures) has something on
 *   every screen: production declared, material short, machines down, money
 *   priced. It is where the full design can be seen.
 * - **The hosted project**, when a login is given, is what the client actually
 *   looks at — twenty departments, real article names, and a good many screens
 *   still empty. Empty states are part of the design too, and nobody sees them
 *   in a demo.
 *
 * ---------------------------------------------------------------------------
 * Tall screens.
 *
 * Masters on the hosted project is a hundred thousand pixels high: a matrix of
 * seventy-two articles by twenty departments, printed in full. A picture of
 * that is not a picture anybody can open. So a screen taller than `CAP` is
 * photographed down to `CAP`, and then each of its panels is photographed on
 * its own from the top, into a folder beside it — every panel is seen, and no
 * table is shown past the point where it stops saying anything new.
 *
 * Read-only on both builds. It signs in, looks, and writes files.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const [outArg, email, password] = process.argv.slice(2)
if (!outArg) {
  console.error('Usage: capture-screens.mjs <out-dir> [email password]')
  process.exit(1)
}
const outRoot = outArg.replace(/\/$/, '')

const WIDTH = 1440
const CAP = 6000
const PANEL_CAP = 1500

/** In menu order, so the files sort the way the software reads. */
const SCREENS = [
  ['attention', '#/attention', 'Needs an answer today', '[data-testid="attention-critical"][data-state="ready"]'],
  ['command-centre', '#/', 'Bottleneck utilisation', 'text=/^Constraint$/i'],
  ['dashboard', '#/dashboard', 'Is the factory on track today?'],
  ['factory-map', '#/map', 'The factory, as it flows', '[data-testid^="map-node-"]'],
  ['load-heatmap', '#/heatmap', 'Load heatmap', '[data-testid="heatmap-grid"]'],
  ['schedule', '#/gantt', 'Drag a bar', '[data-testid="gantt-bar"]'],
  ['order-book', '#/orders', 'Order book', 'tbody tr'],
  ['accept-an-order', '#/accept', 'Can we take this order?'],
  ['what-if', '#/whatif', 'Try a change'],
  ['wip', '#/wip', 'Ready to stuff'],
  ['my-department', '#/board', 'What you owe'],
  ['production', '#/production', 'What you were asked for'],
  ['manpower', '#/manpower', 'Who is in'],
  ['material', '#/material', 'Against the store'],
  ['quality', '#/quality', 'Where the losses come from'],
  ['forecast', '#/forecast', 'How much of this is worth believing'],
  ['money', '#/money', 'Money out, week by week'],
  ['capacity-sheet', '#/capacity', 'Capacity sheet', '[data-testid="capacity-grid"]'],
  ['masters', '#/masters', 'Production route'],
  ['users', '#/users', 'Roles'],
]

async function alive(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

/** Its own server on its own port, so it can never photograph the wrong build. */
async function serve(mode, port) {
  const url = `http://localhost:${port}`
  if (await alive(url)) throw new Error(`Something is already on ${url}; stop it first.`)
  const args = ['vite', '--port', String(port), '--strictPort', ...(mode ? ['--mode', mode] : [])]
  const child = spawn('npx', args, { cwd: repoRoot, stdio: 'ignore' })
  const by = Date.now() + 90_000
  while (!(await alive(url))) {
    if (Date.now() > by) {
      child.kill()
      throw new Error(`The ${mode ?? 'demonstration'} server never came up on ${url}.`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { url, stop: () => !child.killed && child.kill() }
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

async function capture({ label, dir, base, signIn }) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 1000 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const taken = []

  /*
   * Loaded, not merely rendered. The heading is there long before the figures
   * are; a picture taken in between shows dashes and "No run yet" and looks
   * like an empty screen. So: the network quiet, no loading sentence left on
   * the page, and a beat for the last paint.
   */
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
    await page
      .waitForFunction(
        () => !/Loading…|Running every check…|Working…/.test(document.body.innerText),
        null,
        { timeout: 60_000 },
      )
      .catch(() => {})
    await page.waitForTimeout(1200)
  }

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  if (signIn) {
    await page.waitForSelector('text=Sign in', { timeout: 90_000 })
    await settle()
    await page.screenshot({ path: `${dir}/00-sign-in.png` })
    taken.push({ file: '00-sign-in.png', name: 'Sign in' })
    await page.fill('input[type=email]', signIn.email)
    await page.fill('input[type=password]', signIn.password)
    await page.click('button:has-text("Sign in")')
    const outcome = await Promise.race([
      page.waitForSelector('text=Bottleneck utilisation', { timeout: 60_000 }).then(() => 'in'),
      page.waitForSelector('text=do not match', { timeout: 60_000 }).then(() => 'refused'),
    ])
    if (outcome === 'refused') {
      await browser.close()
      throw new Error('that email and password do not match')
    }
  } else {
    // The demonstration builds its database in the browser on first load.
    await page.waitForSelector('text=Bottleneck utilisation', { timeout: 180_000 })
  }

  let n = 0
  for (const [name, hash, heading, ready] of SCREENS) {
    n += 1
    const no = String(n).padStart(2, '0')
    if (name === 'users' && !signIn) continue // the demonstration has no accounts
    process.stdout.write(`  ${label} ${no} ${name.padEnd(18)}`)
    try {
      await page.setViewportSize({ width: WIDTH, height: 1000 })
      await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(`text=${heading}`, { timeout: 90_000 })
      if (ready) await page.waitForSelector(ready, { timeout: 30_000 }).catch(() => {})
      await settle()

      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      const file = `${no}-${name}.png`
      if (height <= CAP) {
        await page.screenshot({ path: `${dir}/${file}`, fullPage: true })
        taken.push({ file, name, height })
        console.log(`${height}px`)
        continue
      }

      // Too tall to be one picture: the top of the page, then each panel.
      await page.setViewportSize({ width: WIDTH, height: CAP })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${dir}/${file}` })
      taken.push({ file, name, height, cut: true })

      const sub = `${no}-${name}-panels`
      await mkdir(`${dir}/${sub}`, { recursive: true })
      await page.setViewportSize({ width: WIDTH, height: PANEL_CAP + 80 })
      const panels = page.locator('main section')
      const count = await panels.count()
      for (let i = 0; i < count; i += 1) {
        const panel = panels.nth(i)
        const title = (await panel.locator('header > b').first().innerText().catch(() => `panel ${i + 1}`)).trim()
        await panel.evaluate((el) => {
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 20)
        })
        await page.waitForTimeout(250)
        const box = await panel.boundingBox()
        if (!box) continue
        const pfile = `${sub}/${String(i + 1).padStart(2, '0')}-${slug(title)}.png`
        await page.screenshot({
          path: `${dir}/${pfile}`,
          clip: {
            x: Math.max(0, box.x - 16),
            y: Math.max(0, box.y - 16),
            width: Math.min(WIDTH, box.width + 32),
            height: Math.min(box.height + 32, PANEL_CAP),
          },
        })
        taken.push({ file: pfile, name: `${name} — ${title}`, height: Math.round(box.height), cut: box.height > PANEL_CAP, panel: true })
      }
      console.log(`${height}px — cut at ${CAP}, plus ${count} panels`)
    } catch (e) {
      console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
      taken.push({ file: null, name, failed: true })
    }
  }

  // The wall screen: one department's day, full screen, no menu.
  process.stdout.write(`  ${label} 21 floor-display     `)
  try {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${base}/#/display`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="floor-display"]', { timeout: 60_000 })
    await settle()
    await page.screenshot({ path: `${dir}/21-floor-display.png` })
    taken.push({ file: '21-floor-display.png', name: 'floor-display', height: 1080 })
    console.log('1920×1080')
  } catch (e) {
    console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    taken.push({ file: null, name: 'floor-display', failed: true })
  }

  await browser.close()
  return { taken, errors }
}

// --- run ---------------------------------------------------------------------
await mkdir(outRoot, { recursive: true })
const sets = []

console.log('The demonstration build (every screen has something on it)')
const demo = await serve(null, 5184)
try {
  sets.push({
    title: 'Demonstration build — invented figures, every screen populated',
    folder: '1-demo-full-data',
    ...(await capture({ label: 'demo', dir: `${outRoot}/1-demo-full-data`, base: demo.url })),
  })
} finally {
  demo.stop()
}

if (email && password) {
  console.log("\nThe hosted project (what the client sees today: U&M's sample)")
  const live = await serve('hosted', 5183)
  try {
    sets.push({
      title: "Hosted project — U&M's six sample products, as the client sees it",
      folder: '2-live-sample',
      ...(await capture({
        label: 'live',
        dir: `${outRoot}/2-live-sample`,
        base: live.url,
        signIn: { email, password },
      })),
    })
  } catch (e) {
    console.log(`\nThe hosted set was not taken: ${e instanceof Error ? e.message : e}`)
  } finally {
    live.stop()
  }
}

// --- a note for whoever opens the folder -------------------------------------
/*
 * The tokens are read out of the stylesheet rather than typed here, for the
 * usual reason: a list of colours in a text file is right on the day it is
 * written and then describes a product that no longer exists.
 */
const css = await readFile(`${repoRoot}src/index.css`, 'utf8')
const theme = css.slice(css.indexOf('@theme {'), css.indexOf('\n}', css.indexOf('@theme {')))
const tokens = [...theme.matchAll(/^\s*(--[a-z-]+):\s*([^;]+);/gm)]
  .map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()])
  .filter(([k]) => /^--(color|radius|font|text)-/.test(k) && !/--text-.*--/.test(k))

const lines = []
lines.push('KRAM — screens, for design review')
lines.push('=================================')
lines.push('')
lines.push('Production planning software for a furniture factory. Twenty screens, a')
lines.push('sign-in page, and a full-screen display for a television on the shop floor.')
lines.push(`Taken ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST, at ${WIDTH}px wide, 2x.`)
lines.push('Files are numbered in the order of the menu. Nothing is drawn on them.')
lines.push('')
for (const set of sets) {
  lines.push(set.title)
  lines.push('-'.repeat(set.title.length))
  lines.push(`Folder: ${set.folder}/`)
  for (const t of set.taken) {
    if (t.failed) lines.push(`  (not taken) ${t.name}`)
    else lines.push(`  ${t.file}${t.cut ? `   [long ${t.panel ? 'panel' : 'screen'}: top part only]` : ''}`)
  }
  lines.push('')
}
lines.push('Notes')
lines.push('-----')
lines.push('- A folder ending in "-panels" belongs to a screen too long to show whole:')
lines.push('  the numbered picture is the top of the page, the folder is each panel.')
lines.push('- Phone layouts exist and are not in this set.')
lines.push('- The yellow strip across the top says the figures are placeholders. It is')
lines.push('  part of the product and stays until real figures are loaded.')
lines.push('- Red, amber and green carry meaning everywhere: over capacity, at')
lines.push('  capacity, inside capacity. They are not decoration.')
lines.push('')
lines.push('Current design tokens (from src/index.css)')
lines.push('------------------------------------------')
lines.push('Type:  Archivo (titles, figures) · Inter (reading text) · IBM Plex Mono (data, labels)')
for (const [k, v] of tokens) lines.push(`  ${k.padEnd(26)} ${v}`)
lines.push('')
await writeFile(`${outRoot}/READ ME FIRST.txt`, lines.join('\n'))

const total = sets.reduce((sum, s) => sum + s.taken.filter((t) => !t.failed).length, 0)
const failed = sets.flatMap((s) => s.taken.filter((t) => t.failed).map((t) => `${s.folder}: ${t.name}`))
console.log(`\n${total} pictures in ${outRoot}`)
if (failed.length) {
  console.log(`Not taken: ${failed.join(', ')}`)
  process.exitCode = 1
}
for (const s of sets) {
  if (s.errors.length) console.log(`${s.folder}: ${s.errors.length} console error(s), first: ${s.errors[0].slice(0, 140)}`)
}
