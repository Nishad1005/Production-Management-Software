/**
 * Drives the *hosted* client in a browser, against the live Supabase project.
 *
 *   npm run verify:hosted-ui                      # as far as the login screen
 *   npm run verify:hosted-ui <email> <password>   # and every screen behind it
 *
 * Starts the hosted dev server itself if one is not already running, and stops
 * it again afterwards. No second terminal, no setup.
 *
 * Why this exists, when `screenshot.mjs` already drives every screen: it drives
 * them against PGlite. It resets demo data and checks that a returning browser
 * rebuilds its local database — both offline-only behaviours, neither of which
 * can run against Supabase. So the application has been exercised in a browser
 * hundreds of times and *never once against the backend U&M will actually use*.
 *
 * `verify-live.mjs` probes that backend directly and proves the API answers
 * correctly. That is a different claim from "the client renders what it gets
 * back". Between the two sits everything this file covers: the session, the
 * PostgREST query builder, RLS filtering reads down to what a role may see, and
 * every screen's handling of a database that is nearly empty — the live project
 * has the real route and almost no figures, which is a state no offline run has
 * ever shown.
 *
 * ---------------------------------------------------------------------------
 * READ ONLY. Deliberately, and permanently.
 *
 * This runs against the client's production database. Every step here reads.
 * Nothing adds an order, declares production, edits a master or marks
 * attendance — the offline suite does all of that, because there it is throwing
 * away a database that lives in one browser tab.
 *
 * If a write ever needs proving against Supabase it belongs on a scratch
 * project, not here. A test that quietly seasons a client's live order book
 * with SO/26-27/0999 is worse than no test at all.
 * ---------------------------------------------------------------------------
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.argv[4] ?? 'http://localhost:5173'
const outDir = 'screenshots/hosted'
const [email, password] = process.argv.slice(2)

await mkdir(outDir, { recursive: true })

/*
 * Start the dev server if nobody else has.
 *
 * The first version of this told you to run `npm run dev:hosted` in another
 * terminal first. That is one instruction too many: a dev server prints its
 * banner and then sits there, which reads as nothing happening, and forgetting
 * it produced fourteen ERR_CONNECTION_REFUSED lines that said nothing about
 * what was actually wrong. One command, or it will be got wrong.
 */
async function alive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

