/**
 * The walkthrough's page: DBBS/UM/KRAM/09, as an HTML fragment.
 *
 * `make-walkthrough.mjs` takes the pictures and reads the figures; this turns
 * both into the document. It is a separate module so the words can be read and
 * changed without scrolling past a browser automation script to find them.
 *
 * ---------------------------------------------------------------------------
 * Who it is for.
 *
 * U&M's production and planning people, seeing their own sample in the
 * software for the first time, and whoever is standing beside them showing it.
 * They know the factory far better than we do and have no reason to know what
 * a "breach" or a "D-minus" is. So every stop says where to click, what the
 * numbered things in the picture are, what *their* six products are doing on
 * that screen, and one thing we need them to tell us.
 *
 * Two rules the wording keeps to:
 *
 * - **Every figure is read, not typed.** Counts come from `facts`, which the
 *   capture read off the screen in the same visit as the picture; the worked
 *   example is computed from the sheet itself. A number typed here would be
 *   right on the day it was typed.
 * - **Nothing is claimed about their factory.** The sample runs on a stand-in
 *   rate of forty a day. Every red mark in these pictures follows from that
 *   figure, and the text says so wherever a reader might take one for a
 *   finding.
 */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const day = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const n = (v) => Number(v).toLocaleString('en-IN')
