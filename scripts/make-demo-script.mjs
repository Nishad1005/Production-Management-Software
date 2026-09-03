/**
 * Writes the demonstration script, with the live project's own numbers in it.
 *
 *   node scripts/make-demo-script.mjs <email> <password> [out.html]
 *   node scripts/make-pdf.mjs docs/demo-script.html
 *
 * ---------------------------------------------------------------------------
 * Why this is generated rather than written.
 *
 * The first demo script was written by hand on 20 Aug and was wrong by the end
 * of the month: six phases had shipped, the interim data had gone in, and every
 * figure in it named a factory that no longer existed.
 *
 * The numbers move on their own, too, which is the harder problem. Breach
 * severity is `days_out < 15` against today's date, so a warning becomes a
 * critical overnight with nothing changing in the database. Shipment risk bands
 * shift as stuffing dates approach. A script quoting "18 breaches, some
 * critical" was true on 30 Aug and false on 2 Sept.
 *
 * Standing in front of a client reading a figure the screen contradicts is the
 * worst version of this project's own recurring failure — being wrong in a way
 * that looks normal. So the script is regenerated from the live project, and it
 * stamps the moment it was generated at the top.
 *
 * ---------------------------------------------------------------------------
 * Who it is written for, as of 3 Sept: a presenter and an audience who know
 * factories and do not know software. Every spoken line is in the language of
 * the floor — days, crews, containers, rejections — and every instruction says
 * which word to click. Where a screen is empty because U&M have not supplied
 * the data behind it, the script says what to say so that "empty" lands as
 * "built and waiting for you" rather than "broken".
 *
 * ---------------------------------------------------------------------------
 * Read-only. It signs in, reads, and writes a file.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const [email, password, outArg] = process.argv.slice(2)
const out = outArg ?? `${repoRoot}docs/demo-script.html`

if (!email || !password) {
  console.error('Usage: make-demo-script.mjs <email> <password> [out.html]')
  process.exit(1)
}

const text = await readFile(`${repoRoot}.env.hosted.local`, 'utf8').catch(() => {
  throw new Error('.env.hosted.local not found — this reads the hosted project.')
})
const env = Object.fromEntries(
  text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { error: signInError } = await db.auth.signInWithPassword({ email, password })
if (signInError) {
  console.error(`Sign in failed: ${signInError.message}`)
  process.exit(1)
}

/**
 * Reads a view whole.
 *
 * PostgREST returns at most a thousand rows and reports no error when it stops.
 * The first version of this script read `heatmap_cell` in one call, got the
 * first thousand of its two thousand rows, and printed *7 departments × 174
 * days* into a script somebody was going to read aloud in front of the client
 * whose screen says fourteen. The application was fixed for exactly this on
 * 30 Aug; the scripts carry their own client and were not.
 */
const PAGE = 1000
const rows = async (view, select = '*', shape = (q) => q) => {
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await shape(
      db.from(view).select(select).range(from, from + PAGE - 1),
    )
    if (error) throw new Error(`${view}: ${error.message}`)
    all.push(...(data ?? []))
    if (!data || data.length < PAGE) return all
    if (from > PAGE * 100) throw new Error(`${view}: refusing to page past ${from}`)
  }
}

// --- what the factory looks like right now ---------------------------------
const [run] = await rows('run_history', '*', (q) => q.eq('is_current', true))
if (!run) {
  console.error(
    'No current schedule run on the live project. Run one from the command ' +
      'centre first — a script describing an empty plan helps nobody.',
  )
  process.exit(1)
}

const articles = await rows('article_list', 'code', (q) => q.eq('is_active', true))
const departments = await rows('department_master', 'code,headcount,is_active')
const activeDepartments = departments.filter((d) => d.is_active)
const headcount = activeDepartments.reduce((n, d) => n + (d.headcount ?? 0), 0)
const orders = await rows('order_book', 'erp_order_no')
const provisional = await rows('provisional_state')
const bottleneck = await rows('schedule_bottleneck', '*', (q) =>
  q.eq('run_id', run.id).order('bottleneck_rank').limit(3),
)
const [readiness] = await rows('forecast_readiness')
const risk = await rows('shipment_risk', 'band')
const heatmap = await rows('heatmap_cell', 'department_code,load_date', (q) =>
  q.eq('run_id', run.id),
)
const wip = await rows('wip_by_order', 'erp_order_no,stuffing_date')
const quality = await rows('quality_by_department')
const machines = await rows('machine_master')
const materials = await rows('material_shortage', 'status')
const edges = (await rows('route_dependency_grid', 'feeds')).filter((e) => e.feeds)

