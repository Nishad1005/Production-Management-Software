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
const departments = await rows('department_master', 'code,is_active')
const activeDepartments = departments.filter((d) => d.is_active)
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

const cells = articles.length * activeDepartments.length
const esc = (v) =>
  String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const n = (v) => Number(v).toLocaleString('en-IN')
const stamp = new Date().toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const ago = Math.round((Date.now() - Date.parse(run.run_at)) / 86_400_000)

/** A screen: what is on it, what to say, and what they will ask. */
const screen = ({ nav, title, onScreen, say, asks = [] }) => `
      <section class="beat">
        <div class="beat__bar">
          <span class="beat__nav">${esc(nav)}</span>
          <span class="beat__title">${title}</span>
        </div>
        <div class="beat__body">
          <div class="onscreen">
            <div class="onscreen__t">On screen</div>
            <div>${onScreen}</div>
          </div>
          <div class="say">${say}</div>
          ${
            asks.length
              ? `<div class="asks"><div class="asks__t">If they ask</div>${asks
                  .map(
                    (a) =>
                      `<p class="q">${a.q}</p><p class="a">${a.a}</p>`,
                  )
                  .join('')}</div>`
              : ''
          }
        </div>
      </section>`

const body = `
${screen({
  nav: 'Command centre',
  title: 'The whole factory in four numbers',
  onScreen: `<strong>${n(orders.length)}</strong> shipment lines · <strong>${n(run.task_count)}</strong> scheduled tasks · <strong>${n(run.breach_count)}</strong> breaches · <strong>${n(bottleneck[0]?.flagged_days ?? 0)}</strong> flagged days on the constraint. Below: <strong>${esc(bottleneck[0]?.department_name ?? '—')}</strong> marked as the constraint at ${Number(bottleneck[0]?.avg_utilisation ?? 0).toFixed(2)} average and ${Number(bottleneck[0]?.peak_utilisation ?? 0).toFixed(2)} peak, then a triaged list of flagged days.`,
  say: `“Four numbers describe the plan. A shipment line is the unit, not the order — one order going into two containers is two problems. A breach is work the plan says cannot be made in the time available. A flagged day is a department asked for more than it can do.<br /><br />The panel on the right sorts those by how much time is left and labels each one with what is <em>still possible</em> at that notice. That is a label, not a recommendation — whether you actually run overtime depends on cash and on the customer, and the system does not know either.”`,
  asks: [
    {
      q: 'Why is Stitching the constraint?',
      a: `Because capacity above the bottleneck is decorative. It is the department with the highest average utilisation across the horizon, so it is where the next person or the next machine goes. It is ranked from ${esc(bottleneck.map((b) => b.department_name).join(', '))} — and it is our invented rates saying so, not yours.`,
    },
    {
      q: 'How long does a re-plan take?',
      a: `${Math.round(run.duration_ms / 1000)} seconds on this data. It is a full re-plan of every line through every department, not a refresh. It will get faster.`,
    },
  ],
})}
${screen({
  nav: 'Load heatmap',
  title: 'The shape of the next six months',
  onScreen: `${n(heatDepartments)} departments across ${n(span)} days. Green is at capacity, red is over. Click any cell for the orders and components on that day.`,
  say: `“Each cell is one department on one day, shaded by how much of the day the planned work consumes. A department can be making several things at once, so the figure is the sum of the fractions of the day each one takes — you cannot add units of legs to units of covers, but you can add the time they take. Anything over 1.00 is more work than there are hours.”`,
  asks: [
    {
      q: 'Can we see what is causing a red day?',
      a: 'Click it. The panel underneath names the orders, the components and the quantity on that department on that day.',
    },
  ],
})}
${screen({
  nav: 'Schedule',
  title: 'Where the dates come from, and moving one',
  onScreen: `A bar per line per department, scheduled backwards from each container stuffing date. Drag one to pin it.`,
  say: `“Nothing here was typed in. Every date is the stuffing date minus your D-minus offset, walked backwards through the route. Drag a bar and the plan re-flows around it, and the pin survives the next run — a planner's decision is not something the software gets to overwrite.<br /><br />Every run writes a new version. Nothing is overwritten, so you can always put last week's plan next to what actually happened.”`,
})}
${screen({
  nav: 'Attention',
  title: 'Everything the software has noticed, in one list',
  onScreen: `<strong>${n(criticals)}</strong> critical, <strong>${n(warnings)}</strong> warnings, critical first and each row linking to the screen that clears it.`,
  say: `“Nothing on this screen is computed twice. Every line is a conclusion another screen already reached, put in one place and sorted by how soon it bites.<br /><br />There is deliberately no way to dismiss one. An alert you can silence while it is still true stops being read within a week.”`,
  asks: [
    {
      q: `Why are there ${n(findings.find((f) => f.view === 'attention_route_conflict')?.total ?? 0)} route conflicts?`,
      a: 'This is the question worth stopping on, and it is item 2 of the sheet you are leaving with them. One route link in the system says Machining feeds Ply Cutting; your D-minus offsets say the opposite. The software is reporting that the route and the offsets disagree, and it needs one of you to say which is right.',
    },
  ],
})}
${screen({
  nav: 'Accept an order',
  title: 'Can we take this?',
  onScreen: `A quantity and a stuffing date in, a yes or no out — against the plan that already exists.`,
  say: `“This answers against a loaded factory, not an empty one. It is the difference between ‘we have the capacity’ and ‘we have the capacity once everything already promised is made’.”`,
})}
${screen({
  nav: 'What if',
  title: 'Try a change without committing to it',
  onScreen: `A department, a date range and a factor. The result sits beside the live plan.`,
  say: `“Add people to Stitching for a fortnight and see what it does to every date in the factory, without touching the live plan. It writes a separate version that is never made current unless you promote it.”`,
})}
${screen({
  nav: 'Capacity sheet',
  title: 'Where every number on every other screen came from',
  onScreen: `<strong>${n(cells)}</strong> cells — ${n(articles.length)} articles across ${n(activeDepartments.length)} departments — every one of them filled in by us.`,
  say: `“This is the honest moment. Everything you have just seen is arithmetic on this sheet, and every figure in it is ours. Nothing on the previous six screens means anything about your factory until PPC replace them.<br /><br />Loading your workbook replaces these cell by cell. Nothing else has to change, and our ${n(provisional[0]?.provisional_orders ?? 0)} orders come out in one command.”`,
  asks: [
    {
      q: 'How long will filling this take?',
      a: `${n(cells)} cells sounds worse than it is — a rate that is the same across a family of articles can be filled once and copied down. A partly-filled sheet is genuinely useful and can come back more than once.`,
    },
  ],
})}
${screen({
  nav: 'Forecast',
  title: 'The screen that refuses to guess',
  onScreen: `Readiness first: <strong>${n(readiness?.declarations ?? 0)}</strong> declarations across <strong>${n(readiness?.days_recorded ?? 0)}</strong> days, and <strong>${n(readiness?.rates_measured ?? 0)} of ${n(readiness?.rates_seen ?? 0)}</strong> rates measured. Below it, every figure reads <em>too few to say</em>.`,
  say: `“Finish here. This screen has a threshold of ${n(readiness?.threshold ?? 10)} observations, and under it, it shows you the count instead of a number.<br /><br />A prediction from two days and a prediction from two hundred look identical on a screen, and only one of them should be acted on. Every other screen in this system is built the same way — when it does not know, it says so rather than filling the gap with something plausible.”`,
  asks: [
    {
      q: 'When will it start predicting?',
      a: `Once ten days of production have been declared against a rate. Today there are ${n(readiness?.days_recorded ?? 0)}. It fills in on its own as the floor uses the system.`,
    },
  ],
})}`

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

  h2 { font-size: 1.28rem; margin: 0.6rem 0 0; letter-spacing: -0.015em; text-wrap: balance; }
  p { margin: 0; max-width: 70ch; }

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
  .beat__body { padding: 1.05rem 1.1rem; display: flex; flex-direction: column; gap: 0.9rem; }

  .onscreen { border: 1px dashed var(--rule); padding: 0.7rem 0.85rem; font-size: 0.9rem;
    color: var(--mid); }
  .onscreen__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--faint); margin-bottom: 0.2rem; }
  .onscreen strong { color: var(--ink); font-variant-numeric: tabular-nums; }

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
  ol.asklist { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.3rem; }

  footer { border-top: 1px solid var(--rule); padding-top: 1rem; color: var(--faint);
    font-family: var(--mono); font-size: 0.7rem; display: flex; justify-content: space-between;
    gap: 1rem; flex-wrap: wrap; }