const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`
const list = (items) =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** The sheet's own column headings, short enough to stand on end in a table. */
const SHORT = {
  MACHINING: 'Machining',
  'PLY CUTTING AND ASSEMBLY': 'Ply cut + assembly',
  'WOOD QC': 'Wood QC',
  SANDING: 'Sanding',
  'SANDING QC': 'Sanding QC',
  'WOOD FINISHING AND METAL FINISHING': 'Wood + metal finish',
  'FINISH QC': 'Finish QC',
  CUTTING: 'Cutting',
  STITCHING: 'Stitching',
  'STITCHING QC': 'Stitching QC',
  'FOAM CUTTING-PASTING AND FIBER CUTTING-FILLING': 'Foam + fibre',
  STAPLING: 'Stapling',
  'UPHOLSTERY QC': 'Upholstery QC',
  FITTING: 'Fitting',
  'FINAL QC': 'Final QC',
  'PACKING + OCA QC': 'Packing',
  'EX-FACTORY': 'Ex-factory',
}

/**
 * How many days the sheet leaves each production step: the gap between the
 * last thing feeding it and its own deadline. Worked from the sheet alone, so
 * the example on page two is their arithmetic and not the engine's.
 */
function windows(sheet, row) {
  const days = new Map()
  const kind = new Map()
  sheet.steps.forEach((step, i) => {
    for (const code of step.departments) {
      days.set(code, row.days[i])
      kind.set(code, step.kind)
    }
  })
  const name = new Map(sheet.departments.map((d) => [d.code, d.name]))
  const out = []
  for (const d of sheet.departments) {
    if (kind.get(d.code) !== 'process') continue
    const feeders = sheet.feeds.filter(([, to]) => to === d.code).map(([from]) => from)
    if (!feeders.length) continue
    // The feeder that finishes last is the one with the smallest day-count.
    const last = feeders.reduce((a, b) => (days.get(a) <= days.get(b) ? a : b))
    out.push({
      code: d.code,
      name: name.get(d.code),
      due: days.get(d.code),
      after: name.get(last),
      afterDue: days.get(last),
      gap: days.get(last) - days.get(d.code),
    })
  }
  return out
}

const badge = (i) => `<span class="n">${i}</span>`
const marks = (items) =>
  `<ol class="marks">${items
    .map((text, i) => `<li>${badge(i + 1)}<span>${text}</span></li>`)
    .join('')}</ol>`

function stop({ no, menu, title, shots, items, sample, tell }) {
  return `
  <article class="stop">
    <div class="stop__bar">
      <span class="stop__no">Stop ${no}</span>
      <span class="stop__title">${title}</span>
      <span class="stop__where">Menu &rarr; ${menu}</span>
    </div>
    <div class="stop__body">
      ${shots
        .map(
          (s) =>
            `<figure class="shot${s.tall ? ' shot--tall' : ''}"><img src="walkthrough/${s.file}.png" alt="${esc(s.alt)}" />${
              s.caption ? `<figcaption>${s.caption}</figcaption>` : ''
            }</figure>`,
        )
        .join('')}
      ${marks(items)}
      <div class="pair">
        <div class="sample"><div class="sample__t">With your sample</div><p>${sample}</p></div>
        <div class="tell"><div class="tell__t">Tell us</div><p>${tell}</p></div>
      </div>
    </div>
  </article>`
}

export function walkthroughPage({ facts: f, sheet, site }) {
  const taken = new Date(f.generatedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const rate = sheet.rate_per_day
  const dates = [...new Set(sheet.dispatches)]
  const dispatchDays = `${list(dates.map((d) => String(Number(d.slice(8)))))} ${
    ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][
      Number(dates[0].slice(5, 7))
    ]
  } ${dates[0].slice(0, 4)}`
  const steps = sheet.departments.length

  // --- the worked example: the first row, by hand ---------------------------
  const row = sheet.rows[0]
  const col = row.qty.findIndex((q) => q)
  const qty = row.qty[col]
  const need = qty / rate
  const needDays = Math.ceil(need)
  const gaps = windows(sheet, row)
  const tight = gaps.filter((g) => g.gap < needDays)
  // When real speeds arrive the first order may simply fit. The example then
  // shows its tightest step fitting, rather than failing to build.
  const fits = tight.length === 0
  const first = tight[0] ?? gaps.reduce((p, q) => (q.gap < p.gap ? q : p))
  const others = tight.slice(1)
  const shortName = (r) => r.name.replace(r.sku, '').trim().replace(/\s+-\s*.*$/, '')
  const product = shortName(row)
  const deptName = new Map(sheet.departments.map((d) => [d.code, d.name]))
  /**
   * "SAMPLE-Edison Counter Stool - Sapphir · 17 Oct (2)" → the sheet row and
   * dispatch it was made from. The order is named by product and HOD date,
   * so the name is read back the same way.
   */
  const cellOf = (order) => {
    const m = /^SAMPLE-(.+) · (\d+) ([A-Za-z]+)(?: \((\d+)\))?$/.exec(order ?? '')
    if (!m) return null
    const row = sheet.rows.find((r) => r.name.replace(r.sku, '').trim() === m[1])
    const date = sheet.dispatches.find(
      (d) => Number(d.slice(8)) === Number(m[2]) && MONTHS[Number(d.slice(5, 7)) - 1] === m[3],
    )
    return row && date ? { row, date } : null
  }

  // --- the first card on Attention, said in plain words ----------------------
  const card = /^(\w+) cannot make (.+) as planned/.exec(f.firstFinding ?? '')
  const cardFrom = card ? cellOf(card[2]) : null
  const cardMeans = cardFrom
    ? `&ldquo;${esc(f.firstFinding)}&rdquo; means ${esc(deptName.get(card[1]) ?? card[1])} cannot finish the ${esc(shortName(cardFrom.row))} dispatch of ${day(cardFrom.date)} in the days it has.`
    : `The first line says what is wrong; the second says why and when it ships.`

  // --- which orders do not fit, by product -----------------------------------
  const short = new Map()
  for (const o of f.orderBreaches ?? []) {
    if (!o.breaches) continue
    const from = cellOf(o.order)
    if (from) short.set(shortName(from.row), (short.get(shortName(from.row)) ?? 0) + 1)
  }
  const shortList = list(
    [...short].map(([name, count]) => `${count === 1 ? 'the' : `all ${count} of the`} ${esc(name)} ${count === 1 ? 'dispatch' : 'dispatches'}`),
  )

  // --- the map, from the links the sheet implies ------------------------------
  const kindOf = new Map()
  sheet.steps.forEach((st) => st.departments.forEach((c) => kindOf.set(c, st.kind)))
  const fed = new Set(sheet.feeds.map(([, to]) => to))
  const starters = sheet.departments.filter((d) => !fed.has(d.code) && kindOf.get(d.code) === 'process').map((d) => d.name)
  const intoStaple = sheet.feeds.filter(([, to]) => to === 'STAPLE').map(([from]) => deptName.get(from))

  // --- what the order book showed -------------------------------------------
  const clean = (f.orderBreaches ?? []).filter((o) => o.breaches === 0).length
  const w = f.whatIf ?? {}
  const a = f.accept ?? {}
  const cell = f.heatCell ?? {}

  const tour = [
    stop({
      no: 1,
      menu: 'Command centre',
      title: 'The whole plan in four numbers',
      shots: [{ file: 'command-centre', alt: 'The Command centre screen' }],
      items: [
        `<strong>The yellow strip</strong> is on every screen. It is the reminder that the speeds are stand-ins. It goes when your real figures are in.`,
        `<strong>The menu.</strong> Every screen is one click from here. This guide walks nine of them, in an order that tells the story.`,
        `<strong>Run the schedule</strong> re-plans every order from nothing. It takes about 40 seconds. You do not need to press it to look around.`,
        `<strong>Breaches: ${n(f.breaches)}.</strong> Jobs that cannot be finished in the days they have. Beside it, <strong>flagged days: ${n(f.flaggedDays)}</strong> &mdash; days on which a department is asked for more than one day&rsquo;s work.`,
        `<strong>The constraint</strong> is the department under the most pressure overall: ${esc(f.constraint)} here. <em>Peak</em> is its worst single day &mdash; 4.00 means four days of work asked of one day.`,
        `<strong>Flag triage</strong> lists the overloaded days, soonest first, so the nearest problem is at the top.`,
      ],
      sample: `Your ${plural(f.lines, 'dispatch quantity', 'dispatch quantities')} became <strong>${n(f.tasks)} jobs</strong>, because each one passes through ${steps} steps. ${n(f.breaches)} of those jobs do not fit.`,
      tell: `Is ${esc(f.constraint)} where you really feel the squeeze? If not, which department is it?`,
    }),
    stop({
      no: 2,
      menu: 'Attention',
      title: 'What needs a decision, most urgent first',
      shots: [{ file: 'attention', alt: 'The Attention screen' }],
      items: [
        `<strong>The red badge</strong> sits at the top of every screen and counts what needs an answer today: ${n(f.critical)} at the moment.`,
        `<strong>Each card is one problem in one sentence.</strong> ${cardMeans}`,
        `<strong>The link</strong> opens the screen where that problem can be dealt with.`,
        `<strong>A different kind of card.</strong> Your sheet gives two steps the same day, and one of them has to finish before the other can start. The software will not guess which is right, so it asks. There are ${n(f.sameDay)} of these, all straight from the sheet.`,
      ],
      sample: `The count is high for two reasons, and both are about the sample rather than your factory. The stand-in speed makes jobs not fit. And October dispatches mean the work was due in August and September, which is already behind us, with nothing recorded as made.`,
      tell: `Would your team work from a list like this each morning? Who should see it &mdash; planning only, or every department head?`,
    }),
    stop({
      no: 3,
      menu: 'Schedule',
      title: 'Every job on a calendar',
      shots: [{ file: 'schedule', alt: 'The Schedule screen, showing one dispatch' }],
      items: [
        `<strong>One block per dispatch.</strong> This is the first one: ${n(qty)} ${esc(product)}s, dispatch ${day(sheet.dispatches[col])}.`,
        `<strong>Each bar is one department&rsquo;s work</strong>, from the day it starts to the day it must finish. The thin black line on the bar is the deadline from your sheet.`,
        `<strong>A red bar cannot be done in time.</strong> This one is ${esc(sheet.departments[4].name)}.`,
        `<strong>The reason is at the end of the row.</strong> <em>Runway</em> means the step before it finishes too late to leave this one enough working days.`,
        `<strong>Tick &ldquo;Breaches only&rdquo;</strong> to hide everything that is fine and see just the problems.`,
      ],
      sample: `Read the bars from top to bottom and you are reading one row of your sheet from left to right. The short bars are QC steps: a date to pass, not days of work.`,
      tell: `Is this the order the work really goes in? Is anything shown waiting that in practice does not wait?`,
    }),
    stop({
      no: 4,
      menu: 'Load heatmap',
      title: 'Which days are too full',
      shots: [{ file: 'heatmap', alt: 'The Load heatmap screen with one day opened', tall: true }],
      items: [
        `<strong>One row per department, one square per day.</strong> ${n(f.heatDepartments)} departments across ${n(f.heatDays)} days.`,
        `<strong>A red square</strong> is a day asked for more than one day&rsquo;s work. Green is full but possible; pale is partly used. Click any square.`,
        `<strong>The count:</strong> ${n(f.heatOver)} red squares out of ${n(f.heatDepartments * f.heatDays)}.`,
        `<strong>What is on that day.</strong> Sanding on ${day(cell.date ?? '2026-01-01')}: ${plural(f.heatCellJobs ?? 0, 'dispatch', 'dispatches')} each want the whole day, so the day is asked for ${Math.round((cell.value ?? 0) * 100)}%.`,
      ],
      sample: `With one speed of ${rate} for everything, any two jobs that land on the same day turn the square red. Your real speeds will thin this out &mdash; or leave you looking at the days that truly are too full.`,
      tell: `Do you run several products through one department on the same day? When two collide, how do you decide which goes first?`,
    }),
    stop({
      no: 5,
      menu: 'Order book',
      title: 'Every promise, in one list',
      shots: [{ file: 'order-book', alt: 'The Order book screen' }],
      items: [
        `<strong>One line per quantity on your sheet</strong>, named by the product and its HOD date. Where a product ships twice on one day, as the Edison stool does on 17 October, the two are numbered.`,
        `<strong>First stuffing</strong> is your HOD date: the day everything is counted back from.`,
        `<strong>Breaches</strong> is how many steps of that order do not fit. A dash means every step fits.`,
        `<strong>Add an order</strong> plans the new order straight away, which takes about 40 seconds. If you try it, start the order number with <span class="k">SAMPLE-</span> so it is cleared out with the rest.`,
      ],
      sample: `${n(clean)} of the ${n(f.orders)} dispatches fit completely. The ${n(f.orders - clean)} that do not are ${shortList}.`,
      tell: `We made each quantity its own order because the sheet does not say otherwise. Do several dispatches belong to one customer order?`,
    }),
    stop({
      no: 6,
      menu: 'Accept an order',
      title: 'Ask before you promise',
      shots: [{ file: 'acceptance', alt: 'The Accept an order screen with its answer' }],
      items: [
        `<strong>Pick a product, a quantity and a dispatch date.</strong>`,
        `<strong>Press Check.</strong> The answer takes about a minute, because the whole factory is planned again with this order added. Nothing is saved.`,
        `<strong>The answer in one line:</strong> &ldquo;${esc(a.verdict ?? '')}&rdquo;`,
        `<strong>Which steps, and why.</strong> Every step is listed with its dates. The ones that fail say what is wrong.`,
      ],
      sample: `We asked for ${n(a.qty ?? 0)} more ${esc(product)}s for ${day(a.date ?? '2026-01-01')}, when nothing else is planned. It is still refused, at ${list((a.failing ?? []).map((c) => esc(deptName.get(c) ?? c)))}. So the factory is not crowded: the days the sheet gives those steps are fewer than ${n(a.qty ?? 0)} pieces need at ${rate} a day.`,
      tell: `Who answers &ldquo;can we take this order?&rdquo; today, and how long does it take them?`,
    }),
    stop({
      no: 7,
      menu: 'Capacity sheet',
      title: 'Where your numbers live',
      shots: [{ file: 'capacity-sheet', alt: 'The Capacity sheet screen showing day-counts' }],
      items: [
        `<strong>The same-day cases</strong> from stop 2, listed together: ${n(f.sheetConflicts)} to look at.`,
        `<strong>Three views of one grid:</strong> units per day, manpower, and D-minus. D-minus is the software&rsquo;s name for your day-counts. The picture shows that view.`,
        `<strong>Type a code or a name</strong> to find one product among ${n(f.articles)}.`,
        `<strong>This row is a row of your sheet:</strong> ${row.days.slice(0, 6).join(', ')}&hellip; Click a figure, type a new one, press Enter.`,
      ],
      sample: `Switch to <em>Units per day</em> and every production box for your six products says ${rate}. Those are the boxes we need from you. The QC boxes say ${n(sheet.checkpoint_rate_per_day)}, which is only our way of writing &ldquo;takes no time&rdquo;.`,
      tell: `For each product in each department: how many pieces a day, working on nothing else, and with how many people?`,
    }),
    stop({
      no: 8,
      menu: 'Factory map',
      title: 'What waits for what',
      shots: [
        { file: 'factory-map-1', alt: 'The Factory map, first half', caption: 'The start of the line' },
        { file: 'factory-map-2', alt: 'The Factory map, second half', caption: 'The end of the line' },
      ],
      items: [
        `<strong>A thick border</strong> is a department that starts on its own and waits for nothing: ${list(starters.map(esc))}.`,
        `<strong>QC steps sit beside the line.</strong> They check the step before them, and nothing waits for them.`,
        `<strong>Stapling waits for ${intoStaple.length} things:</strong> ${list(intoStaple.map(esc))}.`,
        `<strong>Ex-factory</strong> is the last step before dispatch.`,
      ],
      sample: `We drew these lines from the order of the columns on your sheet. Two of them are our guesses: that fibre filling comes after stitching, and that ply cutting waits for machining.`,
      tell: `Is every line right? If you printed this page and corrected it with a pen, that would be the most useful thing you could send back.`,
    }),
    stop({
      no: 9,
      menu: 'What if',
      title: 'Try a change without touching the plan',
      shots: [{ file: 'what-if', alt: 'The What if screen comparing a scenario with the live plan' }],
      items: [
        `<strong>Say what you are trying</strong>, in your own words.`,
        `<strong>Choose the department.</strong>`,
        `<strong>Choose the change.</strong> A second shift doubles what the department can make. Overtime adds a fifth. Department down takes it to nothing.`,
        `<strong>Press Run it.</strong> About a minute. The live plan is not touched.`,
        `<strong>Before and after.</strong> Breaches go from ${n(w.breachesNow ?? 0)} to ${n(w.breachesThen ?? 0)}, and flagged days from ${n(w.flaggedNow ?? 0)} to ${n(w.flaggedThen ?? 0)}.`,
        `<strong>Department by department.</strong> ${esc(w.department ?? '')} goes from ${n(w.deptBreachesNow ?? 0)} to ${n(w.deptBreachesThen ?? 0)}.`,
      ],
      sample: `A second shift in ${esc(w.department ?? '')} clears every ${esc(w.department ?? '')} problem and nothing else: ${list(
        (w.rows ?? []).filter((r) => r.then > 0).map((r) => esc(deptName.get(r.code) ?? r.code)),
      )} are still short. This is the screen for asking &ldquo;what would it take?&rdquo; before spending anything.`,
      tell: `Which of these can you really do, and where &mdash; overtime, a second shift, sending work to a contractor?`,
    }),
  ]

  const rowsDays = sheet.rows
    .map(
      (r) =>
        `<tr><td class="term">${esc(r.sku)}</td>${r.days.map((d) => `<td class="num">${d}</td>`).join('')}</tr>`,
    )
    .join('')
  const rowsQty = sheet.rows
    .map(
      (r) =>
        `<tr><td class="term">${esc(r.sku)}</td><td class="def">${esc(r.name.replace(r.sku, '').trim())}</td>${r.qty
          .map((q) => `<td class="num">${q ?? '&mdash;'}</td>`)
          .join('')}</tr>`,
    )
    .join('')

  const ask = (i, q, hint = '') =>
    `<li><div class="q"><span class="q__n">${i}</span><div><strong>${q}</strong>${
      hint ? `<span class="q__hint">${hint}</span>` : ''
    }</div></div><div class="answer"></div></li>`

  return `<title>Kram — Your sample, running</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  /* Kram's own register, as the other notes carry it, so a folder of these
     reads as one set of documents. */
  :root {
    --paper: #e9edf1; --sheet: #ffffff; --ink: #16202e; --mid: #5c6b7a;
    --faint: #8996a4; --rule: #c9d3dc; --rule-soft: #dfe6ec;
    --blue: #2c4a6e; --amber: #b07d1a; --flag: #c4462e; --go: #1a6547;
    --mark: #ffd60a; --mark-ink: #16202e; --bar: #16202e; --bar-text: #ffffff;
    --sans: 'Archivo', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      --paper: #0f151d; --sheet: #16202e; --ink: #e6ecf2; --mid: #a3b1c0;
      --faint: #7e8d9d; --rule: #2c3a4b; --rule-soft: #223044;
      --blue: #8fb4dc; --amber: #d9a441; --flag: #e8705c; --go: #4fb98c;
      --bar: #dbe4ee; --bar-text: #0f151d;
    }
  }
  :root[data-theme='dark'] {
    --paper: #0f151d; --sheet: #16202e; --ink: #e6ecf2; --mid: #a3b1c0;
    --faint: #7e8d9d; --rule: #2c3a4b; --rule-soft: #223044;
    --blue: #8fb4dc; --amber: #d9a441; --flag: #e8705c; --go: #4fb98c;
    --bar: #dbe4ee; --bar-text: #0f151d;
  }

  body { background: var(--paper); color: var(--ink); font-family: var(--sans);
    font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .doc { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1rem 5rem;
    display: flex; flex-direction: column; gap: 1.8rem; }

  .head { background: var(--sheet); border: 1px solid var(--rule); }
  .head__main { padding: 1.7rem 1.5rem 1.4rem; }
  .firm { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.15em;
    text-transform: uppercase; color: var(--faint); }
  h1 { font-size: clamp(1.9rem, 5vw, 2.6rem); line-height: 1.05; margin: 0.4rem 0 0.55rem;
    letter-spacing: -0.028em; font-weight: 700; text-wrap: balance; }
  .sub { color: var(--mid); margin: 0; max-width: 56ch; font-size: 1.03rem; }
  dl.stamp { margin: 0; display: grid; grid-template-columns: auto 1fr;
    border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 0.75rem; }
  dl.stamp dt { padding: 0.45rem 0.9rem; color: var(--faint); text-transform: uppercase;
    font-size: 0.6875rem; letter-spacing: 0.09em; border-bottom: 1px solid var(--rule-soft);
    border-right: 1px solid var(--rule-soft); white-space: nowrap; }
  dl.stamp dd { margin: 0; padding: 0.45rem 0.9rem; border-bottom: 1px solid var(--rule-soft); }

  /* Block, not flex: a flex column is laid out as one piece in print, and a
     section that could not fit whole was carried to the next page, leaving
     half of the one before it blank. */
  h2 { font-size: 1.32rem; margin: 0.6rem 0 0; letter-spacing: -0.015em; text-wrap: balance; }
  h3 { font-size: 1rem; margin: 0; }
  h3 .aside { font-weight: 400; color: var(--mid); }

  p { margin: 0; max-width: 72ch; }
  .lede { color: var(--mid); }
  .k { font-family: var(--mono); font-size: 0.9em; }

  .tablewrap { overflow-x: auto; border: 1px solid var(--rule); background: var(--sheet); }
  table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.5rem 0.8rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  th { font-family: var(--mono); font-size: 0.625rem; letter-spacing: 0.11em;
    text-transform: uppercase; color: var(--faint); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  td.term { font-weight: 600; white-space: nowrap; }
  td.def { color: var(--mid); }
  td.def strong { color: var(--ink); }
  td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }

  /* Three things to know, side by side. */
  .three { display: grid; gap: 0.8rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
  .card { background: var(--sheet); border: 1px solid var(--rule); border-top: 3px solid var(--ink);
    padding: 0.9rem 1rem 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .card.yours { border-top-color: var(--go); }
  .card.standin { border-top-color: var(--amber); }
  .card.ask { border-top-color: var(--blue); }
  .card__t { font-family: var(--mono); font-size: 0.625rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--faint); }
  .card p { font-size: 0.95rem; }

  .note { background: var(--sheet); border: 1px solid var(--rule);
    border-left: 3px solid var(--blue); padding: 1.05rem 1.2rem;
    display: flex; flex-direction: column; gap: 0.55rem; }
  .note.amber { border-left-color: var(--amber); }

  /* The worked example: a sum laid out as a sum. */
  .sum { display: grid; gap: 0; border: 1px solid var(--rule); background: var(--sheet); }
  .sum__row { display: grid; grid-template-columns: 2.4rem 1fr auto; gap: 0.9rem; align-items: baseline;
    padding: 0.7rem 1rem; border-bottom: 1px solid var(--rule-soft); }
  .sum__row:last-child { border-bottom: 0; }
  .sum__i { font-family: var(--mono); font-size: 0.75rem; color: var(--faint); }
  .sum__v { font-family: var(--mono); font-weight: 500; font-size: 1.05rem; white-space: nowrap; }
  .sum__row.result { background: color-mix(in srgb, var(--flag) 7%, transparent); }
  .sum__row.result .sum__v { color: var(--flag); font-weight: 600; }

  /* The numbered badge: the same one drawn on the screenshots. */
  .n { display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--mark);
    color: var(--mark-ink); border: 1.5px solid var(--mark-ink); font-weight: 700;
    font-size: 0.8rem; line-height: 1; }
  ol.marks { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem 1.4rem;
    grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); font-size: 0.93rem; }
  ol.marks li { display: grid; grid-template-columns: 1.5rem 1fr; gap: 0.6rem; align-items: start; }
  ol.marks li > span:last-child { color: var(--mid); }
  ol.marks strong { color: var(--ink); }

  .stop { background: var(--sheet); border: 1px solid var(--rule); }
  .stop__bar { background: var(--bar); color: var(--bar-text); padding: 0.6rem 1rem;
    display: flex; gap: 0.85rem; align-items: baseline; flex-wrap: wrap; }
  .stop__no { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.11em;
    text-transform: uppercase; opacity: 0.78; }
  .stop__title { font-weight: 600; font-size: 1.02rem; }
  .stop__where { margin-left: auto; font-family: var(--mono); font-size: 0.6875rem;
    letter-spacing: 0.09em; text-transform: uppercase; opacity: 0.85; }
  .stop__body { padding: 1rem 1.1rem 1.1rem; display: flex; flex-direction: column; gap: 0.9rem; }

  figure.shot { margin: 0; border: 1px solid var(--rule); background: #eef1f5; }
  figure.shot img { display: block; width: 100%; height: auto; }
  figure.shot figcaption { font-family: var(--mono); font-size: 0.625rem; letter-spacing: 0.11em;
    text-transform: uppercase; color: #5c6b7a; padding: 0.3rem 0.6rem; background: #ffffff;
    border-top: 1px solid var(--rule); }
  figure.shot--tall img { max-height: 46rem; width: auto; max-width: 100%; margin: 0 auto; }
  figure.small { max-width: 21rem; }

  .pair { display: grid; gap: 0.8rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
  .sample, .tell { padding: 0.6rem 0.9rem; font-size: 0.93rem; }
  .sample { border-left: 3px solid var(--blue); background: color-mix(in srgb, var(--blue) 6%, transparent); }
  .tell { border-left: 3px solid var(--amber); background: color-mix(in srgb, var(--amber) 9%, transparent); }
  .sample__t, .tell__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
    text-transform: uppercase; margin-bottom: 0.2rem; }
  .sample__t { color: var(--blue); }
  .tell__t { color: var(--amber); }

  ol.steps { margin: 0; padding: 0; list-style: none; counter-reset: s; display: grid; gap: 0.55rem; }
  ol.steps li { counter-increment: s; display: grid; grid-template-columns: 1.9rem 1fr; gap: 0.7rem; }
  ol.steps li::before { content: counter(s); font-family: var(--mono); font-size: 0.8rem;
    color: var(--faint); border: 1px solid var(--rule); height: 1.6rem; display: flex;
    align-items: center; justify-content: center; background: var(--sheet); }

  /* Questions, each with room to answer by hand on a printed copy. */
  ol.checklist { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
  ol.checklist li { background: var(--sheet); border: 1px solid var(--rule); padding: 0.65rem 1rem 0.75rem; }
  .q { display: grid; grid-template-columns: 1.7rem 1fr; gap: 0.7rem; align-items: start; }
  .q__n { font-family: var(--mono); font-size: 0.8rem; color: var(--faint); padding-top: 0.1rem; }
  .q__hint { display: block; color: var(--mid); font-size: 0.9rem; margin-top: 0.15rem; }
  .answer { margin: 0.5rem 0 0 2.4rem; border-bottom: 1px solid var(--rule); height: 1.5rem; }

  /* The sheet as we copied it: seventeen narrow columns, headings on end. */
  table.tight th, table.tight td { padding-top: 0.32rem; padding-bottom: 0.32rem; }
  table.sheet { font-size: 0.78rem; }
  table.sheet th, table.sheet td { padding: 0.35rem 0.3rem; }
  table.sheet td.term { padding-left: 0.7rem; }
  table.sheet th.up { vertical-align: bottom; height: 7rem; padding-bottom: 0.5rem; }
  table.sheet th.up span { writing-mode: vertical-rl; transform: rotate(180deg);
    white-space: nowrap; letter-spacing: 0.06em; }
  table.sheet th.qc span { color: var(--blue); }

  /* Spacing inside a section. Declared last, and with the wrapper in the
     selector, because \`p\`, \`ol.steps\` and the rest all zero their own margins
     above and a bare \`section > * + *\` loses to every one of them. */
  .doc section > * + * { margin-top: 0.85rem; }
  .doc section > h3 { margin-top: 1.5rem; }
  .doc section > h2:not(:first-child) { margin-top: 2.2rem; }

  .open { display: grid; gap: 1rem 1.6rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); align-items: start; }

  footer { border-top: 1px solid var(--rule); padding-top: 1rem; color: var(--faint);
    font-family: var(--mono); font-size: 0.7rem; display: flex; justify-content: space-between;
    gap: 1rem; flex-wrap: wrap; }

  @media print {
    /* One stop to a page: the picture and what it shows are never separated. */
    .stop { break-before: page; break-inside: avoid; }
    .pagebreak { break-before: page; }
    figure.shot img { max-height: 141mm; width: auto; max-width: 100%; margin: 0 auto; }
    figure.shot--tall img { max-height: 158mm; }
    figure.shot + figure.shot { margin-top: -0.3rem; }
    ol.marks { grid-template-columns: 1fr 1fr; font-size: 0.9rem; gap: 0.45rem 1.2rem; }
    .pair { grid-template-columns: 1fr 1fr; }
    .three { grid-template-columns: 1fr 1fr 1fr; }
    .open { grid-template-columns: 1.25fr 1fr; }
    .card, .sum, .pair, ol.steps li, ol.marks li { break-inside: avoid; }
    ol.checklist { gap: 0.42rem; }
    ol.checklist li { padding: 0.5rem 1rem 0.6rem; }
    .answer { margin-top: 0.15rem; height: 1.35rem; }
    /* The last hairline of a full-width box sits exactly on the page edge and
       is clipped; a transparent pixel beside it brings it back. */
    .doc { border-right: 1px solid transparent; }
  }
</style>

<div class="doc">

  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>Your sample, running in Kram</h1>
      <p class="sub">The six products you sent us, planned by the software. Where
        to click, what you are looking at, and what we need you to tell us.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/09 &middot; Rev A &middot; for U&amp;M Designs</dd>
      <dt>Open it at</dt><dd>${esc(site)}</dd>
      <dt>Pictures taken</dt><dd>${esc(taken)} IST, from the live system</dd>
    </dl>
  </header>

  <!-- ================================================================ -->
  <section>
    <h2>In one minute</h2>
    <div class="three">
      <div class="card yours">
        <div class="card__t">Yours</div>
        <p><strong>The six products, the ${n(f.lines)} dispatch quantities and
          every day-count</strong> are exactly as they are on your planning
          sheet. Dispatches are on ${dispatchDays}.</p>
      </div>
      <div class="card standin">
        <div class="card__t">A stand-in</div>
        <p><strong>Every department is set to ${rate} pieces a day, for every
          product.</strong> Nobody at U&amp;M gave us that figure. It is there
          so the software has something to calculate with.</p>
      </div>
      <div class="card ask">
        <div class="card__t">What we are asking</div>
        <p><strong>Look, try things, and tell us where it does not match how
          you work.</strong> The questions are at the end. Your answers are
          what turn this from a sample into your plan.</p>
      </div>
    </div>
    <div class="note amber">
      <p><strong>Read the shape, not the numbers.</strong> You will see a lot
        of red. Every red mark means one thing: <em>at ${rate} a day, this job
        does not fit in the days your sheet gives it.</em> With your real
        speeds the answer changes. That is the point of sending them.</p>
    </div>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>How your sheet became this plan</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>On your sheet</th><th>In Kram</th></tr></thead>
      <tbody>
        <tr><td class="term">HOD date</td><td class="def">The dispatch day, and <strong>day 0</strong>. Every other date is counted back from it. The software calls it the <em>stuffing date</em>.</td></tr>
        <tr><td class="term">The number under each step</td><td class="def">That step must be <strong>finished</strong> that many days before dispatch. The software calls this <em>D-minus</em>: Sanding at D-30 finishes 30 days before.</td></tr>
        <tr><td class="term">QC columns and Ex-factory</td><td class="def">A <strong>date to pass</strong>, not a job that takes a crew&rsquo;s time. They sit beside the line and never hold anything up.</td></tr>
        <tr><td class="term">A column naming two steps</td><td class="def">Two departments with <strong>the same deadline</strong> &mdash; ply cutting and assembly, wood and metal finishing, foam and fibre.</td></tr>
        <tr><td class="term">Each quantity under a date</td><td class="def"><strong>One order</strong>, named by the product and the HOD date: &ldquo;Edison Counter Stool &middot; 17 Oct (2)&rdquo; is the second Edison container of that day.</td></tr>
        <tr><td class="term">Speeds</td><td class="def"><strong>Not on the sheet.</strong> Set to ${rate} a day everywhere, as a stand-in.</td></tr>
      </tbody>
    </table></div>

    <h3>One order, worked by hand</h3>
    <p class="lede">${n(qty)} ${esc(product)}s, dispatch ${day(sheet.dispatches[col])}.
      This is all the software does &mdash; for every step of every order, at once.</p>
    <div class="sum">
      <div class="sum__row"><span class="sum__i">1</span><span>Your sheet finishes <strong>${esc(first.after)}</strong> ${first.afterDue} days before dispatch, and <strong>${esc(first.name)}</strong> ${first.due} days before. So ${esc(first.name)} has the days in between.</span><span class="sum__v">${first.gap} days</span></div>
      <div class="sum__row"><span class="sum__i">2</span><span>At ${rate} pieces a day, ${n(qty)} pieces take ${n(qty)} &divide; ${rate}.</span><span class="sum__v">${need.toFixed(1)} days</span></div>
      ${
        fits
          ? `<div class="sum__row"><span class="sum__i">3</span><span><strong>${plural(needDays, 'day')} of work, ${plural(first.gap, 'day')} to do it in.</strong> This is the tightest step of the order, and it fits.</span><span class="sum__v">fits</span></div>`
          : `<div class="sum__row result"><span class="sum__i">3</span><span><strong>${plural(needDays, 'day')} of work, ${plural(first.gap, 'day')} to do it in.</strong> The software marks ${esc(first.name)} red for this order.</span><span class="sum__v">does not fit</span></div>`
      }
    </div>
    <p>${
      fits
        ? `Every step of this order fits at ${rate} a day.`
        : `${others.length ? `The same sum fails at ${list(others.map((t) => `${esc(t.name)} (${plural(t.gap, 'day')} given)`))}. ` : ''}Every other step of this order fits. Either the crews are faster than ${rate} a day, or the days are tighter than they look.`
    } <strong>You know the real speeds, and we do not.</strong></p>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>Open it</h2>
    <div class="open">
      <ol class="steps">
        <li><span>On a computer or a phone, open <strong class="k">${esc(site)}</strong> in Chrome.</span></li>
        <li><span>Type the email and password Data Brilliance gave you. They are sent separately, never in a document.</span></li>
        <li><span>Press <strong>Sign in</strong>. You land on the Command centre, which is stop 1 of the tour.</span></li>
      </ol>
      <figure class="shot"><img src="walkthrough/login.png" alt="The sign-in screen" /></figure>
    </div>

    <div class="note">
      <h3>Showing this to a group? Twenty minutes is enough.</h3>
      <ol class="steps">
        <li><span><strong>Before anyone arrives,</strong> sign in and leave the Command centre open. Do not press <em>Run the schedule</em>; the plan is already there.</span></li>
        <li><span><strong>Start on paper.</strong> Read out &ldquo;One order, worked by hand&rdquo; above. Once the room has done that sum, every red mark explains itself.</span></li>
        <li><span><strong>Most stops are for looking.</strong> About two minutes each. Read the numbered points; ask the &ldquo;Tell us&rdquo; question and write down what is said.</span></li>
        <li><span><strong>Stops 6 and 9 are for doing.</strong> Each takes about a minute to answer, which is a good moment to take questions.</span></li>
        <li><span><strong>Finish on &ldquo;What we need from you&rdquo;</strong> and leave this document behind.</span></li>
      </ol>
    </div>
  </section>

  ${tour.join('\n')}

  <!-- ================================================================ -->
  <section class="pagebreak">
    <h2>Trying it yourself</h2>
    <p class="lede">Everything in the tour can be done by you, on the same
      system. Most of it changes nothing. This is the rest.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Do this freely</th><th>Why it is safe</th></tr></thead>
      <tbody>
        <tr><td class="term">Accept an order &middot; What if</td><td class="def">Both plan a copy and throw it away. The live plan is never touched.</td></tr>
        <tr><td class="term">Click squares, bars and rows</td><td class="def">Looking changes nothing.</td></tr>
        <tr><td class="term">Run the schedule</td><td class="def">Re-plans from the same figures and gives the same answer. It takes about 40 seconds.</td></tr>
      </tbody>
      <thead><tr><th>Think first</th><th>What it does</th></tr></thead>
      <tbody>
        <tr><td class="term">Add an order</td><td class="def">A real addition, seen by everyone. Start the number with <span class="k">SAMPLE-</span> and it is cleared with the rest.</td></tr>
        <tr><td class="term">Type into the Capacity sheet or Masters</td><td class="def">Changes the sample for everyone and re-plans. Fine if that is what you mean to do &mdash; it is how real figures will go in.</td></tr>
        <tr><td class="term">Drag a bar on the Schedule</td><td class="def">Fixes that job to the date you drop it on, and asks you why. Every later plan respects it.</td></tr>
      </tbody>
    </table></div>

    <h2>Screens that are waiting for you</h2>
    <p class="lede">Eleven more screens are built. With the sample most of
      them have nothing to show yet, and say so. This is what brings each one
      to life.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Screen</th><th>What it will show</th><th>What it needs</th></tr></thead>
      <tbody>
        <tr><td class="term">Production</td><td class="def">Each department&rsquo;s work list for the day</td><td class="def">A supervisor entering what was made, good and rejected. Two minutes a day.</td></tr>
        <tr><td class="term">WIP &middot; My department &middot; Dashboard</td><td class="def">Where every order physically is; what each department owes; nine figures for the MD</td><td class="def">Nothing extra. They fill themselves from Production.</td></tr>
        <tr><td class="term">Manpower</td><td class="def">Who came in, and what the day can make as a result</td><td class="def">Attendance, by person or as a head count.</td></tr>
        <tr><td class="term">Quality</td><td class="def">Rejections by department, product and cause</td><td class="def">The rejected count from Production, and a reason for each.</td></tr>
        <tr><td class="term">Material</td><td class="def">What to buy, and the last day it can be ordered</td><td class="def">Materials per product, supplier lead times, and a stock count.</td></tr>
        <tr><td class="term">Money</td><td class="def">Cash going out, week by week</td><td class="def">A cost per product.</td></tr>
        <tr><td class="term">Forecast</td><td class="def">What the factory really achieves, against what was planned</td><td class="def">Some months of recorded production. It refuses to guess before then.</td></tr>
        <tr><td class="term">Masters &middot; Users</td><td class="def">Departments, holidays, machines; who can sign in</td><td class="def">Your holiday list, and a name and role for each person.</td></tr>
      </tbody>
    </table></div>
  </section>

  <!-- ================================================================ -->
  <section class="pagebreak">
    <h2>What we need from you</h2>
    <p class="lede">Nine things. A line or two each is enough, written on a
      printed copy or sent back in a message.</p>
    <ol class="checklist">
      ${ask(1, 'Is our copy of your sheet right?', 'It is printed after these questions. We typed it from a picture, so please check every figure. One is already corrected on your word: Imogene&rsquo;s Ex-factory is 7.')}
      ${ask(2, 'Are the day-counts &ldquo;finish by&rdquo; or &ldquo;start by&rdquo;?', 'We have read every number as the day that step must be finished.')}
      ${ask(3, 'What is the bold row at the top of your sheet?', `It reads ${sheet.template_days.slice(0, 5).join(', ')}&hellip; Is that the standard a new product starts from?`)}
      ${ask(4, 'Two steps on the same day: is that meant?', 'Betsy Chair and Imogene have Machining and Ply cutting + assembly on one day. Imogene also has Cutting and Stitching on one day.')}
      ${ask(5, 'Does ply cutting wait for machining?', 'Or do the two start side by side, and only assembly waits for both?')}
      ${ask(6, 'Does fibre filling come after stitching?', 'We assumed so from the order of your columns.')}
      ${ask(7, 'Is QC only a date, or does it take time?', 'If an inspection holds work for a day, or needs its own people, the plan should know.')}
      ${ask(8, 'Your real speeds.', 'For each product in each department: pieces a day when working on nothing else, and how many people. If you keep time per piece instead, send that with the crew size and shift hours.')}
      ${ask(9, 'The Excel file itself.', 'A picture loses formulas, hidden columns and other tabs. The file may already hold some of what we are asking for.')}
    </ol>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>Our copy of your sheet</h2>
    <p class="lede">Typed by hand from the picture you sent. Tick it, or correct it.</p>
    <h3>Quantities, by dispatch date</h3>
    <div class="tablewrap"><table class="tight">
      <thead><tr><th>SKU</th><th>Product</th>${sheet.dispatches.map((d) => `<th class="num">${day(d).replace(/ \d{4}$/, '')}</th>`).join('')}</tr></thead>
      <tbody>${rowsQty}</tbody>
    </table></div>
    <h3>Days before dispatch, by step <span class="aside">&mdash; headings in blue are the steps we treated as dates to pass, not work to do</span></h3>
    <div class="tablewrap"><table class="sheet">
      <thead><tr><th>SKU</th>${sheet.steps
        .map((s) => `<th class="up${s.kind === 'checkpoint' ? ' qc' : ''}"><span>${esc(SHORT[s.column] ?? s.column)}</span></th>`)
        .join('')}</tr></thead>
      <tbody>${rowsDays}</tbody>
    </table></div>

    <h2>What happens next</h2>
    <ol class="steps">
      <li><span><strong>You look, and answer the nine questions.</strong> This document is the guide for that.</span></li>
      <li><span><strong>You send your speeds.</strong> We prepare an Excel sheet listing every product against every department; you fill it in; it is loaded in one go. From then on the red means something.</span></li>
      <li><span><strong>Your real order book goes in.</strong> We need one sample export from Panipuri so orders arrive without being typed twice.</span></li>
      <li><span><strong>Your people get their own logins, and supervisors start recording the day&rsquo;s production.</strong> That is the moment the remaining screens come to life.</span></li>
    </ol>
  </section>

  <footer>
    <span>DBBS/UM/KRAM/09 &middot; Rev A &middot; pictures and figures taken together, ${esc(taken)} IST</span>
    <span>Sample data. Not a production plan.</span>
  </footer>
</div>
`
}