const BRANCHES = [
  ['attention_breach', 'work that cannot be made as planned'],
  ['attention_overloaded', 'departments over capacity'],
  ['attention_route_conflict', 'D-minus contradicting the route'],
  ['attention_material_late', 'material past its ordering date'],
  ['attention_material_short', 'material short against stock'],
  ['attention_machine_down', 'machines down'],
  ['attention_article_unplannable', 'articles that cannot be scheduled'],
  ['attention_handover', 'handovers not yet counted in'],
  ['attention_department_unstaffed', 'departments with nobody on a shift'],
]
const findings = []
for (const [view, what] of BRANCHES) {
  const r = await rows(view, 'severity')
  findings.push({
    view,
    what,
    total: r.length,
    critical: r.filter((x) => x.severity === 'critical').length,
  })
}
const criticals = findings.reduce((n, f) => n + f.critical, 0)
const warnings = findings.reduce((n, f) => n + (f.total - f.critical), 0)
const handovers = findings.find((f) => f.view === 'attention_handover')?.total ?? 0
const conflicts =
  findings.find((f) => f.view === 'attention_route_conflict')?.total ?? 0

// The heatmap draws a full rectangle — every department across every day
// between the first and the last — and fills the gaps. The row count is
// smaller. Quoting the row count at somebody looking at the grid is a figure
// they cannot find on their screen, so both are worked out and the grid's is
// the one the script says out loud.
const days = [...new Set(heatmap.map((c) => c.load_date))].sort()
const span =
  days.length > 1
    ? Math.round(
        (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000,
      ) + 1
    : days.length
const heatDepartments = new Set(heatmap.map((c) => c.department_code)).size
const bands = {}
for (const x of risk) bands[x.band] = (bands[x.band] ?? 0) + 1

const ship = [...new Set(wip.map((w) => w.stuffing_date))].sort()
const longDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      })
    : '—'

// The one department that has declared production so far, for the quality and
// forecast beats. Null-safe throughout: on a project purged back to masters the
// script must still generate, saying "nothing declared yet" in each place.
const q0 = quality[0] ?? null

const cells = articles.length * activeDepartments.length
const esc = (v) =>
  String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const n = (v) => Number(v).toLocaleString('en-IN')
const runSecs = Math.round(run.duration_ms / 1000)
const stamp = new Date().toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const ago = Math.round((Date.now() - Date.parse(run.run_at)) / 86_400_000)

/**
 * One beat of the demonstration.
 *
 * `nav` is the exact word in the menu bar, because the presenter may not be the
 * person who built the software. `doThis` is a physical action worth making in
 * front of the room; `say` is spoken; `asks` are the questions the screen tends
 * to provoke. `skip` marks the beats to drop when time is short, and `caution`
 * carries the one warning that must not be skipped even if the beat is.
 */
const screen = ({ nav, title, mins, skip, caution, onScreen, doThis, say, asks = [] }) => `
      <section class="beat">
        <div class="beat__bar">
          <span class="beat__nav">${esc(nav)}</span>
          <span class="beat__title">${title}</span>
          <span class="beat__meta">${skip ? '<span class="skiptag">skip if short of time</span>' : ''}${mins ? `<span class="mins">~${mins} min</span>` : ''}</span>
        </div>
        <div class="beat__body">
          <div class="onscreen">
            <div class="onscreen__t">On screen</div>
            <div>${onScreen}</div>
          </div>
          ${caution ? `<div class="caution">${caution}</div>` : ''}
          ${doThis ? `<div class="doline"><span class="doline__t">Do</span><span>${doThis}</span></div>` : ''}
          <div class="say">${say}</div>
          ${
            asks.length
              ? `<div class="asks"><div class="asks__t">If they ask</div>${asks
                  .map((a) => `<p class="q">${a.q}</p><p class="a">${a.a}</p>`)
                  .join('')}</div>`
              : ''
          }
        </div>
      </section>`

const part = (num, title, blurb) => `
      <div class="part">
        <div class="part__n">Part ${num}</div>
        <h2>${title}</h2>
        <p class="lede">${blurb}</p>
      </div>`