</style>

<div class="doc">

  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>Demonstration script</h1>
      <p class="sub">Eight screens, in the order that builds the argument. The
        figures below are the ones that will be on the screen — read from the
        live system when this was generated.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/07</dd>
      <dt>Client</dt><dd>U&amp;M Designs</dd>
      <dt>Generated</dt><dd>${esc(stamp)}</dd>
      <dt>Plan shown</dt><dd>Run of ${esc(run.run_at.slice(0, 10))}${ago > 0 ? ` · ${ago} day${ago === 1 ? '' : 's'} old` : ''}</dd>
      <dt>Data</dt><dd>${provisional.length ? 'Provisional — placeholder figures' : 'Live figures'}</dd>
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
    <div class="fig"><div class="fig__l">Shipment lines</div><div class="fig__v">${n(orders.length)}</div><div class="fig__h">ours</div></div>
    <div class="fig"><div class="fig__l">Scheduled tasks</div><div class="fig__v">${n(run.task_count)}</div><div class="fig__h">line × dept × component</div></div>
    <div class="fig ${run.breach_count ? 'flag' : ''}"><div class="fig__l">Breaches</div><div class="fig__v">${n(run.breach_count)}</div><div class="fig__h">cannot be made as planned</div></div>
    <div class="fig ${criticals ? 'flag' : ''}"><div class="fig__l">Critical</div><div class="fig__v">${n(criticals)}</div><div class="fig__h">on Attention</div></div>
    <div class="fig"><div class="fig__l">Re-plan takes</div><div class="fig__v">${Math.round(run.duration_ms / 1000)}s</div><div class="fig__h">run it beforehand</div></div>
  </div>

  <div class="opening">
    <div class="opening__t">Say this first, before any screen</div>
    <p>“Everything you are about to see runs on <strong>your</strong> route —
      your ${n(activeDepartments.length)} departments, your ${n(articles.length)} articles.
      <strong>None of the numbers are yours.</strong> The rates, the
      days-before-shipment, the crew sizes and the ${n(orders.length)} orders in
      it are ours, put there so the system could be used and argued with while
      we wait for PPC's sheet. There is a banner on every screen saying so, and
      it stays until your figures replace them.</p>
    <p>So please tell me where the numbers are wrong. That is the useful part of
      today.”</p>
  </div>

  <h2>The walkthrough</h2>
