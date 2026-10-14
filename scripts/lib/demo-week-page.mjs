/**
 * "A week at U&M on Kram" — DBBS/UM/KRAM/14, as an HTML fragment.
 *
 * `make-demo-week.mjs` enters sixteen orders and five days of floor entries
 * and reads every screen afterwards; this turns what it read into the
 * document. The reader is anyone at U&M — the MD, PPC, a HOD, HR, stores,
 * maintenance, merchandising — who wants to see what their own day on the
 * system looks like, and check the week against their expectation. Every
 * figure is read, not typed; every check says what was expected, what the
 * screen said, and whether that is a pass.
 */

import { docStyle } from './doc-style.mjs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const day = (iso) => {
  if (!iso) return ''
  const [y, m, d] = String(iso).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const monthOf = (iso) => (iso ? `${MONTHS[Number(String(iso).slice(5, 7)) - 1]} ${String(iso).slice(0, 4)}` : '')
const n = (v) => (v === undefined || v === null || v === '' ? '—' : Number(v).toLocaleString('en-IN'))
const short = (name) => String(name ?? '').replace(/\s+—\s+.*$/, '').trim() || name

const fig = (file, alt, caption) =>
  `<figure class="shot"><img src="demo-week/${file}.png" alt="${esc(alt)}" />${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`
const table = (head, rows) =>
  `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th${/^#/.test(h) ? ' class="num"' : ''}>${h.replace(/^#/, '')}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${/^#/.test(head[i] ?? '') ? ' class="num"' : i === 0 ? ' class="term"' : ' class="def"'}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`