// ---------------------------------------------------------------------------
// The walkthrough. Twenty screens in five parts, ordered as a story: what the
// factory has promised, whether it can keep it, what the floor does all day,
// what it costs, and where every number comes from. The short version — when
// the meeting is half the length promised — is the beats without a skip tag.
// ---------------------------------------------------------------------------
const body = `
${part(1, 'The promise, and whether it can be kept', `Four screens that show the whole factory at once. This is the half that must land — everything after it is supporting detail.`)}

${screen({
  nav: 'Command centre',
  title: 'The whole factory in four numbers',
  mins: 4,
  onScreen: `<strong>${n(orders.length)}</strong> shipment lines · <strong>${n(run.task_count)}</strong> scheduled jobs · <strong>${n(run.breach_count)}</strong> that cannot be done in the time available · <strong>${esc(bottleneck[0]?.department_name ?? '—')}</strong> named as the tightest department. On the right, a short list of the days that are overloaded, each labelled with what can still be done about it.`,
  say: `“This is the whole factory on one page. Along the top: how many container loads you have promised, how many jobs that breaks into across your departments, and — in red — how many of those jobs do not fit in the time available.<br /><br />Below, the system names your tightest department. That is where an extra pair of hands or an extra machine helps the whole factory, rather than just one room.<br /><br />And on the right, the days that are overloaded — sorted by how much warning you still have. Something three months away says <em>overtime or subcontract would fix this</em>. Something next week says <em>this needs a phone call to the customer</em>. The label tells you what is still physically possible; the decision stays with you.”`,
  asks: [
    {
      q: 'Who decided those labels?',
      a: 'Arithmetic, not opinion. With 45 days of notice you can hire; with 15 you can run overtime; with less, the only honest option left involves the customer. The thresholds are written down and can be changed.',
    },
    {
      q: `How fresh is this?`,
      a: `It is a snapshot, replanned on demand. Pressing the dark button redoes the whole plan from scratch — it takes about ${runSecs} seconds because it genuinely recalculates every job in the factory, and every version is kept, so last month's plan can always be pulled back and compared with what actually happened.`,
    },
  ],
})}

${screen({
  nav: 'Load heatmap',
  title: 'Six months of work, coloured in',
  mins: 3,
  onScreen: `A grid: <strong>${n(heatDepartments)}</strong> departments down the side, <strong>${n(span)}</strong> days across. Light green is partly busy, dark green is full, red is overloaded.`,
  doThis: `Scroll sideways slowly, then click one red cell and let the panel underneath open.`,
  say: `“Every square is one department on one day. The darker it is, the fuller that day already is. Red means the day holds more work than there are hours.<br /><br />A department often makes several different things at once, so the software adds up the <em>share of the day</em> each job takes rather than the pieces — you cannot add chairs to cushions, but you can add the hours they take. When those shares add up past a full day, the square goes red.<br /><br />Click a red square and it tells you exactly which orders are on top of each other that day.”`,
})}

${screen({
  nav: 'Schedule',
  title: 'Where every date comes from',
  mins: 3,
  onScreen: `A horizontal bar for each order at each department, laid out on a calendar.`,
  doThis: `Point at one order's bars and trace them right to left, ending at the ship date. If you drag a bar, that is fine — it goes into the practice data and is removed with it.`,
  say: `“Nobody typed any of these dates in. The software starts from the day the container must be stuffed and works <em>backwards</em>: packing must finish three days before the container, final checking a week before, stitching twenty-six days before, and so on — using the day-counts your own planning team will give us for each product.<br /><br />If a planner knows better — a buyer visit, a material delay — they drag the bar. The plan reshuffles itself around that decision and remembers it. The software never quietly undoes what a person decided.”`,
})}

${screen({
  nav: 'Attention',
  title: 'The to-do list the software writes for itself',
  mins: 4,
  onScreen: `<strong>${n(criticals)}</strong> red items and <strong>${n(warnings)}</strong> amber ones, most urgent first. Each one is a sentence, and clicking it opens the screen where it can be fixed.`,
  say: `“Everything the software has noticed, in one list, in plain sentences — this order cannot be made in time, this department is overloaded on this date, this material should have been ordered by now. The red ones need an answer today.<br /><br />Two things are deliberate here. Every line takes you straight to the screen that fixes it. And there is <em>no way to dismiss one</em> — an alert you can silence while it is still true becomes wallpaper within a week, and then nobody reads any of them.”`,
  asks: [
    {
      q: `Why are ${n(conflicts)} of them the same complaint?`,
      a: `Because the software has caught a genuine contradiction, and it is the first question we have for your team today: our records show machining feeding ply cutting, and the day-counts say the opposite. One of them is wrong. Whoever runs production can settle it in a sentence, and ${n(conflicts)} red items disappear — this is the software doing exactly its job.`,
    },
  ],
})}

${part(2, 'Taking new work in', `What merchandising does with it: see what is promised, test an order before saying yes, and try changes without touching the real plan.`)}

${screen({
  nav: 'Order book',
  title: 'Everything currently promised',
  mins: 2,
  onScreen: `<strong>${n(orders.length)}</strong> orders, shipping between <strong>${esc(longDate(ship[0]))}</strong> and <strong>${esc(longDate(ship[ship.length - 1]))}</strong>. All of them begin with PROV-, meaning they are practice orders we invented.`,
  say: `“The order book — every promise the plan is built on. These twelve are practice orders we made up so you could see the software working; the moment your real orders go in, ours come out with one command.<br /><br />An order here is not one line: an order shipping in two containers is two separate problems with two separate dates, and the software treats it that way.”`,
})}

