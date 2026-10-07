/**
 * Writes DBBS/UM/KRAM/10 — what U&M's numbers did to the system, how to present
 * it, and how each function works.
 *
 *   node scripts/make-sample-report.mjs
 *   node scripts/make-pdf.mjs docs/sample-report.html
 *
 * No browser. Every figure comes from `docs/walkthrough/facts.json`, which the
 * walkthrough capture read off the live screens, so this document and KRAM/09
 * quote the same plan. Regenerate the walkthrough first if the plan has moved.
 *
 * The stylesheet is the walkthrough's own, taken from the page it builds, so
 * the two read as one set.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { walkthroughPage } from './lib/walkthrough-page.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const facts = JSON.parse(await readFile(`${repoRoot}docs/walkthrough/facts.json`, 'utf8'))
const sheet = JSON.parse(await readFile(`${repoRoot}scripts/data/um-sample-sheet.json`, 'utf8'))

const style = walkthroughPage({ facts, sheet, site: 'kraam.netlify.app' }).match(/<style>[\s\S]*?<\/style>/)[0]
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const n = (v) => Number(v).toLocaleString('en-IN')
const f = facts
const w = f.whatIf
const a = f.accept
const rate = sheet.rate_per_day
const asOf = new Date(f.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
const deptName = new Map(sheet.departments.map((d) => [d.code, d.name]))
const stillShort = w.rows.filter((r) => r.then > 0).map((r) => deptName.get(r.code) ?? r.code)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const day = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

const say = (t) => `<div class="say"><span class="say__t">Say</span><p>${t}</p></div>`
const click = (t) => `<div class="do"><span class="do__t">Do</span><p>${t}</p></div>`

const fn = (name, { menu, purpose, how, needs, sample }) => `
  <article class="fn">
    <div class="fn__head"><h3>${name}</h3>${menu ? `<span class="fn__menu">${menu}</span>` : ''}</div>
    <dl class="fn__body">
      <dt>What it is for</dt><dd>${purpose}</dd>
      <dt>How it works</dt><dd>${how}</dd>
      ${needs ? `<dt>What it needs</dt><dd>${needs}</dd>` : ''}
      ${sample ? `<dt>With the sample</dt><dd>${sample}</dd>` : ''}
    </dl>
  </article>`

const page = `<title>Kram — What their numbers did</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${style}
<style>
  .say, .do { display: grid; grid-template-columns: 2.6rem 1fr; gap: 0.6rem; align-items: start; }
  .say__t, .do__t { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em; text-transform: uppercase;
    padding-top: 0.35rem; }
  .say__t { color: var(--blue); }
  .do__t { color: var(--amber); }
  .say p { border-left: 3px solid var(--blue); padding: 0.3rem 0.8rem; background: color-mix(in srgb, var(--blue) 6%, transparent); font-style: italic; }
  .do p { border-left: 3px solid var(--amber); padding: 0.3rem 0.8rem; background: color-mix(in srgb, var(--amber) 8%, transparent); }
  .beat { background: var(--sheet); border: 1px solid var(--rule); padding: 0.9rem 1rem; display: grid; gap: 0.6rem; }
  .beat__head { display: flex; gap: 0.8rem; align-items: baseline; flex-wrap: wrap; }
  .beat__min { font-family: var(--mono); font-size: 0.7rem; color: var(--faint); letter-spacing: 0.08em; text-transform: uppercase; }
  .beat h3 { font-size: 1.02rem; }
  .fn { background: var(--sheet); border: 1px solid var(--rule); }
  .fn__head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--rule-soft); background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .fn__menu { font-family: var(--mono); font-size: 0.625rem; letter-spacing: 0.11em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }
  .fn__body { margin: 0; padding: 0.6rem 0.9rem 0.7rem; display: grid; grid-template-columns: 7.5rem 1fr; gap: 0.3rem 0.8rem; font-size: 0.9rem; }
  .fn__body dt { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.11em; text-transform: uppercase; color: var(--faint); padding-top: 0.2rem; }
  .fn__body dd { margin: 0; color: var(--mid); }
  .fn__body dd strong { color: var(--ink); }
  .fns { display: grid; gap: 0.7rem; }
  .qa { display: grid; gap: 0.5rem; }
  .qa div { background: var(--sheet); border: 1px solid var(--rule); padding: 0.6rem 0.9rem; font-size: 0.92rem; }
  .qa b { display: block; margin-bottom: 0.15rem; }
  td.delta { font-family: var(--mono); white-space: nowrap; }
  @media print {
    .beat, .fn, .qa div, .sum, .say, .do { break-inside: avoid; }
    .fn__body { grid-template-columns: 7rem 1fr; }
  }
</style>

<div class="doc">
  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>What their numbers did</h1>
      <p class="sub">What changed in Kram when U&amp;M's sample went in, what the
        results mean, how to present it, and how each part of the system works.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/10 &middot; Rev A &middot; internal, and for U&amp;M's planning team</dd>
      <dt>Figures</dt><dd>From the live plan of ${esc(asOf)}, the same plan KRAM/09 pictures</dd>
      <dt>Companions</dt><dd>KRAM/09 (the illustrated walkthrough) &middot; KRAM/08 (every term)</dd>
    </dl>
  </header>

  <!-- ================================================================ -->
  <section>
    <h2>1. What went in, and what came out</h2>
    <p class="lede">Six rows of U&amp;M's own planning sheet, received on 3 October as
      a picture and described as sample data. Loaded on 4 October into the live
      system through the same door PPC's real figures will use.</p>

    <div class="tablewrap"><table>
      <thead><tr><th>What</th><th>Before (our placeholders)</th><th>After (their sample)</th><th>Why it moved</th></tr></thead>
      <tbody>
        <tr><td class="term">Departments</td><td class="num">14</td><td class="num">20</td><td class="def">Their sheet has six QC steps and an Ex-factory step that we had no department for. Each became a checkpoint: a date to pass, not a crew.</td></tr>
        <tr><td class="term">Products</td><td class="num">70</td><td class="num">${n(f.articles)}</td><td class="def">Two Betsy chairs on the sheet were not in the item master we had.</td></tr>
        <tr><td class="term">Orders</td><td class="num">12 invented</td><td class="num">${n(f.orders)} from the sheet</td><td class="def">One order per quantity cell: four Edison dispatches, three Betsy stools, and one each of the rest.</td></tr>
        <tr><td class="term">Jobs planned</td><td class="num">168</td><td class="num">${n(f.tasks)}</td><td class="def">Eleven dispatches through twenty steps.</td></tr>
        <tr><td class="term">Jobs that do not fit</td><td class="num">18</td><td class="num">${n(f.breaches)}</td><td class="def">The same count by coincidence; a different eighteen, for a different reason (section 3).</td></tr>
        <tr><td class="term">Days over capacity</td><td class="num">&mdash;</td><td class="num">${n(f.flaggedDays)} of ${n(f.heatDepartments * f.heatDays)}</td><td class="def">At ${rate} a day for everything, any two jobs on one day overload the department.</td></tr>
        <tr><td class="term">Same-day findings</td><td class="num">70</td><td class="num">${n(f.sameDay)}</td><td class="def">Seventy were one mistake in our placeholders. Five are on their sheet itself.</td></tr>
        <tr><td class="term">Needs an answer today</td><td class="num">71</td><td class="num">${n(f.critical)}</td><td class="def">The seventy false findings went; the eighteen misfits and five same-day cases came.</td></tr>
        <tr><td class="term">Time to plan</td><td class="num">about 68 s</td><td class="num">about 37 s</td><td class="def">A database fix made on the way (section 2), not the data.</td></tr>
        <tr><td class="term">Slowest screen</td><td class="num">about 1 s</td><td class="num">about 0.5 s</td><td class="def">The same fix.</td></tr>
      </tbody>
    </table></div>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>2. What happened, step by step</h2>
    <ol class="steps">
      <li><span><strong>We read the sheet the way Nishad told us to.</strong> The HOD date is the dispatch day and day 0. Each number under a step is the day, counted back from dispatch, by which that step must be finished. QC columns are deadlines. The green contractor legend is ignored. Every speed is ${rate} pieces a day, because the sheet has no speeds.</span></li>
      <li><span><strong>We typed the figures into a file and ran them on a test copy first.</strong> Six products, seventeen columns, eleven quantities. The test copy planned them exactly as the live system then did, with one difference we found and fixed: an existing QC department was still carrying a 2% loss, which turned four jobs red that should not have been.</span></li>
      <li><span><strong>Six departments were added and the links between departments redrawn.</strong> Wood QC, Sanding QC, Finish QC, Stitching QC, Upholstery QC and Ex-factory, each hung beside the line so that it checks a step without holding the next one up. Two links changed: Ply Cutting no longer feeds Assembly directly, because the sheet plans them as one step; Fibre now feeds Stapling instead of Stitching, because the sheet puts fibre filling after stitching.</span></li>
      <li><span><strong>Our twelve practice orders were removed and their eleven dispatches entered.</strong> Each named by its product and HOD date &mdash; &ldquo;Edison Counter Stool &middot; 17 Oct (2)&rdquo; &mdash; so a line on screen reads like a line on their sheet. The yellow banner was reworded to say so.</span></li>
      <li><span><strong>The schedule ran.</strong> ${n(f.tasks)} jobs, ${n(f.breaches)} that do not fit, ${n(f.flaggedDays)} overloaded department-days, ${n(f.sameDay)} same-day findings.</span></li>
      <li><span><strong>The Attention screen stopped loading.</strong> With twenty departments one of its checks took longer than the eight seconds the database allows a screen. The cause turned out to be old and general: every access rule in the database was being evaluated once per row instead of once per query. All eighty rules were rewritten. Every screen is now about twice as fast as before the sample, and Attention loads in half a second.</span></li>
      <li><span><strong>A second, unrelated defect surfaced.</strong> A test that had passed for six weeks began failing because a date in it had slid into the past. It was right to fail: the Material screen was raising "order now" for a material the store already held enough of. Fixed, and the fix itself over-corrected and was fixed again the next day.</span></li>
      <li><span><strong>One figure was corrected on U&amp;M's word.</strong> Imogene's Ex-factory is 7 days, not the 21 we read off the picture. Reloaded; nothing else moved.</span></li>
    </ol>

    <h3>What it did to the system that still needs doing</h3>
    <div class="tablewrap"><table>
      <thead><tr><th>Found</th><th>What it means</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td class="term">Masters is a hundred screens tall</td><td class="def">Seventy-two products by twenty departments, printed in full, twice. Nobody scrolls that. The long grids want a filter, paging or a collapsed state.</td><td class="def">To do</td></tr>
        <tr><td class="term">The first screen says "No run yet" while loading</td><td class="def">On a slow connection the Command centre shows dashes and an empty-state sentence for a moment before the figures arrive. It looks like a broken system to a first-time viewer.</td><td class="def">To do</td></tr>
        <tr><td class="term">The bulk-load command predates the twenty departments</td><td class="def">The command that loads a filled-in capacity workbook still assumes fourteen departments and would switch the six QC steps off. It must be updated before PPC's real figures are loaded, and it is a command only we can run.</td><td class="def">To do, before real figures</td></tr>
        <tr><td class="term">QC boxes show a speed of ${n(sheet.checkpoint_rate_per_day)}</td><td class="def">That is how a checkpoint is made to take no time. It is correct and looks odd. Worth a word in any demonstration.</td><td class="def">Explain</td></tr>
        <tr><td class="term">Planning takes about 37 seconds</td><td class="def">Fine for eleven orders. It will not do for U&amp;M's real order book of several hundred, and the fix is a rewrite of the engine's core loop.</td><td class="def">Largest open item</td></tr>
        <tr><td class="term">The scenario list shows our test runs</td><td class="def">Rows named "verify:live probe" on the What if screen are our own checks. Harmless, and odd to explain.</td><td class="def">Cosmetic</td></tr>
      </tbody>
    </table></div>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>3. What the results mean</h2>

    <h3>The ${n(f.breaches)} jobs that do not fit</h3>
    <p>Sixteen belong to the Edison Counter Stool, four dispatches of 152 pieces each, and
      they fail at the same four steps every time: Sanding, Stitching, Stapling and Final
      Packing. The arithmetic is on one line. At ${rate} a day, 152 pieces take almost four
      days. The sheet leaves Sanding two days (Assembly finishes at day 32, Sanding at day
      30), Stitching three, Stapling two and Packing two. Four days of work, two days to do
      it. The other two belong to the Betsy Chair, where Machining and Ply cutting and
      assembly are both on day 34, so the second has no time at all.</p>
    <div class="note amber"><p><strong>None of this is a finding about U&amp;M's factory.</strong>
      It is what their day-counts mean <em>if</em> every department makes ${rate} a day.
      Either the crews are faster, or the days are tighter than they look. They know which.</p></div>

    <h3>The ${n(f.sameDay)} same-day findings</h3>
    <p>Imogene has Machining and Ply cutting and assembly both at day 38, and Cutting and
      Stitching both at day 31. The Betsy Chair has Machining and Ply cutting and assembly
      both at day 34. Kram needs the earlier step to finish before the later one starts, so a
      shared day means no time between them, and it says so rather than guessing. Every one
      of the five is on the sheet; none was introduced by us.</p>

    <h3>The ${n(f.flaggedDays)} overloaded days, and Machining as the constraint</h3>
    <p>A department-day is overloaded when the jobs on it add up to more than one day's
      work. With one speed for everything, any two jobs on the same day do that. So the
      heatmap is redder than a real one would be, and Machining shows as the constraint
      only because it is first in line and carries the most overlap. With real speeds this
      picture changes completely, which is the point of asking for them.</p>

    <h3>Why most of it is in the past</h3>
    <p>Every dispatch on the sheet is in October 2026, and the longest day-count is 57
      days, so the plan puts most of the work in August and September. Nothing has been
      recorded as made, so the system reports it as late. On a live order book the dates
      are ahead of today and this does not arise.</p>

    <h3>Two things the system said when asked</h3>
    <div class="sum">
      <div class="sum__row"><span class="sum__i">Ask</span><span>Can we take ${n(a.qty)} more Edison stools for ${day(a.date)}, when nothing else is planned?</span><span class="sum__v">${esc(a.verdict)}</span></div>
      <div class="sum__row"><span class="sum__i">Try</span><span>What if Sanding ran a second shift?</span><span class="sum__v">${n(w.breachesNow)} &rarr; ${n(w.breachesThen)} misfits</span></div>
    </div>
    <p>The first says the problem is not a crowded factory: even an empty December cannot
      fit 150 pieces into the days the sheet gives those four steps at ${rate} a day. The
      second says doubling Sanding clears every Sanding problem and nothing else:
      ${esc(list(stillShort))} are still short. Both took about a minute and changed nothing.</p>
  </section>

  <!-- ================================================================ -->
  <section>
    <h2>4. Presenting it to the team</h2>
    <p class="lede">Forty-five minutes. The order is: the sum on paper, then the screens,
      then the two live questions, then what we need. Lines in blue are what to say;
      lines in amber are what to click. KRAM/09 has the numbered pictures to hand out.</p>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">Before</span><h3>Set up</h3></div>
      ${click(`Sign in at kraam.netlify.app and leave the Command centre open. Have KRAM/09 printed, one copy each. Do not press <em>Run the schedule</em>; the plan is already there and the button takes 40 seconds.`)}
    </div>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">0 – 3 min</span><h3>Why we are here</h3></div>
      ${say(`You sent us six rows of your planning sheet. We put them into the software exactly as written, and the software planned them. Today you will see what it made of your numbers, and we will ask you where it has misunderstood you.`)}
      ${say(`One thing before we look. Your sheet has day-counts but no speeds. We had to put a speed in to make it calculate, so every department is set to ${rate} pieces a day. That is a stand-in. Everything red you are about to see comes from that one number.`)}
    </div>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">3 – 8 min</span><h3>The sum on paper</h3></div>
      ${click(`Open KRAM/09 at "One order, worked by hand". Read it aloud, slowly.`)}
      ${say(`Edison stool, 152 pieces, dispatch 3 October. Your sheet says Assembly finishes 32 days before, Sanding 30 days before. So Sanding has two days. At ${rate} a day, 152 pieces take nearly four. Four days of work, two days to do it. The software marks Sanding red. That is the whole of what it does, for every step of every order, at once.`)}
      ${say(`So when you see red, ask one question: is the crew faster than ${rate}, or are the days really that tight? You know; we do not.`)}
    </div>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">8 – 28 min</span><h3>The screens, in order</h3></div>
      ${click(`Command centre. Point at the four numbers.`)}
      ${say(`Eleven dispatches became ${n(f.tasks)} jobs, because each goes through twenty steps. ${n(f.breaches)} do not fit. ${n(f.flaggedDays)} department-days are asked for more than a day's work. Machining shows as the constraint. Is that where you feel the squeeze?`)}
      ${click(`Attention. Scroll slowly through the first five cards.`)}
      ${say(`Every problem the software can see, one sentence each, most urgent first. These four are the Edison stool. This one is different: your sheet gives Assembly and Machining the same day on the Imogene chair, and the software asks which really comes first. Would your team work from a list like this each morning?`)}
      ${click(`Schedule. Stay on the first block.`)}
      ${say(`This is your sheet's first row, drawn as bars. Each bar is one department's work; the black line is your deadline. Red bars are the ones that do not fit. The little bars are QC: a date to pass, not days of work. Is this the order the work really goes in?`)}
      ${click(`Load heatmap. Click the darkest red square in the Sanding row.`)}
      ${say(`One row per department, one square per day. Red means more than a day's work. This day has three dispatches each wanting the whole of Sanding. With one speed for everything, any two jobs on one day do this. Do you really run several products through one department on the same day, and who decides which goes first?`)}
      ${click(`Order book.`)}
      ${say(`One line per quantity on your sheet, named by product and HOD date. The last column is how many steps of that order do not fit. Six of eleven fit completely. We made each quantity its own order; tell us if several belong to one customer order.`)}
      ${click(`Capacity sheet. Press D-minus, then type 125043138 in the search box.`)}
      ${say(`This row is your sheet's row. Now press Units per day. Every box says ${rate}. These are the boxes we need from you: how many pieces a day, working on nothing else, and how many people. The QC boxes say ${n(sheet.checkpoint_rate_per_day)}; that is just how we tell it QC takes no time.`)}
      ${click(`Factory map.`)}
      ${say(`What waits for what, drawn from the order of your columns. Thick borders start on their own. QC steps sit beside the line. Two of these lines are our guesses: fibre after stitching, and ply cutting waiting for machining. Correct this page with a pen.`)}
    </div>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">28 – 36 min</span><h3>Two live questions</h3></div>
      ${click(`Accept an order. Choose the Edison stool, ${n(a.qty)}, ${day(a.date)}. Press Check. It takes about a minute: take questions while it runs.`)}
      ${say(`We are asking: can we promise ${n(a.qty)} more for mid-December, when nothing else is planned? The answer: ${esc(a.verdict.toLowerCase())} Sanding, Stitching, Stapling and Packing again. The factory is empty in December; the days the sheet gives those steps are the problem. This is the screen that answers "can we take this order" before anyone promises.`)}
      ${click(`What if. Type "Sanding with a second shift", choose Sanding, press Second shift, press Run it. About a minute.`)}
      ${say(`We are trying a change without touching the real plan. Doubling Sanding takes the misfits from ${n(w.breachesNow)} to ${n(w.breachesThen)} and clears every Sanding problem. ${esc(list(stillShort))} are still short. This is "what would it take", answered before spending anything.`)}
    </div>

    <div class="beat">
      <div class="beat__head"><span class="beat__min">36 – 45 min</span><h3>What we need, and what happens next</h3></div>
      ${click(`Open KRAM/09 at "What we need from you". Go through the nine questions. Write the answers on the printed copy.`)}
      ${say(`Three things turn this from a sample into your plan. Your speeds, product by department. The Excel file itself. And answers to these nine questions. Once the speeds are in, the red means something, and we move to your real order book.`)}
    </div>

    <h3>Questions you will be asked, and the answers</h3>
    <div class="qa">
      <div><b>Why is everything red?</b> Because every department is set to ${rate} a day. Give us real speeds and most of it goes, or what is left is real.</div>
      <div><b>Why are the dates in August and September?</b> Your dispatches are in October and the longest lead is 57 days. The software counts back from dispatch. On a live order book the dates are ahead.</div>
      <div><b>Can we change a number and see what happens?</b> Yes, on the Capacity sheet or Masters: click, type, Enter, and it re-plans in 40 seconds. It changes the sample for everyone, which is fine; that is how real figures go in. To try something without changing anything, use What if.</div>
      <div><b>What if we have time per piece, not pieces per day?</b> Send that with the crew size and shift hours; we convert it.</div>
      <div><b>Why do QC steps show 10,000?</b> A checkpoint is made to take no time by giving it a speed nothing can exceed. It is correct and looks odd; worth hiding in a later version.</div>
      <div><b>Does it handle two shifts, overtime, a machine down?</b> Yes. Shifts and head counts are on Masters, attendance on Manpower, machine downtime on Masters; each changes what a day can make. What if lets you try any of them first.</div>
      <div><b>Can orders come from Panipuri instead of being typed?</b> That is built next, as soon as we have one sample export to build the mapping against.</div>
      <div><b>Who can see what?</b> Each person gets a login and a role; the database enforces what each role may read and write. Which roles see which screens is one of the decisions we need from you.</div>
      <div><b>Why does planning take 40 seconds?</b> It re-plans every order from nothing and keeps every version. Fine for eleven orders; for several hundred it needs the rewrite that is next on our list.</div>
      <div><b>Two steps on the same day: is that wrong?</b> Only if one has to finish before the other starts. If they really run side by side, we remove the link between them and the finding goes.</div>
    </div>
  </section>

  <!-- ================================================================ -->
  <section class="pagebreak">
    <h2>5. How each function works</h2>
    <p class="lede">The engine first, because every screen is a view of what it
      produced. Then the twenty screens, in the groups a day is lived in.</p>

    <h3>The planning engine</h3>
    <ol class="steps">
      <li><span><strong>Start from the container.</strong> Every shipment line has a stuffing date. Nothing is planned forwards from today; everything is counted back from that date.</span></li>
      <li><span><strong>Place each department's deadline.</strong> For each product, each department has a D-minus: how many days before stuffing it must finish. Stitching at D-20 is due 20 working days before. Sundays and declared holidays are skipped.</span></li>
      <li><span><strong>Work out how many pieces each department must make.</strong> The shipped quantity, inflated for the losses of every department after it. At 98% yield, each earlier step makes a little more so that enough survives.</span></li>
      <li><span><strong>Work out how many days that takes.</strong> Pieces to make, divided by the department's rate for that product. The rate is what the department makes in a day doing nothing else, which is what lets several products share a day correctly.</span></li>
      <li><span><strong>Start that many working days before the deadline.</strong> That gives each job a start and an end.</span></li>
      <li><span><strong>Check the runway.</strong> A job may not start before everything that feeds it is due. If it would have to, it is a <em>runway</em> breach: fewer working days than the department needs. Overtime cannot fix it; only an earlier feeder or a faster rate can.</span></li>
      <li><span><strong>Add up every department's day.</strong> Each job on a day takes a fraction of it (pieces that day divided by rate). Fractions add; pieces do not. A day over 1.00 is flagged. Capacity on a day is the rate, scaled by shifts, who came in, overrides and machines down.</span></li>
      <li><span><strong>Keep the run.</strong> Every run is written as a new version and none is overwritten, so any earlier plan can be compared with what was then made.</span></li>
    </ol>

    <h3>Plan</h3>
    <div class="fns">
      ${fn('Command centre', { menu: 'Planner', purpose: 'The whole plan in four numbers, and the button that makes it.', how: 'Counts shipment lines, jobs, breaches and flagged days from the current run; ranks departments by average and peak load to name the constraint; lists the soonest overloaded days with a label for what is still possible at that lead time.', needs: 'Nothing beyond orders and masters.', sample: `${n(f.lines)} lines, ${n(f.tasks)} jobs, ${n(f.breaches)} breaches, ${n(f.flaggedDays)} flagged days; ${esc(f.constraint)} the constraint.` })}
      ${fn('Schedule', { menu: 'Planner', purpose: 'Every job on a calendar.', how: 'One bar per job from start to deadline, grouped by shipment line, with the breach reason at the end of the row. Dragging a bar pins it to a date, asks for a reason, and every later run honours the pin.', sample: 'Read top to bottom, each block is one row of their sheet.' })}
      ${fn('Load heatmap', { menu: 'Planner, MD', purpose: 'Which days are too full.', how: 'One cell per department per day, shaded by the sum of fractions of the day the jobs on it take. Clicking a cell lists the jobs and their share.', sample: `${n(f.heatOver)} red cells of ${n(f.heatDepartments * f.heatDays)}.` })}
      ${fn('Factory map', { menu: 'Everyone', purpose: 'What waits for what.', how: 'Draws the department graph left to right by depth; red where any day is over capacity; thick border for departments nothing feeds. A flow map, not a floor plan.', sample: 'Twenty boxes, with the six QC steps beside the line.' })}
      ${fn('Capacity sheet', { menu: 'PPC', purpose: 'The grid every other number is arithmetic on.', how: 'Products down, departments across; three views of the same cell: rate, crew, D-minus. A blank rate means the product does not go there. Lists the same-day contradictions and whether they are currently causing breaches.', needs: 'A rate and a D-minus for every product in every department it passes through.', sample: `${n(f.articles)} products by ${n(f.heatDepartments)} departments; every sample rate ${rate}.` })}
      ${fn('Masters', { menu: 'PPC, planner', purpose: 'What the factory is.', how: 'Departments and yields, what feeds what, shifts and head counts, products, machines and downtime, the D-minus matrix, rates, holidays, bills of materials. Underlined values are editable in place and re-plan on Enter. Save to a file and load from a file merge by code.', needs: 'The real route, shifts and holidays.' })}
    </div>

    <h3>Decide</h3>
    <div class="fns">
      ${fn('Attention', { menu: 'Management, planner', purpose: 'Everything needing an answer, most urgent first.', how: 'Nine checks run as one list: breaches, overloaded days, material past its ordering date, material short, same-day contradictions, machines down, products that cannot be planned, handover mismatches, departments with no shift. Critical when the deadline is within a fortnight. There is deliberately no way to dismiss one.', sample: `${n(f.critical)} critical, ${n(f.warnings)} warnings.` })}
      ${fn('Accept an order', { menu: 'Merchandiser, planner', purpose: 'Can we take this order? Asked before promising.', how: 'Adds the proposed line to a copy of the book, runs the full engine, reports every step with its dates and verdict, and removes the line again. Nothing is saved. About a minute.', sample: `${n(a.qty)} Edison stools for ${day(a.date)}: ${esc(a.verdict.toLowerCase())}` })}
      ${fn('What if', { menu: 'Planner', purpose: 'Try a change on a copy of the plan.', how: 'A capacity multiplier on one department over a window: department down (0), overtime (1.2), second shift (2). Planned as its own run beside the live one, compared department by department and job by job. Can be promoted to become the plan.', sample: `Sanding doubled: ${n(w.breachesNow)} to ${n(w.breachesThen)} breaches, ${n(w.flaggedNow)} to ${n(w.flaggedThen)} flagged days.` })}
      ${fn('Order book', { menu: 'Merchandiser', purpose: 'Every promise, and where new orders are entered.', how: 'An order has shipment lines, each with its own stuffing date; the line is the unit planned. Adding an order re-plans immediately. The breaches column counts the steps of that order that do not fit.', needs: 'Orders typed in until the Panipuri import exists.', sample: `${n(f.orders)} orders, one per quantity cell, named by product and HOD date.` })}
    </div>

    <h3>Run the day</h3>
    <div class="fns">
      ${fn('Production', { menu: 'Supervisors', purpose: "Writing down what was made.", how: "Pick department and date; the plan's work list for that day appears; enter good and rejected pieces, and who came in. Good and rejected are counted separately; the percentage is derived, never typed. Entering output does not move dates.", needs: 'Two minutes a day per department.' })}
      ${fn('My department', { menu: 'Department heads', purpose: "One department's work list for today.", how: 'What is due today or overdue, what is waiting on feeders, with the feeders named. Late work is separated from not-yet-due.' })}
      ${fn('Floor display', { menu: 'A television', purpose: 'The same list, full screen, no menu.', how: 'Remembers its department across a power cut; refreshes every minute.' })}
      ${fn('Manpower', { menu: 'Dept heads, HR', purpose: 'Who came in, and the capacity that follows.', how: 'Attendance per person or as a head count; the day’s capacity scales in proportion to the sanctioned crew, and overtime is recorded as hours worked. A shortfall is shown in hours and people.', needs: 'Attendance, daily.' })}
      ${fn('WIP', { menu: 'Merchandiser, MD', purpose: 'Where every order physically is.', how: 'Built from declarations and two-sided handovers: a department declares what it made, the next counts what it received, and a shortfall is kept rather than smoothed. Shows progress through the route and what is ready to stuff.' })}
    </div>

    <h3>Watch</h3>
    <div class="fns">
      ${fn('Dashboard', { menu: 'MD', purpose: 'Is the factory on track today, in nine figures.', how: 'Orders running, OTIF, daily production, WIP, WIP value, efficiency, rejections, material shortages, delayed orders, each against a target. A figure that cannot be computed says what it is waiting for rather than showing a zero.' })}
      ${fn('Quality', { menu: 'Quality, MD', purpose: 'Where the losses come from.', how: 'Rejections by cause as a Pareto, by department against the yield its master claims, and by product. A department with nothing declared is absent rather than shown at zero.' })}
      ${fn('Material', { menu: 'Purchase, store', purpose: 'What to buy, and the last day it can be ordered.', how: "Bill of materials times the plan gives what is needed and when, counted back from the day the using department starts, less the supplier's lead time in calendar days. Compared against a counted stock: covered, short, or not counted.", needs: 'Materials per product, lead times, stock counts.' })}
      ${fn('Money', { menu: 'Accounts', purpose: 'Cash going out, week by week.', how: 'A cost per product, priced across the plan by the week each job starts; supplier commitments from the material plan. Declares what it cannot price rather than estimating.', needs: 'A cost per product.' })}
      ${fn('Forecast', { menu: 'MD, planner', purpose: 'What the factory really achieves.', how: 'Measures each rate from declared production and compares it with the rate the master claims; bands each shipment line by risk. Refuses to forecast from fewer declarations than it trusts, and says so.' })}
    </div>

    <h3>Administer</h3>
    <div class="fns">
      ${fn('Users', { menu: 'Administrators', purpose: 'Who can sign in, and what each role may do.', how: 'Accounts are created by an administrator; roles are assigned here. The database, not the screen, enforces what each role can read and write, so there is no way round it from a browser.', needs: 'A name and a role for each person.' })}
      ${fn('The yellow banner', { purpose: 'Says the figures are placeholders.', how: 'Shown on every screen while the database holds figures entered by us rather than confirmed by U&M. It names what went in and how it is removed. It comes down when the sample is purged, and real figures loaded over the stand-ins must replace them before that.' })}
    </div>
  </section>

  <footer>
    <span>DBBS/UM/KRAM/10 &middot; Rev A &middot; figures from the live plan of ${esc(asOf)}</span>
    <span>Sample data. Not a production plan.</span>
  </footer>
</div>
`

await writeFile(`${repoRoot}docs/sample-report.html`, page)
console.log('Wrote docs/sample-report.html')