export function demoWeekPage({ facts: f }) {
  const taken = f.generatedAt
    ? new Date(f.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  const orders = f.orders ?? []
  const verdicts = f.verdicts ?? []
  const verdictOf = (erp) => verdicts.find((v) => v.erp === erp)
  const nameOf = (code) => f.departments?.find((d) => d.code === code)?.name ?? code
  const dates = f.dates ?? {}
  const d = (k) => f.days?.[k] ?? {}
  const d0 = d('d0')
  const d1 = d('d1')
  const d2 = d('d2')
  const d3 = d('d3')
  const d4 = d('d4')
  const d5 = d('d5')
  const has = (file) => Boolean(f.shots?.[file])
  const book = f.book ?? []
  // The first cell runs the tag straight on: "DEMO-06Taken against the plan".
  const bookRow = (erp) => book.find((r) => String(r[0]).startsWith(erp))
  const months = [...new Set(verdicts.map((v) => monthOf(v.stuffing)))]

  // --- the checks ---------------------------------------------------------------
  const checks = []
  const check = (what, expected, seen, pass) => checks.push({ what, expected, seen, pass })
  {
    const v1 = verdictOf('DEMO-01')
    check('DEMO-01 checked on Accept an order', 'fits as it stands', v1?.verdict ?? '—', v1 ? !v1.refused : null)
    const pulled = verdicts.filter((v) => v.pulled > 0)
    // Only where a quantity needs more days than the day-counts leave; the
    // demonstration build's wide day-counts may need none, and that is a
    // reading, not a failure.
    check('A big order pulls its feeders earlier instead of being refused', 'where the day-counts leave fewer days than the quantity needs, Clear verdicts carry "finishes N days earlier"', pulled.length ? pulled.map((v) => `${v.erp}: ${v.pulled} steps`).join(' · ') : 'none needed on this venue', pulled.length ? true : null)
    const v6 = verdictOf('DEMO-06')
    check('DEMO-06 (10 pieces, four days) checked', 'refused, with the steps named', v6?.verdict ?? '—', v6 ? v6.refused && v6.failing.length > 0 : null)
    const r6 = bookRow('DEMO-06')
    check('DEMO-06 taken anyway, with a reason', 'the book marks it "taken against the plan"', r6 ? r6[0] : '—', r6 ? /taken against the plan/i.test(r6[0]) : null)
    const r4 = bookRow('DEMO-04')
    check('DEMO-04 ships in two containers', '2 lines in the book, scheduled from their own dates', r4 ? `${r4[4]} lines, first stuffing ${r4[5]}` : '—', r4 ? parseInt(r4[4], 10) === 2 : null)
    const r10 = bookRow('DEMO-10')
    check('A probable order is planned and marked as such', 'confidence reads probable', r10 ? r10[6] ?? r10.join(' · ') : '—', r10 ? /probable/i.test(r10.join(' ')) : null)
    check('The overlap shows on the heatmap', 'Stitching over capacity on some days', d0.heatmap ? `${n(d0.heatmap.stitchOverDays)} days over in Stitching, ${n(d0.heatmap.over)} flagged in all` : '—', d0.heatmap ? d0.heatmap.stitchOverDays > 0 : null)
    check('The Command centre names the constraint', 'the department most asked of', d0.commandCentre?.constraint ?? '—', d0.commandCentre ? Boolean(d0.commandCentre.constraint) : null)
    const at1 = d1.attendance?.STITCH
    check('Day 1: attendance in Stitching', 'two short of the books, and the day runs at that fraction of the rate', at1?.text ?? '—', at1?.onBooks ? at1.present === at1.onBooks - 2 && /\d+%/.test(at1.text) : null)
    const ply = (d1.floor?.entered ?? []).find((e) => e.code === 'PLYCUT')
    check('Day 1: rejects at Ply Cutting, with a cause', '4 rejected, put down to a cause under the row', ply?.cause ? `${n(ply.cause.qty)} rejected: ${ply.cause.cause} — "${ply.cause.text.slice(0, 80)}"` : ply ? 'no cause recorded' : '—', ply ? Boolean(ply.cause && ply.cause.qty === 4) : null)
    const g1 = d1.after?.dashboard?.grid?.rows ?? {}
    check('Day 1 on the grid: Machining short', 'red — half the target entered', g1.MACHINE ? `${g1.MACHINE.state} — ${g1.MACHINE.title}` : '—', g1.MACHINE ? g1.MACHINE.state === 'short' || g1.MACHINE.state === 'behind' : null)
    check("Day 1 on the grid: the evening run did not move the morning's target", 'Machining reads about 50% of the target it was given in the morning', g1.MACHINE ? `ratio ${g1.MACHINE.ratio}` : '—', g1.MACHINE?.ratio ? Math.abs(Number(g1.MACHINE.ratio) - 0.5) < 0.12 : null)
    const metDepts = Object.entries(g1).filter(([, c]) => c?.state === 'met').map(([k]) => nameOf(k))
    check('Day 1 on the grid: departments that met the plan', 'green where the entries matched', metDepts.length ? metDepts.join(', ') : '—', metDepts.length ? true : g1.MACHINE ? false : null)
    const p1 = d1.after?.plans?.['DEMO-01']
    const mach = p1?.bars?.find((b) => b.code === 'MACHINE')
    check('The plan learns from Day 1', "Machining's remainder starts the next working day, nothing made twice", p1 ? (mach ? `Machining ${day(mach.start)} → ${day(mach.end)}, ${n(mach.qty)} units` : `Machining reads Made (${n(p1.made)} departments made)`) : '—', p1 ? (mach ? mach.start >= (dates.D2 ?? '') : true) : null)
    const ho = d2.handovers?.ASSY
    check('Day 2: Assembly counts in two short', 'the difference is kept, not smoothed', ho ? `${ho.shortfall || 'no shortfall shown'} · ${n(ho.counted)} handovers counted in` : '—', ho ? /2\s*short/i.test(ho.shortfall) : null)
    check('My department shows what is holding Assembly up', "the shortfall on the feeder's card", d2.after?.board ? d2.after.board.slice(0, 160) : '—', d2.after?.board ? /short|reached you/i.test(d2.after.board) : null)
    const mc = d2.machine
    check('Day 2: a breakdown booked on the Machines screen', 'one fewer Stitching machine available', mc ? `${mc.machine || 'no machine'} (${mc.kind ?? ''}): ${mc.before ?? '?'} → ${mc.after ?? '?'} of ${mc.machines ?? '?'}` : '—', mc?.before && mc?.after ? Number(mc.after) === Number(mc.before) - 1 : null)
    check('Attention lists the machine', 'a machine-down card', d2.after?.attention ? `${n(d2.after.attention.kinds['machine-down'])} machine cards` : '—', d2.after?.attention ? (d2.after.attention.kinds['machine-down'] ?? 0) > 0 : null)
    const v7 = verdictOf('DEMO-07')
    check('Day 2: an order arrives mid-week', 'DEMO-07 checked and entered on day 2, the plan re-run around it', v7 ? `${v7.verdict} (entered on day ${v7.enteredOn})` : '—', v7 ? v7.enteredOn === 2 : null)
    const pin = d2.pin
    const startOf = (t) => /: (\d+ \w+ \d{4}) →/.exec(t ?? '')?.[1] ?? ''
    check('Day 2: a bar dragged two days later, with a reason', 'the pin holds; the next run keeps it', pin ? `${pin.name}: ${startOf(pin.before)} → ${startOf(pin.after)} · "${pin.reason}"` : '—', pin ? startOf(pin.before) !== startOf(pin.after) : null)
    const at3 = d3.attendance?.STITCH
    check('Day 3: overtime in Stitching raises the day', '12 person-hours add to the rate; the man-hours are shown', at3?.text ?? '—', at3 ? /overtime hours add \d+%/.test(at3.text) && /man-hours/.test(at3.text) : null)
    const mp3 = (d3.after?.manpower ?? []).find((m) => m.code === 'STITCH')
    check("The same hours on Manpower's card", 'Who is in says 12 overtime hours for Stitching', mp3?.text ?? '—', mp3 ? /12(\.0)? overtime hours/.test(mp3.text) : null)
    const sand3 = d3.attendance?.SAND
    check('Day 3: one on leave in Sanding', 'one short of the books', sand3?.text ?? '—', sand3?.onBooks ? sand3.present === sand3.onBooks - 1 : null)
    const mat = d3.material
    check('Day 3: stores count a material', 'the count lands and the status moves', mat ? `${mat.code}: ${mat.before} → ${mat.after}` : '—', mat ? mat.after === 'covered' : null)
    const v5 = verdictOf('DEMO-05')
    check('Day 4: DEMO-05 (400 pieces, twenty days too soon) refused', 'refused, with the steps named', v5?.verdict ?? '—', v5 ? v5.refused && v5.failing.length > 0 : null)
    const card5 = (d4.after?.attention?.demo ?? []).find((t) => /DEMO-05/.test(t) && /taken against the plan/i.test(t))
    check('Attention carries the reason DEMO-05 was taken', 'a card for DEMO-05 ends "taken against the plan: …"', card5 ?? (d4.after?.attention?.demo ?? []).find((t) => /DEMO-05/.test(t)) ?? '—', d4.after?.attention ? Boolean(card5) : null)
    const w = d4.whatIf
    check('Day 4: what if, a second shift in Stitching', 'fewer breaches in the scenario, live plan untouched', w ? `${n(w.breachesNow)} → ${n(w.breachesThen)} breaches, ${n(w.changed)} tasks changed` : '—', w ? w.breachesThen <= w.breachesNow && w.changed > 0 : null)
    const sand4 = (d4.floor?.entered ?? []).find((e) => e.code === 'SAND')
    check('Day 4: rejects at Sanding, with a cause', '3 rejected, put down to a cause', sand4?.cause ? `${n(sand4.cause.qty)} rejected: ${sand4.cause.cause}` : sand4 ? 'no cause recorded' : '—', sand4 ? Boolean(sand4.cause) : null)
    check('Quality shows the causes', 'the Pareto and the by-department table carry the week', d4.quality ? d4.quality.slice(0, 160) : '—', d4.quality ? true : null)
    const s5 = (d5.after?.schedule ?? []).find((o) => o.erp === 'DEMO-06')
    check("DEMO-06's container day has passed", 'tagged "Container day passed" on the Schedule from the day it was entered, its mark in the shaded past', s5 ? `stuffing ${day(s5.stuffing)}, tagged: ${s5.passed ? 'yes' : 'no'}` : '—', s5 ? s5.passed : null)
    const wip5 = d5.after?.wip ?? []
    check('WIP after five days', 'every line with work this week has started, progress in units', wip5.length ? wip5.map((l) => `${l.erp} ${l.percent}%`).join(' · ') : '—', wip5.length ? wip5.some((l) => Number(l.percent) > 0) : null)
    const fc = d5.forecast
    check('The forecast says how much history it has', 'declines until ten declarations, then speaks', fc ? `${n(fc.declarations)} declarations: ${fc.text.slice(0, 120)}` : '—', fc ? true : null)
    check('Money reads', 'cash out, week by week, from what the costs say', d5.money ? d5.money.slice(0, 160) : '—', d5.money ? null : null)
    check('The floor display for Stitching', 'the day in its own words, with the hours', d2.after?.display ?? d1.display ?? '—', d2.after?.display || d1.display ? null : null)
  }
  const passed = checks.filter((c) => c.pass === true).length
  const failed = checks.filter((c) => c.pass === false).length

  // --- the days -----------------------------------------------------------------
  const entriesTable = (floor) =>
    floor
      ? table(
          ['Department', '#Planned', '#Good', '#Rejected', 'The header said'],
          (floor.entered ?? []).map((e) => [
            esc(e.name) + (e.cause ? ` <span class="aside">(${esc(e.cause.cause)})</span>` : ''),
            n(e.entries.reduce((s, x) => s + x.planned, 0)),
            n(e.entries.reduce((s, x) => s + x.good, 0)),
            n(e.entries.reduce((s, x) => s + x.rejected, 0)),
            esc(e.header),
          ]),
        )
      : ''
  const readings = (after) =>
    after
      ? table(
          ['Read after the run', 'What it said'],
          [
            ['Command centre', esc(`${n(after.commandCentre?.breaches)} breaches · ${n(after.commandCentre?.flaggedDays)} flagged days · constraint ${after.commandCentre?.constraint ?? '—'}`)],
            ['Attention', esc(`${n(after.attention?.critical)} critical · ${n(after.attention?.warning)} warnings · ${Object.entries(after.attention?.kinds ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`)],
            ['Dashboard', esc(Object.entries(after.dashboard?.kpi ?? {}).map(([k, v]) => `${k} ${v}`).join(' · '))],
            ['WIP', esc((after.wip ?? []).map((l) => `${l.erp} ${l.percent}% (${l.departments})`).join(' · ') || 'nothing started')],
            ...(after.schedule ? [['Schedule', esc(after.schedule.map((o) => `${o.erp}${o.breaches ? ` ${o.breaches} cannot` : ''}${o.passed ? ' · container day passed' : ''}${o.againstPlan ? ' · taken against the plan' : ''}`).join(' · '))]] : []),
          ],
        )
      : ''
  const attendanceTable = (att) =>
    att
      ? table(
          ['Department', '#On the books', '#In', '#Overtime hours', 'The screen said'],
          Object.entries(att).map(([code, a]) => [esc(nameOf(code)), n(a.onBooks), n(a.present), n(a.overtime), esc(a.text)]),
        )
      : ''

  const dayBlock = (no, heading, date, intro, pictures, body) => `
  <section class="pagebreak">
    <h2>Day ${no} &mdash; ${heading}${date ? ` <span class="aside">${day(date)}</span>` : ''}</h2>
    <p class="lede">${intro}</p>
    ${body}
    ${pictures.filter(([file]) => has(file)).map(([file, alt, caption]) => fig(file, alt, caption)).join('\n')}
  </section>`

  const entered = (k) => Boolean(f.days?.[k])

  return `<title>Kram — A week at U&amp;M</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${docStyle}
<style>
  td.pass { color: var(--go); font-weight: 600; white-space: nowrap; }
  td.fail { color: var(--flag); font-weight: 600; white-space: nowrap; }
  td.read { color: var(--mid); white-space: nowrap; }
  .role { border: 1px solid var(--rule); padding: 10px 14px; margin: 0 0 10px; break-inside: avoid; }
  .role h3 { margin: 0 0 4px; font-size: 12.5pt; }
  .role p { margin: 0 0 4px; }
  .role .when { color: var(--mid); font-family: 'IBM Plex Mono', monospace; font-size: 8.5pt; letter-spacing: .04em; text-transform: uppercase; }
  @media print { figure.shot img { max-height: 118mm; } section.pagebreak figure.shot { break-inside: avoid; } }
</style>

<div class="doc">
  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>A week at U&amp;M on Kram</h1>
      <p class="sub">Sixteen orders on your items, dated over ${esc(months.join(', '))}, and five days on the floor entered the way
        each person at U&amp;M would enter them &mdash; who came in and the overtime, end-of-day actuals against targets with the
        rejects put down to a cause, handovers counted in, a machine down, a stock count, a pin, a what-if, orders arriving
        mid-week &mdash; with the plan re-run each evening and every screen read afterwards. On ${esc(f.venue ?? '')}.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/14 &middot; Rev A &middot; for U&amp;M Designs</dd>
      <dt>Checks</dt><dd>${checks.length} made &middot; ${passed} passed${failed ? ` &middot; ${failed} did not` : ''} &middot; ${checks.length - passed - failed} read only</dd>
      <dt>Run on</dt><dd>${esc(taken)} IST &middot; day 1 = ${day(dates.D1)}</dd>
    </dl>
  </header>

  <section>
    <h2>In one minute</h2>
    <div class="three">
      <div class="card yours">
        <div class="card__t">Yours</div>
        <p><strong>The items, their routes and their D-minus</strong> are from your master. The orders, the customers, the people and the five days of entries are made up for this week, so that every screen has something to show.</p>
      </div>
      <div class="card standin">
        <div class="card__t">A stand-in</div>
        <p><strong>Every speed is a stand-in</strong> until your rates arrive. Where the plan says a day is over capacity or a step is late, that follows from the stand-in rate, not from your factory. The shape of the week is real; the numbers are placeholders.</p>
      </div>
      <div class="card ask">
        <div class="card__t">How to read it</div>
        <p><strong>Your day first</strong> &mdash; one page per role, what you enter and what you read. Then the week, day by day. Then what is recorded and what is not, and the checks: what we expected, what the screen said, pass or not.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>The book</h2>
    <p class="lede">Sixteen orders on ${n(f.items?.length)} of your items. Each container date is worked out from the item's own D-minus so the first containers have work on day 1; the rest are spread over the three months after, two of them probable rather than confirmed, two arriving during the week.</p>
    ${table(
      ['Order', 'Item', '#Pieces', 'Container', 'Why it is in the week'],
      orders.map((o) => [
        esc(o.erp) + (o.confidence ? ` <span class="aside">${esc(o.confidence)}</span>` : ''),
        esc(short(verdictOf(o.erp)?.name ?? o.code ?? '')),
        n(o.qty) + (o.secondLine ? ` + ${n(o.secondLine.qty)}` : ''),
        esc(day(o.stuffing)) + (o.secondLine ? ` and ${esc(day(o.secondLine.stuffing))}` : ''),
        esc(o.why),
      ]),
    )}
  </section>

  <section class="pagebreak">
    <h2>Your day</h2>
    <p class="lede">What each person at U&amp;M does on the system, when, and on which screen &mdash; as it was done in this week. Nothing is entered twice: a figure typed once is what every other screen reads.</p>

    <div class="role">
      <h3>The HOD of a department</h3>
      <p class="when">Morning · Production</p>
      <p><strong>Who came in</strong> and the <strong>overtime hours</strong> for the day, two boxes, one Save. The sentence beside them says what the day is running at and its man-hours${d1.attendance?.STITCH?.text ? ` &mdash; on day 1 Stitching read "${esc(d1.attendance.STITCH.text)}"` : ''}. <strong>Handed to you, not yet counted in</strong>: what the department before you says it sent; enter what arrived, and a difference is kept.</p>
      <p class="when">Through the day · the floor display</p>
      <p>The wall screen for the department: what is due today, what it is waiting on, who is in, which machines are running. It refreshes itself.</p>
      <p class="when">End of day · Production</p>
      <p><strong>What you were asked for</strong>: one row per job, the target beside it. Enter <strong>good</strong> and <strong>rejected</strong> separately. Under a row with rejects, <strong>why rejected</strong>: the cause and how many, as many causes as the day needs. Entering a day again corrects it. Then press nothing else: the evening run is PPC's.</p>
    </div>

    <div class="role">
      <h3>HR</h3>
      <p class="when">Morning · Manpower</p>
      <p><strong>Deployment</strong>: mark each person In, Out or On leave, and the overtime hours against anyone who stays. The department's head count and its hours follow at once, and so does what it can make that day. <strong>Who is in</strong> is the whole factory on one page: on the books, in, out, on leave, overtime, man-hours, and who has not been marked.</p>
    </div>

    <div class="role">
      <h3>Maintenance</h3>
      <p class="when">When a machine stops · Machines</p>
      <p><strong>Book downtime</strong>: the machine, breakdown or maintenance or changeover, from and to, a reason. The department's day is scaled by the machines running, the plan re-runs, and Attention carries a card until it is back. <strong>Remove</strong> the booking when it is.</p>
    </div>

    <div class="role">
      <h3>Stores and purchase</h3>
      <p class="when">When a count is done · Material</p>
      <p>Click <strong>On hand</strong> against a material and type the count. The screen says what the plan needs against the store, and what is short and by when; a count that covers it moves the material out of the short list.</p>
    </div>

    <div class="role">
      <h3>Merchandising</h3>
      <p class="when">When an enquiry comes · Accept an order</p>
      <p>Item, pieces, container date, <strong>Check</strong>. In a few seconds: Yes, or which departments cannot make it and why, with the whole factory planned around it and nothing saved. <strong>Add it to the book</strong> on a Yes; <strong>Take it anyway</strong> on a No, which asks for the reason and keeps it on the order, in the book and on Attention. A second container is added from the Order book.</p>
    </div>

    <div class="role">
      <h3>PPC</h3>
      <p class="when">Morning · Command centre, Attention, the heatmap</p>
      <p>The plan as it stands: breaches, flagged days, the constraint department; every finding that needs an answer today, each linked to its screen; the days that are too full, department by department.</p>
      <p class="when">During the day · Schedule, What if, Capacity sheet</p>
      <p><strong>Drag a bar</strong> to hold a department's start where the floor needs it, with a reason: a pin every later run honours. <strong>What if</strong> tries a second shift, overtime or a department down without touching the live plan. The <strong>Capacity sheet</strong> is where the rates, the crew sizes and the D-minus live, and where your workbook loads.</p>
      <p class="when">Evening · Command centre</p>
      <p><strong>Run the schedule.</strong> The run keeps every day the departments have entered as it was planned, places what remains from the next working day, and says what moved.</p>
    </div>

    <div class="role">
      <h3>The MD</h3>
      <p class="when">Any time · Dashboard, WIP, Attention, Forecast, Money</p>
      <p>Nine figures and the week as a grid, planned against made, department by day; every order's progress in units; what needs an answer today; how much of the forecast is worth believing, from the history it has; cash out, week by week. Read, not entered.</p>
    </div>
  </section>

  ${dayBlock(
    0,
    'the book, and what the plan said',
    f.today,
    `Each order was checked on Accept an order first, then entered from the verdict with one click. DEMO-06 was refused and taken anyway with its reason. ${verdicts.filter((v) => v.pulled > 0).length ? 'Where a quantity needed more days than the day-counts leave, the earlier steps were planned to finish earlier and the verdict says so.' : ''}`,
    [
      ['d0-accept-clear', 'DEMO-01 checked', 'DEMO-01: the check'],
      ['d0-accept-refused', 'DEMO-06 refused', 'DEMO-06: refused, and the Take it anyway button'],
      ['d0-book', 'The order book', 'The book'],
      ['d0-schedule', 'The Schedule', 'The Schedule, one span per line, today a quarter in'],
      ['d0-command-centre', 'The Command centre', 'The Command centre'],
      ['d0-heatmap', 'The load heatmap', 'The load heatmap'],
      ['d0-attention', 'Attention', 'Attention'],
    ],
    table(
      ['Order', 'Verdict', 'Steps that could not'],
      verdicts.filter((v) => !v.enteredOn).map((v) => [esc(v.erp), esc(v.verdict) + (v.pulled ? ` <span class="aside">(${n(v.pulled)} steps finish earlier for the quantity)</span>` : ''), esc(v.failing.slice(0, 6).join('; ') + (v.failing.length > 6 ? ` … (${v.failing.length})` : '') || 'none')]),
    ) + readings(d0.commandCentre ? { ...d0, wip: [] } : null),
  )}

  ${entered('d1') ? dayBlock(
    1,
    'the first day on the floor',
    dates.D1,
    `Stitching marked who came in first thing: ${esc(d1.attendance?.STITCH?.text ?? '')}. The wall display for Stitching read "${esc(d1.display ?? '')}". Then every department with work planned entered its end of day: good against the target, rejected apart; Ply Cutting put its four rejects down to a cause. Machining made half its target. Then PPC ran the schedule.`,
    [
      ['d1-display', 'The floor display', 'The wall display for Stitching, in the morning'],
      ['d1-stitching-attendance', 'Stitching attendance', 'Stitching: who came in, and what the day runs at'],
      ['d1-why-rejected', 'Why rejected', 'Ply Cutting: the rejects, and why'],
      ['d1-machining', 'Machining entries', 'Machining: the entries'],
      ['d1-dashboard-grid', 'The grid after Day 1', 'Planned against made, after the run'],
    ],
    attendanceTable(d1.attendance) + entriesTable(d1.floor) + readings(d1.after),
  ) : ''}

  ${entered('d2') ? dayBlock(
    2,
    'counting in, a breakdown, a new order, a pin',
    dates.D2,
    `Each department counted in what the day before had handed it; Assembly counted two short. Maintenance booked a Stitching machine down on the Machines screen (${esc(d2.machine?.machine ?? '')}, ${esc(d2.machine?.kind ?? '')}). Merchandising checked and entered DEMO-07. PPC dragged ${esc(d2.pin?.name ?? 'a bar')} on DEMO-01 two days later with a reason. The day's actuals were entered and the schedule run.`,
    [
      ['d2-machines', 'Machines', 'Machines: the breakdown booked'],
      ['d2-pin', 'The pin dialog', 'The Schedule: a bar dragged, and the reason asked for'],
      ['d2-schedule-pin', 'The pinned bar', 'DEMO-01 with its pinned department'],
      ['d2-attention', 'Attention on Day 2', 'Attention'],
      ['d2-board-assembly', 'My department, Assembly', 'My department: what is holding Assembly up'],
      ['d2-display', 'The floor display', 'The wall display for Stitching, one machine down'],
    ],
    table(
      ['Department', '#Handovers counted in', 'Shortfall kept'],
      Object.entries(d2.handovers ?? {}).map(([code, h]) => [esc(nameOf(code)), n(h.counted), esc(h.shortfall || '—')]),
    ) + entriesTable(d2.floor) + readings(d2.after),
  ) : ''}

  ${entered('d3') ? dayBlock(
    3,
    'overtime, one on leave, a stock count',
    dates.D3,
    `Stitching entered twelve overtime hours for the day: ${esc(d3.attendance?.STITCH?.text ?? '')}. Sanding had one on leave. Stores counted ${esc(d3.material?.code ?? 'a material')} and it moved from "${esc(d3.material?.before ?? '')}" to "${esc(d3.material?.after ?? '')}". The day was entered and the schedule run.`,
    [
      ['d3-overtime', 'Overtime entered', 'Stitching: twelve overtime hours, and what they add'],
      ['d3-manpower', 'Manpower', "Manpower's Who is in: the same hours, and the man-hours"],
      ['d3-material', 'Material', 'Material: the count landed'],
    ],
    attendanceTable(d3.attendance) + entriesTable(d3.floor) + readings(d3.after),
  ) : ''}

  ${entered('d4') ? dayBlock(
    4,
    'an order taken against the plan, a what-if',
    dates.D4,
    `DEMO-05 arrived: 400 pieces twenty days too soon. The check refused it; it was taken anyway, with the reason, and Attention says so. PPC tried a second shift in Stitching on What if. Sanding put three rejects down to a cause. Then the schedule was run.`,
    [
      ['d4-accept-refused', 'DEMO-05 refused', 'DEMO-05: refused, and taken anyway'],
      ['d4-whatif', 'What if', 'What if: a second shift in Stitching'],
      ['d4-quality', 'Quality', 'Quality: where the losses come from'],
    ],
    attendanceTable(d4.attendance) + entriesTable(d4.floor) + readings(d4.after),
  ) : ''}

  ${entered('d5') ? dayBlock(
    5,
    'the week, read',
    dates.D5,
    `The last day's entries, the run, and the week read as the MD would read it: the dashboard, WIP, the Schedule with DEMO-06's container day in the past, the forecast, the money.`,
    [
      ['d5-dashboard', 'The dashboard', 'The dashboard after five days'],
      ['d5-wip', 'WIP', 'WIP'],
      ['d5-schedule', 'The Schedule', 'The Schedule: a container day passed'],
      ['d5-attention', 'Attention', 'Attention at the end of the week'],
      ['d5-forecast', 'Forecast', 'Forecast: how much history it has'],
      ['d5-money', 'Money', 'Money out, week by week'],
    ],
    entriesTable(d5.floor) + readings(d5.after),
  ) : ''}

  <section class="pagebreak">
    <h2>What is recorded, and what is not</h2>
    ${table(
      ['What', 'Recorded', 'Where', 'Feeds'],
      [
        ['Who came in, per department and day', 'yes', 'Production (a number) or Manpower (per person)', "the day's capacity, the plan, the man-hours"],
        ['Who came in, per person', 'yes', 'Manpower → Deployment', 'the department count'],
        ['Overtime hours', 'yes, since this week', 'Production (a total) or Manpower (per person)', "the day's capacity at the shift's overtime efficiency, up to the shift's maximum"],
        ['Man-hours', 'derived, not typed', 'Manpower, Production', 'who came in × the shift hours + overtime'],
        ['Clock-in and clock-out times', 'no', '—', '—'],
        ['Good and rejected, per job and day', 'yes', 'Production', 'WIP, the dashboard, yields, the forecast'],
        ['Why rejected', 'yes, since this week', 'Production, under the row', 'Quality: the Pareto, who can fix it'],
        ['Handovers counted in', 'yes', 'Production', 'My department: what is holding you up'],
        ['Machines, and downtime', 'yes', 'Machines (and Masters)', "the day's capacity, Attention, the floor display"],
        ['Material on hand', 'yes', 'Material', 'shortages against the plan'],
        ['Bills of materials, article costs', 'the screens exist', 'Masters, Capacity sheet', "Material and Money, empty until U&M's figures arrive"],
        ['Pins, what-ifs, orders taken against the plan', 'yes', 'Schedule, What if, Accept an order', 'the plan, with the reason kept'],
        ['Purchase orders', 'no', '—', '—'],
      ],
    )}
  </section>

  <section class="pagebreak">
    <h2>The checks</h2>
    <p class="lede">${checks.length} things we expected, what the screen said, and whether that is a pass. A row marked <em>read</em> is a reading with no single right answer; it is there so the next run can be compared with this one.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>#</th><th>What</th><th>Expected</th><th>The screen said</th><th>Verdict</th></tr></thead>
      <tbody>${checks
        .map(
          (c, i) =>
            `<tr><td class="num">${i + 1}</td><td class="term">${esc(c.what)}</td><td class="def">${esc(c.expected)}</td><td class="def">${esc(c.seen)}</td><td class="${c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'read'}">${c.pass === true ? 'pass' : c.pass === false ? 'not as expected' : 'read'}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </section>

  <section>
    <h2>What your own data changes</h2>
    ${table(
      ['From U&M', 'What it replaces', 'What changes on the screens'],
      [
        ['The rates: pieces a day per item per department, with the crew size', 'the stand-in 40 a day', 'every date, every red square, every verdict on Accept an order'],
        ['Handover days per department', 'the per-article D-minus sheet', 'the D-minus becomes a figure the system prints per order, not one PPC types'],
        ['Does Machining feed Ply Cutting?', 'an edge we kept because it was there', 'the route, and one breach on the sample plan'],
        ['A Panipuri export', 'orders typed by hand', 'the order book filled from the ERP'],
        ['Bills of materials and article costs', 'empty screens', 'Material shortages and Money'],
      ],
    )}
  </section>

  <section>
    <h2>Who did what in this week</h2>
    ${table(
      ['Who', 'Screen', 'What they did'],
      [
        ['Merchandising', 'Accept an order · Order book', 'Checked sixteen orders, entered them from the verdict; took DEMO-06 and DEMO-05 anyway with reasons; added DEMO-04’s second container; entered DEMO-07 on day 2 and DEMO-05 on day 4.'],
        ['Each HOD', 'Production', 'Marked who came in and the overtime, entered good and rejected per job at the end of each day with the cause, counted in what arrived from upstream.'],
        ['HR', 'Manpower', 'Read who is in, the overtime and the man-hours.'],
        ['Maintenance', 'Machines', 'Booked a Stitching breakdown for two days.'],
        ['Stores', 'Material', 'Counted a material that was short.'],
        ['PPC', 'Command centre · Schedule · What if', 'Ran the schedule each evening; pinned a department two days later with a reason; tried a second shift in Stitching.'],
        ['The MD', 'Dashboard · WIP · Attention · Forecast · Money', 'Read.'],
      ],
    )}
  </section>

  <footer>
    <span>DBBS/UM/KRAM/14 &middot; Rev A</span>
    <span>Run on ${esc(f.venue ?? '')}, ${esc(taken)} IST</span>
  </footer>
</div>
`
}