${screen({
  nav: 'Accept an order',
  title: 'Can we say yes to this?',
  mins: 3,
  skip: true,
  caution: `<strong>This takes about ${runSecs + 5} seconds to answer.</strong> It is genuinely re-planning the entire factory with the new order added, which is why. Either start it and keep talking, or skip this screen and describe it — do not stand in silence.`,
  onScreen: `A product, a quantity, a ship date, and a Check button.`,
  doThis: `Only if you have time in hand: pick any product, type 250, pick a date about three months out, press Check, and keep talking while it works.`,
  say: `“The question merchandising actually has: a buyer wants 250 of this by mid-December — can we say yes?<br /><br />Most systems answer that against an empty factory. This one pretends the order is real, replans the whole factory with it in, and tells you which departments would break and by how much — <em>given everything you have already promised everyone else</em>. Then it throws the pretend order away. Nothing is committed by checking.”`,
})}

${screen({
  nav: 'What if',
  title: 'Try a change without committing to it',
  mins: 2,
  skip: true,
  onScreen: `A department, a date range, and a dial for more or less capacity. The result appears beside the live plan.`,
  say: `“The other daily question: if we put four more people in stitching for a fortnight, what happens to the dates? This tries it on a copy. The real plan is untouched unless you decide to keep the result.”`,
})}

${part(3, 'The floor', `The screens for supervisors and department heads — where what actually happened gets written down, and why that matters to every date in the plan.`)}

${screen({
  nav: 'My department',
  title: 'One department&rsquo;s day',
  mins: 2,
  skip: true,
  onScreen: `Pick a department at the top. Three lists: what it owes today, what it is waiting on from the department before it, and what it has sent onward.`,
  doThis: `Pick Stitching — the tightest department is the interesting one.`,
  say: `“What a department head sees in the morning: what you owe today, what you are still waiting to receive from the previous department, and what you have handed on. No numbers to interpret — a work list.”`,
})}

${screen({
  nav: 'Production',
  title: 'Writing down what was made',
  mins: 3,
  onScreen: `Today's expected work for a chosen department, with boxes for good pieces and rejected pieces.`,
  doThis: `Declare a small quantity against any job — say 20 good, 1 rejected. It goes into the practice data.`,
  say: `“This is the most important screen in the building, and the least glamorous. At the end of the day — or the shift — a supervisor writes down what was actually made: good pieces and rejected pieces, per product.<br /><br />Everything else you have seen today gets smarter because of this screen. The plan compares itself to it. The quality figures come from it. And over time the software learns what each department <em>really</em> achieves in a day, as against what the planning sheet claims. It is built for a phone, thumb-sized, so it can be done standing on the floor.”`,
  asks: [
    {
      q: 'What if the next department disagrees with the count?',
      a: `They count it in when they receive it. A handover is not settled until the receiving side has accepted it — right now there are ${n(handovers)} handovers declared and not yet counted in, and the software lists every one rather than assuming.`,
    },
  ],
})}

${screen({
  nav: 'WIP',
  title: 'Where everything is, right now',
  mins: 2,
  skip: true,
  onScreen: `Every order, opened out across all ${n(heatDepartments)} departments: done, busy, waiting, not started.`,
  say: `“Work in progress — the answer to <em>where is my order?</em> without walking the floor. Each order is a row; each department a step; you can see exactly how far every container's worth of work has travelled.”`,
})}

${screen({
  nav: 'Manpower',
  title: 'Who came in — and the plan notices',
  mins: 3,
  onScreen: `${n(activeDepartments.length)} departments with a sanctioned crew of <strong>${n(headcount)}</strong> people in total. Today's attendance is unmarked, so it shows everyone expected.`,
  doThis: `Mark one person in Stitching as absent, then flick back to the Load heatmap: that department's day just got smaller.`,
  say: `“Attendance, but connected. A stitching rate of thirty-eight a day was measured with twenty-two people at the tables. If only nineteen come in, the honest capacity for the day is smaller — and the plan should know, not just the register.<br /><br />So marking one absentee here quietly shrinks that department's day everywhere else in the software. Overtime is recorded here too, as hours actually worked, so the extra capacity is real rather than assumed.”`,
})}