${body}

  <div class="close">
    <h2 style="margin-top:0">Close on the six asks</h2>
    <p>They are set out in full in <strong>DBBS/UM/KRAM/06</strong> — hand that
      over rather than talking through it. Name them and stop:</p>
    <ol class="asklist">
      <li><strong>PPC's capacity workbook</strong> — ${n(cells)} cells, three numbers each. Who, and by when?</li>
      <li><strong>What feeds what</strong> — and today's version of it: does Machining feed Ply Cutting?</li>
      <li><strong>One real export file out of Panipuri</strong> — and does it hold a stuffing date, or only a delivery date?</li>
      <li><strong>A bill of materials and a cost</strong>, for one article to begin with.</li>
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
    `${run.breach_count} breaches · ${Math.round(run.duration_ms / 1000)}s`,
)
console.log(`  attention: ${criticals} critical, ${warnings} warnings`)
for (const f of findings.filter((x) => x.total)) {
  console.log(`    ${String(f.total).padStart(3)} ${f.what}`)
}
console.log(`  heatmap: ${heatDepartments} departments × ${span} days`)
console.log(`  shipments: ${Object.entries(bands).map(([b, c]) => `${c} ${b}`).join(', ') || 'none open'}`)
if (ago > 3) {
  console.log(`\n  The plan is ${ago} days old. Re-run it and regenerate before presenting.`)
}
