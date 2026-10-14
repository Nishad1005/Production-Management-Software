/**
 * The ask to U&M, 15 Oct — DBBS/UM/KRAM/15, docs/request-rates-and-handover-days.html.
 *
 *   node scripts/make-request-figures.mjs
 *   node scripts/make-pdf.mjs docs/request-rates-and-handover-days.html
 *
 * One page for U&M, in factory language: what we need from them now, why,
 * and in what form — from §8.4 of the log and the 14 Oct D-minus entry. No
 * figures are read from the system; this is a letter, not a report.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { docStyle } from './lib/doc-style.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const html = `<title>Kram — What we need from you now</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${docStyle}
<style>
  ol.asks { padding-left: 1.2em; }
  ol.asks li { margin: 0 0 9px; }
  ol.asks li strong { display: block; }
  .form { color: var(--mid); font-size: 9.5pt; }
</style>

<div class="doc">
  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>What we need from you now</h1>
      <p class="sub">Kram runs on your items, your departments and your route. The numbers in it are still ours &mdash; stand-ins,
        the same speed for everything. Five things from you turn it into your factory. They are listed in the order that
        matters, with what each one changes on the screens and the form it is easiest to give it in.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/15 &middot; Rev A &middot; for U&amp;M Designs</dd>
      <dt>For</dt><dd>PPC, with the MD</dd>
      <dt>Dated</dt><dd>15 October 2026</dd>
    </dl>
  </header>

  <section>
    <h2>The five things</h2>
    <ol class="asks">
      <li>
        <strong>How many pieces a day each department makes of each item, and with how many people.</strong>
        This is the one figure everything else rests on. Today every department is planned at the same stand-in speed,
        so every date, every red square on the heatmap and every answer on <em>Accept an order</em> is a placeholder.
        With your figures the dates are yours.
        <div class="form">Form: the capacity workbook (KRAM/04). <em>Blank workbook</em> on the Capacity sheet hands it out
        already filled with your items and departments; one row per item, two boxes per department &mdash; pieces a day
        when the department is working on nothing else, and the crew that figure was measured with. Load it back on the
        same screen. Where a figure is not known, leave the box blank rather than guessing: a blank is honest and the
        screen says so.</div>
      </li>
      <li>
        <strong>For each department: once it finishes a lot, how many days before the next department can start on it.</strong>
        Drying after finishing, inspection, moving the lot, the margin you keep before packing. About twenty numbers,
        one per department, the same whatever the item and however many pieces. With these and the speeds above, the
        system can work out the D-minus for every order itself &mdash; a 300-piece order and a 1,000-piece order of the same
        item get different dates, as you told us they should &mdash; instead of PPC keeping a sheet of day-counts per item.
        <div class="form">Form: a list, department by department, in days. Zero is a valid answer.</div>
      </li>
      <li>
        <strong>Does Machining feed Ply Cutting?</strong>
        The route we hold says it does. Your sheet does not say either way: Machining's day-count sits beside a combined
        <em>Ply cutting and assembly</em> column. If Ply Cutting does not wait for Machining, one connection is removed on
        Masters and one breach on the sample plan goes with it.
        <div class="form">Form: yes or no, from whoever runs the wood shop.</div>
      </li>
      <li>
        <strong>One real export from Panipuri.</strong>
        An order list as the ERP gives it, any week, any format. It decides how orders will reach Kram without being typed,
        and one question only the file can answer: does Panipuri hold the container stuffing date, or only the customer's
        delivery date?
        <div class="form">Form: the file itself (KRAM/05 asked for this on 17 August).</div>
      </li>
      <li>
        <strong>For three or four items: what goes into them, and what they cost.</strong>
        The bill of materials and the article cost. The Material screen can then say what is short against the store, and
        the Money screen what the plan will spend, week by week. Three items are enough to show it working; the rest can
        follow.
        <div class="form">Form: however it exists today &mdash; a costing sheet, a BOM print, a photo of either.</div>
      </li>
    </ol>
  </section>

  <section>
    <h2>Two smaller ones</h2>
    <ol class="asks" start="6">
      <li>
        <strong>Who should see what.</strong> Kram has a screen for each role &mdash; the HOD, HR, maintenance, stores, merchandising,
        PPC, the MD. Today every role can read every screen. Tell us if that is wrong: should maintenance see the customer
        order book, should stores see commercial quantities?
        <div class="form">Form: a sentence or two. And the names and email addresses of the people who will use it, so their accounts can be made.</div>
      </li>
      <li>
        <strong>The overtime ceiling.</strong> The shift settings hold a maximum of five overtime hours a person a day. If
        your compliance adviser's figure is different, the plan should use theirs.
        <div class="form">Form: a number of hours.</div>
      </li>
    </ol>
  </section>

  <section>
    <h2>What happens when they arrive</h2>
    <p>The workbook loads in one go and the plan re-runs on your speeds the same day. The handover days take one change on
    our side, after which the D-minus is printed per order rather than typed. The route answer is one click. The Panipuri
    file is read once by us and then every week by the system. The three items' costs go onto the Capacity sheet and the
    Material and Money screens fill. Nothing you send is changed by us: a figure you gave is a figure the screen shows,
    and the screen says where each one came from.</p>
  </section>

  <footer>
    <span>DBBS/UM/KRAM/15 &middot; Rev A</span>
    <span>Data Brilliance Business Solutions LLP &middot; 15 October 2026</span>
  </footer>
</div>
`

await writeFile(`${repoRoot}docs/request-rates-and-handover-days.html`, html)
console.log('Wrote docs/request-rates-and-handover-days.html')