${screen({
  nav: 'Quality',
  title: 'What gets rejected, and where',
  mins: 2,
  skip: true,
  onScreen: q0
    ? `One department has declared so far: <strong>${esc(q0.department_name)}</strong> — ${n(q0.qty_good)} good, ${n(q0.qty_rejected)} rejected, a ${q0.rejection_pct}% rejection rate against the ${n(q0.planned_yield_pct)}% yield the plan assumes.`
    : `Empty — nothing has been declared with rejections yet.`,
  say: `“Every rejection written on the Production screen lands here, sorted by department and by cause. The plan assumes each department loses a couple of percent — that is why earlier departments are asked to make slightly more than the order needs. This screen shows whether that assumption is honest.${q0 ? ` From the practice declarations, ${esc(q0.department_name)} is running at ${q0.rejection_pct}% rejected — better than the plan assumed. When it is your data, that comparison is the interesting one.` : ''}”`,
})}

${screen({
  nav: 'Floor display',
  title: 'The screen for the wall',
  mins: 1,
  skip: true,
  onScreen: `Full-screen, big type, no menus: what this department owes today, what it is waiting on, who is in.`,
  say: `“Made for a TV on the department wall. It refreshes itself; nobody logs in or touches it. The department sees its own day the way the planner sees the factory.”`,
})}

${part(4, 'Money and material', `Two screens that are built, tested, and empty — because the data behind them is item 4 on the sheet you are leaving with them. Say that with confidence, not apology.`)}

${screen({
  nav: 'Material',
  title: 'What to buy, and when — waiting on your parts lists',
  mins: 2,
  onScreen: `${materials.length === 0 ? 'Empty, and it says why.' : `${n(materials.length)} materials tracked.`}`,
  say: `“This screen takes the plan and turns it into purchasing: what the factory is committed to buying, week by week, and — in red — anything already past the date it should have been ordered, counting backwards from when production needs it.<br /><br />It is empty for one reason only: it needs to know what each product is made of — the foam, the fabric, the fittings — and nobody has given us that yet. Give us the parts list for <em>one</em> product and this screen switches on for it the same day.”`,
})}

${screen({
  nav: 'Money',
  title: 'Cash out against the plan — waiting on your costs',
  mins: 1,
  skip: true,
  onScreen: `Empty, and it says why.`,
  say: `“The same plan, priced: what the factory spends week by week to keep the promises in the order book. It needs a cost per product, and it will not guess one — a made-up rupee figure with real dates around it is the most dangerous number in the building. One product's cost switches it on.”`,
})}

${part(5, 'Where the numbers live, and the close', `End on the two honest screens: the sheet every other number came from, and the screen that refuses to guess.`)}

${screen({
  nav: 'Capacity sheet',
  title: 'The sheet everything else is arithmetic on',
  mins: 3,
  onScreen: `<strong>${n(cells)}</strong> boxes — ${n(articles.length)} products across ${n(activeDepartments.length)} departments — every one filled in by us, and labelled as such.`,
  say: `“This is the honest moment of the day. Every screen you have seen is arithmetic on this sheet: how many of each product each department can make in a day, and how many days before the container each must finish.<br /><br /><strong>Every number in it is ours, not yours.</strong> We invented them so the software had something to chew on — and deliberately crudely: it currently believes a dining chair and an ottoman take the same effort, and anyone who knows your floor spotted that within a minute of sitting down. That is exactly the reaction we want, pointed at every wrong number.<br /><br />Your planning team gets this as an ordinary Excel sheet in a layout they already use. When it comes back, it replaces our numbers box by box — a partly-filled sheet is genuinely useful, and it can come back more than once.”`,
  asks: [
    {
      q: `${n(cells)} boxes — how long will that take?`,
      a: `Less than it sounds. A rate that is the same across a whole family of products is filled once and copied down. And the day-count column is one number per department for most products. The session with your planning team is half a day, not a week.`,
    },
  ],
})}

${screen({
  nav: 'Masters',
  title: 'The route, the machines, and one question',
  mins: 2,
  onScreen: `The ${n(activeDepartments.length)} departments, the ${n(edges.length)} arrows saying which feeds which, and the machine list — currently empty, item 4 on the sheet.`,
  doThis: `Open the dependency grid and point at the ply cutting / machining cell.`,
  say: `“Everything the factory <em>is</em> lives here — departments, products, shifts, what feeds what. It is where the question from the Attention screen gets settled: this one tick says machining feeds ply cutting, the day-counts say the reverse, and whichever of you runs production can tell us which is true. Untick it and ${n(conflicts)} red items vanish.”`,
})}

${screen({
  nav: 'Users',
  title: 'Who sees what',
  mins: 1,
  skip: true,
  onScreen: `The accounts, and twelve roles — planner, merchandiser, department head, store, quality, and so on.`,
  say: `“Each of your people gets their own login carrying only the roles they need, and the locking is done in the database itself — it holds no matter how the system is reached. What we need from you is names, and one decision: should a department head see other departments' figures, or only their own?”`,
})}