let server = null
if (await alive(baseUrl)) {
  console.log(`Using the server already on ${baseUrl}\n`)
} else {
  console.log('Starting the hosted dev server…')
  server = spawn('npx', ['vite', '--mode', 'hosted', '--port', '5173'], {
    stdio: 'ignore',
    detached: false,
  })
  const startedBy = Date.now() + 60_000
  while (!(await alive(baseUrl))) {
    if (Date.now() > startedBy) {
      server.kill()
      console.error(
        `\nThe dev server never came up on ${baseUrl}.\n` +
          'Run `npm run dev:hosted` by hand to see why — most likely\n' +
          '.env.hosted.local is missing its URL or anon key.',
      )
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log(`Hosted build serving on ${baseUrl}\n`)
}

/** Always put the server back the way we found it. */
function stopServer() {
  if (server && !server.killed) server.kill()
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()

/*
 * Console noise is the whole point of running a browser at all — a failed
 * PostgREST call surfaces here and nowhere else. Collected per step so a
 * message is reported against the screen that caused it.
 */
let errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

let failed = 0

/*
 * `allow` exists for one honest case: a step that deliberately provokes a
 * failure. Rejecting a bad password *is* a 400 from the auth endpoint, and the
 * browser logs every non-2xx fetch as a console error — so without this the
 * check would report the security behaviour it is testing as a defect. It is
 * deliberately a narrow regex per step rather than a global mute.
 */
async function step(name, fn, { allow } = {}) {
  errors = []
  process.stdout.write(`${name.padEnd(28)} `)
  try {
    const note = await fn()
    const unexpected = allow ? errors.filter((e) => !allow.test(e)) : errors
    if (unexpected.length) throw new Error(`console: ${unexpected[0].slice(0, 120)}`)
    console.log(note ? `ok — ${note}` : 'ok')
  } catch (e) {
    failed += 1
    console.log(`FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    await page
      .screenshot({ path: `${outDir}/${name.replace(/\W+/g, '-')}-failed.png` })
      .catch(() => {})
  }
}

// --- the build is actually the hosted one ----------------------------------

await step('hosted build', async () => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Sign in', { timeout: 60_000 })

  // The offline build never shows a login screen, so reaching one is itself the
  // proof that VITE_SUPABASE_URL was set and the Supabase backend was chosen.
  // Without this check the whole run could pass against PGlite and mean nothing.
  const offline = await page.locator('text=Offline draft').count()
  if (offline) throw new Error('this is the offline build — dev:hosted not running?')
  await page.screenshot({ path: `${outDir}/login.png`, fullPage: true })
  return 'login screen, and it is not the offline build'
})

await step('bad credentials refused', async () => {
  await page.fill('input[type=email]', 'nobody@example.com')
  await page.fill('input[type=password]', 'not-a-password')
  await page.click('button:has-text("Sign in")')

  // The friendly wording, not Supabase's. lib/auth.ts rewrites "Invalid login
  // credentials" deliberately: a shop floor does not need the difference
  // between a wrong password and an unknown address, and telling them would
  // confirm which addresses exist. So the raw string leaking through is itself
  // a defect, and this asserts both halves.
  await page.waitForSelector('text=do not match', { timeout: 30_000 })
  const body = await page.locator('body').innerText()
  if (/invalid login credentials/i.test(body)) {
    throw new Error("Supabase's raw error reached the screen")
  }
  const through = await page.locator('text=Bottleneck utilisation').count()
  if (through) throw new Error('a bad password reached the application')
  return 'rejected in plain English, and the door stayed shut'
}, { allow: /status of 400|auth\/v1\/token/ })

if (!email || !password) {
  console.log('\nNo credentials given — stopped at the login screen.')
  console.log('Everything behind it is unverified: pass <email> <password> to go on.')
  await browser.close()
  stopServer()
  process.exit(failed ? 1 : 0)
}

// --- signed in, every screen renders against Supabase -----------------------

await step('sign in', async () => {
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button:has-text("Sign in")')

  // Whichever comes first. Waiting only for success meant a wrong password sat
  // for sixty seconds and then reported a timeout, which says nothing about
  // the password being wrong.
  const outcome = await Promise.race([
    page
      .waitForSelector('text=Bottleneck utilisation', { timeout: 60_000 })
      .then(() => 'in'),
    page
      .waitForSelector('text=do not match', { timeout: 60_000 })
      .then(() => 'refused'),
    page
      .waitForSelector('text=no roles', { timeout: 60_000 })
      .then(() => 'no roles'),
  ])
  if (outcome === 'refused') throw new Error('that email and password do not match')
  if (outcome === 'no roles') {
    throw new Error('the account signed in but has no roles — grant some on Users')
  }
  return 'session established, command centre rendered'
}, { allow: /status of 400|auth\/v1\/token/ })

// Nothing below can pass without a session, and fourteen more failures would
// bury the one line that matters.
if (failed) {
  console.log('\nStopped: everything below needs a session.')
  await browser.close()
  stopServer()
  process.exit(1)
}

const SCREENS = [
  ['', 'command-centre', 'Bottleneck utilisation'],
  ['#/dashboard', 'dashboard', 'Is the factory on track today?'],
  ['#/heatmap', 'heatmap', 'Load heatmap'],
  ['#/gantt', 'schedule', 'Manual pins'],
  ['#/orders', 'order-book', 'Order book'],
  ['#/accept', 'acceptance', 'Can we take this order?'],
  ['#/whatif', 'what-if', 'Try a change'],
  ['#/wip', 'wip', 'Ready to stuff'],
  ['#/board', 'department-board', 'What you owe'],
  ['#/production', 'production', 'What you were asked for'],
  ['#/manpower', 'manpower', 'Who is in'],
  ['#/capacity', 'capacity-sheet', 'Capacity sheet'],
  ['#/masters', 'masters', 'Production route'],
  ['#/users', 'users', 'Roles'],
]

for (const [hash, name, waitFor] of SCREENS) {
  await step(name, async () => {
    await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`text=${waitFor}`, { timeout: 60_000 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true })
  })
}

// --- the live project's own shape, which no offline run has ever shown ------

await step('the real route is there', async () => {
  await page.goto(`${baseUrl}/#/capacity`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Capacity sheet', { timeout: 60_000 })
  await page.waitForTimeout(1200)

  const rows = await page.locator('[data-testid="capacity-grid"] tbody tr').count()
  if (rows < 10) throw new Error(`only ${rows} articles — is this the right project?`)

  // The state the offline demo can never show: a real route carrying almost no
  // figures. Every screen has to hold up on it, because it is what U&M see on
  // day one and it stays that way until PPC send the sheet back.
  const text = await page.locator('body').innerText()
  if (!/Articles routed/.test(text)) throw new Error('the progress figures are missing')
  return `${rows} articles against the live project`
})

await step('an empty plan says so', async () => {
  await page.goto(`${baseUrl}/#/wip`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Ready to stuff', { timeout: 60_000 })
  await page.waitForTimeout(900)

  // With no orders and no rates there is nothing in progress. That has to read
  // as "nothing here yet" rather than as a broken screen — an empty state is
  // the first thing every real user will meet, and the only place it has ever
  // been seen is the offline build with data in it.
  const text = await page.locator('body').innerText()
  if (/NaN|undefined|\[object/.test(text)) {
    throw new Error('an empty database is rendering as a defect')
  }
  return 'empty, and legible'
})

await step('sign out', async () => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Bottleneck utilisation', { timeout: 60_000 })
  await page.click('button:has-text("Sign out")')
  await page.waitForSelector('text=Sign in', { timeout: 30_000 })
  return 'session ended'
})

await browser.close()
stopServer()
console.log(
  failed
    ? `\n${failed} failed. Screenshots in ${outDir}/`
    : `\nAll checks passed. Screenshots in ${outDir}/`,
)
process.exit(failed ? 1 : 0)