${screen({
  nav: 'Forecast',
  title: 'The screen that refuses to guess',
  mins: 3,
  onScreen: `Its first panel: <strong>${n(readiness?.declarations ?? 0)}</strong> production entries across <strong>${n(readiness?.days_recorded ?? 0)}</strong> days so far. Below, nearly every figure reads <em>too few to say</em>.`,
  say: `“I want to finish here, on the screen that mostly declines to answer.<br /><br />In time this page will tell you what each department <em>really</em> achieves per day, how long each product <em>really</em> takes end to end, and which shipments look like missing their container. But it has a rule: under ten days of real history it says <em>too few to say</em> and shows you the count instead of a number — because a prediction from two days and one from two hundred look identical on a screen, and only one of them deserves to be acted on.<br /><br />Every screen you have seen today is built on that same principle. Where this software does not know, it says so — it never fills the gap with something plausible. That is the property you are actually buying.”`,
  asks: [
    {
      q: 'When does it start answering?',
      a: `On its own, about ten working days after your floor starts writing down production. There are ${n(readiness?.days_recorded ?? 0)} days of practice entries in it now. Nothing to configure — it earns each number as the history arrives.`,
    },
  ],
})}`

const totalCriticalNote =
  conflicts > 0
    ? `${n(criticals)} of the red items trace back to one route question — decide before the meeting whether to leave it in and open with it, or untick it (Masters → dependency grid) and re-run.`
    : `No route conflicts are open.`

const html = `<title>Kram — Demonstration script</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  /* Kram's own register, as the request notes carry it, so a folder of these
     reads as one set of documents. */
  :root {
    --paper: #e9edf1; --sheet: #ffffff; --ink: #16202e; --mid: #5c6b7a;
    --faint: #8996a4; --rule: #c9d3dc; --rule-soft: #dfe6ec;
    --blue: #2c4a6e; --amber: #b07d1a; --flag: #c4462e; --bar-text: #ffffff;
    --sans: 'Archivo', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      --paper: #0f151d; --sheet: #16202e; --ink: #e6ecf2; --mid: #a3b1c0;
      --faint: #7e8d9d; --rule: #2c3a4b; --rule-soft: #223044;
      --blue: #8fb4dc; --amber: #d9a441; --flag: #e8705c;
    }
  }
  :root[data-theme='dark'] {
    --paper: #0f151d; --sheet: #16202e; --ink: #e6ecf2; --mid: #a3b1c0;
    --faint: #7e8d9d; --rule: #2c3a4b; --rule-soft: #223044;
    --blue: #8fb4dc; --amber: #d9a441; --flag: #e8705c;
  }

  body { background: var(--paper); color: var(--ink); font-family: var(--sans);
    font-size: 16px; line-height: 1.62; -webkit-font-smoothing: antialiased; }
  .doc { max-width: 58rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem;
    display: flex; flex-direction: column; gap: 1.9rem; }

  .head { background: var(--sheet); border: 1px solid var(--rule); }
  .head__main { padding: 1.7rem 1.5rem 1.4rem; }
  .firm { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.15em;
    text-transform: uppercase; color: var(--faint); }
  h1 { font-size: clamp(1.9rem, 5vw, 2.7rem); line-height: 1.05; margin: 0.4rem 0 0.55rem;
    letter-spacing: -0.028em; font-weight: 700; text-wrap: balance; }
  .sub { color: var(--mid); margin: 0; max-width: 52ch; font-size: 1.03rem; }
  dl.stamp { margin: 0; display: grid; grid-template-columns: auto 1fr;
    border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 0.75rem; }
  dl.stamp dt { padding: 0.45rem 0.9rem; color: var(--faint); text-transform: uppercase;
    font-size: 0.6875rem; letter-spacing: 0.09em; border-bottom: 1px solid var(--rule-soft);
    border-right: 1px solid var(--rule-soft); white-space: nowrap; }
  dl.stamp dd { margin: 0; padding: 0.45rem 0.9rem; border-bottom: 1px solid var(--rule-soft); }

  h2 { font-size: 1.28rem; margin: 0.2rem 0 0; letter-spacing: -0.015em; text-wrap: balance; }
  p { margin: 0; max-width: 70ch; }
  .lede { color: var(--mid); }

  .part { border-left: 3px solid var(--blue); padding: 0.15rem 0 0.15rem 1.1rem;
    margin-top: 1.1rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .part__n { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--blue); }

  .opening { background: var(--sheet); border: 1px solid var(--rule);
    border-left: 3px solid var(--amber); padding: 1.15rem 1.25rem;
    display: flex; flex-direction: column; gap: 0.6rem; }
  .opening__t { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--amber); }
  .opening p { font-size: 1.05rem; }

  .figures { display: grid; gap: 0.7rem; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); }
  .fig { background: var(--sheet); border: 1px solid var(--rule); border-left: 2px solid var(--blue);
    padding: 0.7rem 0.85rem; }
  .fig.flag { border-left-color: var(--flag); }
  .fig__l { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--faint); }
  .fig__v { font-size: 1.5rem; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
  .fig__h { font-size: 0.72rem; color: var(--faint); }

  .beat { background: var(--sheet); border: 1px solid var(--rule); }
  .beat__bar { background: var(--ink); color: var(--bar-text); padding: 0.55rem 1rem;
    display: flex; gap: 0.85rem; align-items: baseline; flex-wrap: wrap; }
  :root[data-theme='dark'] .beat__bar, :root:not([data-theme='light']) .beat__bar { color: #0f151d; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .beat__bar { background: #dbe4ee; } }
  :root[data-theme='dark'] .beat__bar { background: #dbe4ee; }
  .beat__nav { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.11em;
    text-transform: uppercase; opacity: 0.78; }
  .beat__title { font-weight: 600; font-size: 0.97rem; }
  .beat__meta { margin-left: auto; display: flex; gap: 0.6rem; align-items: baseline; }
  .mins { font-family: var(--mono); font-size: 0.65rem; opacity: 0.7; }
  .skiptag { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.08em;
    text-transform: uppercase; border: 1px solid currentColor; padding: 0.1rem 0.35rem;
    opacity: 0.75; }
  .beat__body { padding: 1.05rem 1.1rem; display: flex; flex-direction: column; gap: 0.9rem; }

  .onscreen { border: 1px dashed var(--rule); padding: 0.7rem 0.85rem; font-size: 0.9rem;
    color: var(--mid); }
  .onscreen__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--faint); margin-bottom: 0.2rem; }
  .onscreen strong { color: var(--ink); font-variant-numeric: tabular-nums; }

  .caution { border-left: 3px solid var(--flag); background: color-mix(in srgb, var(--flag) 6%, transparent);
    padding: 0.6rem 0.85rem; font-size: 0.9rem; }

  .doline { display: flex; gap: 0.7rem; align-items: baseline; font-size: 0.92rem; }
  .doline__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--amber); flex: none; padding-top: 0.1rem; }

  .say { border-left: 3px solid var(--blue); padding: 0.1rem 0 0.1rem 1rem;
    font-size: 1.02rem; }

  .asks { border-top: 1px solid var(--rule-soft); padding-top: 0.75rem; }
  .asks__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--faint); margin-bottom: 0.4rem; }
  .q { font-weight: 600; font-size: 0.92rem; margin-top: 0.5rem; }
  .a { font-size: 0.92rem; color: var(--mid); }

  .close { background: var(--sheet); border: 1px solid var(--rule);
    border-left: 3px solid var(--blue); padding: 1.1rem 1.25rem;
    display: flex; flex-direction: column; gap: 0.6rem; }
  ol.asklist, ol.preplist { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.3rem; }

  footer { border-top: 1px solid var(--rule); padding-top: 1rem; color: var(--faint);
    font-family: var(--mono); font-size: 0.7rem; display: flex; justify-content: space-between;
    gap: 1rem; flex-wrap: wrap; }
</style>

<div class="doc">

  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>Demonstration script</h1>
      <p class="sub">Every screen, in the order that tells the story — with the
        figures that will be on each one, read from the live system when this
        was generated. Written to be read aloud; no software knowledge assumed
        on either side of the table.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/07</dd>
      <dt>Client</dt><dd>U&amp;M Designs</dd>
      <dt>Generated</dt><dd>${esc(stamp)}</dd>
      <dt>Plan shown</dt><dd>Run of ${esc(run.run_at.slice(0, 10))}${ago > 0 ? ` · ${ago} day${ago === 1 ? '' : 's'} old` : ''}</dd>
      <dt>Data</dt><dd>${provisional.length ? 'Provisional — placeholder figures' : 'Live figures'}</dd>
      <dt>Full run</dt><dd>~40 min · short version ~20 (skip the tagged beats)</dd>
    </dl>
  </header>

  ${
    ago > 3
      ? `<div class="opening"><div class="opening__t">Before you start</div>
      <p>The plan on screen is <strong>${ago} days old</strong>. Re-run it from the
      command centre and regenerate this script, or the figures below will not
      match what they are looking at.</p></div>`
      : ''
  }

  <div class="figures">
    <div class="fig"><div class="fig__l">Shipment lines</div><div class="fig__v">${n(orders.length)}</div><div class="fig__h">ours, marked PROV-</div></div>
    <div class="fig"><div class="fig__l">Scheduled jobs</div><div class="fig__v">${n(run.task_count)}</div><div class="fig__h">line × dept × component</div></div>
    <div class="fig ${run.breach_count ? 'flag' : ''}"><div class="fig__l">Cannot be made in time</div><div class="fig__v">${n(run.breach_count)}</div><div class="fig__h">breaches on the plan</div></div>
    <div class="fig ${criticals ? 'flag' : ''}"><div class="fig__l">Red items</div><div class="fig__v">${n(criticals)}</div><div class="fig__h">on the Attention screen</div></div>
    <div class="fig"><div class="fig__l">Re-plan takes</div><div class="fig__v">${runSecs}s</div><div class="fig__h">run it before they arrive</div></div>
  </div>

  <div class="close">
    <h2 style="margin-top:0">Thirty minutes before they arrive</h2>
    <ol class="preplist">
      <li><strong>Press <em>Run the schedule</em></strong> on the Command centre (Confirmed + probable) and let its ${runSecs} seconds happen with nobody watching. Do not press it twice, and do not open a second tab while it runs.</li>
      <li><strong>Regenerate this script</strong> so its numbers match the fresh plan: <code>npm run demo:script</code>, then <code>npm run pdf docs/demo-script.html</code>.</li>
      <li><strong>Click through</strong> Command centre → Load heatmap → Attention → Forecast once, so the first click in the room is instant.</li>
      <li><strong>Decide the route question.</strong> ${totalCriticalNote}</li>
      <li><strong>Have the blank capacity workbook</strong> and the printed <strong>KRAM/06</strong> sheet ready to hand over.</li>
    </ol>
    <p class="lede">If anything shows a red banner during the demo: read it aloud
      calmly, press the × on it, and carry on. This software's whole philosophy
      is that it fails out loud instead of pretending — that is a feature you
      can point at, but only if you do not flinch.</p>
  </div>

  <div class="opening">
    <div class="opening__t">Say this first, before any screen</div>
    <p>“Everything you are about to see runs on <strong>your</strong> factory's
      shape — your ${n(activeDepartments.length)} departments, your ${n(articles.length)} products, the order your
      work actually flows in. <strong>None of the numbers are yours yet.</strong>
      The speeds, the day-counts, the crew sizes and the ${n(orders.length)} orders in it
      are ours, invented so you could see the software working while we wait for
      your planning team's figures. There is a banner at the top of every screen
      saying exactly that, and it stays there until your numbers replace ours.</p>
    <p>So when a figure looks wrong to you — and some will — say so. That is the
      most useful thing that can happen in this room today.”</p>
  </div>

${body}

  <div class="close">
    <h2 style="margin-top:0">Close on the six asks</h2>
    <p>They are set out in full in <strong>DBBS/UM/KRAM/06</strong> — hand the
      sheet over rather than talking through it. Name them and stop:</p>
    <ol class="asklist">
      <li><strong>The capacity workbook</strong> — ${n(cells)} boxes, in Excel, from your planning team. Who, and by when?</li>
      <li><strong>What feeds what</strong> — starting with today's question: does machining feed ply cutting?</li>
      <li><strong>One real export file out of Panipuri</strong> — and does it hold a container stuffing date, or only a delivery date?</li>
      <li><strong>A parts list and a cost</strong>, for one product to begin with.</li>
      <li><strong>A floor plan.</strong></li>
      <li><strong>Names and emails</strong>, and who should see what.</li>
    </ol>
    <p>Write down every figure anybody said was wrong, and who said it. That
      list is worth more than the workbook — it is what they will check first
      when the real data lands.</p>
  </div>

  <footer>
    <span>DBBS/UM/KRAM/07 · generated ${esc(stamp)}</span>
    <span>node scripts/make-demo-script.mjs</span>
  </footer>
</div>
`

await writeFile(out, html)
await db.auth.signOut()

console.log(`${out.replace(repoRoot, '')} — written from the live project`)
console.log(
  `  plan of ${run.run_at.slice(0, 10)} (${ago}d old) · ${run.task_count} tasks · ` +
    `${run.breach_count} breaches · ${runSecs}s`,
)
console.log(`  attention: ${criticals} critical, ${warnings} warnings`)
for (const f of findings.filter((x) => x.total)) {
  console.log(`    ${String(f.total).padStart(3)} ${f.what}`)
}
console.log(`  heatmap: ${heatDepartments} departments × ${span} days`)
console.log(`  floor: ${headcount} sanctioned across ${activeDepartments.length} departments · ${readiness?.declarations ?? 0} declarations · ${handovers} handovers open`)
console.log(`  shipments: ${Object.entries(bands).map(([b, c]) => `${c} ${b}`).join(', ') || 'none open'}`)
console.log(`  empty by design: material (${materials.length}), machines (${machines.length})`)
if (ago > 3) {
  console.log(`\n  The plan is ${ago} days old. Re-run it and regenerate before presenting.`)
}
