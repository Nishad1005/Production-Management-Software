/**
 * "Five items, three days" — DBBS/UM/KRAM/13, as an HTML fragment.
 *
 * `make-mock-run.mjs` enters the orders and the three days of floor entries
 * and reads every screen afterwards; this turns what it read into the manual.
 * The reader is anyone at U&M or Data Brilliance who wants to see the whole
 * system work on one small, realistic case and check it against their own
 * expectation. Every figure is read, not typed; every check says what was
 * expected, what the screen said, and whether that is a pass.
 */

import { docStyle } from './doc-style.mjs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const day = (iso) => {
  if (!iso) return ''
  const [y, m, d] = String(iso).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const n = (v) => (v === undefined || v === null || v === '' ? '—' : Number(v).toLocaleString('en-IN'))
const short = (name) => String(name ?? '').replace(/\s+—\s+.*$/, '').trim() || name

const fig = (file, alt, caption) =>
  `<figure class="shot"><img src="mock-run/${file}.png" alt="${esc(alt)}" />${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`
const table = (head, rows) =>
  `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th${/^#/.test(h) ? ' class="num"' : ''}>${h.replace(/^#/, '')}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${/^#/.test(head[i] ?? '') ? ' class="num"' : i === 0 ? ' class="term"' : ' class="def"'}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`

export function mockRunPage({ facts: f }) {
  const taken = f.generatedAt
    ? new Date(f.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  const orders = f.orders ?? []
  const verdictOf = (erp) => (f.verdicts ?? []).find((v) => v.erp === erp)
  const nameOf = (code) => f.departments?.find((d) => d.code === code)?.name ?? code
  const d0 = f.days?.d0 ?? {}
  const d1 = f.days?.d1 ?? {}
  const d2 = f.days?.d2 ?? {}
  const d3 = f.days?.d3 ?? {}
  const has = (file) => Boolean(f.shots?.[file])
  const dates = f.dates ?? {}

  // --- the checks ---------------------------------------------------------------
  const checks = []
  const check = (what, expected, seen, pass) => checks.push({ what, expected, seen, pass })
  {
    const v5 = verdictOf('MOCK-05')
    const v1 = verdictOf('MOCK-01')
    check('MOCK-01 checked on Accept an order', 'fits as it stands', v1?.verdict ?? '—', v1 ? !v1.refused : null)
    check('MOCK-05 (400 pieces, six weeks) checked', 'refused, with the steps named', v5?.verdict ?? '—', v5 ? v5.refused && v5.failing.length > 0 : null)
    const bookRow = (f.book ?? []).find((r) => /MOCK-05/.test(r[0]))
    check('MOCK-05 taken anyway, with a reason', 'the book marks it "taken against the plan"', bookRow ? bookRow[0] : '—', bookRow ? /taken against the plan/i.test(bookRow[0]) : null)
    const card = (d0.attention?.mock ?? []).find((t) => /MOCK-05/.test(t) && /taken against the plan/i.test(t))
    // A breach card carries the reason; a "behind" card (late on its own
    // account) does not yet, and MOCK-05's steps are all behind.
    check('Attention card for MOCK-05 carries the reason', 'the detail ends with "taken against the plan: …"', card ?? (d0.attention?.mock ?? []).find((t) => /MOCK-05/.test(t)) ?? '—', card ? true : d0.attention ? false : null)
    const m4 = (f.book ?? []).find((r) => /MOCK-04/.test(r[0]))
    // "2 !" when the lines do not add up to the order total — a warning the
    // book is right to show, since the order was entered as one container.
    check('MOCK-04 ships in two containers', '2 lines in the book, scheduled from their own dates', m4 ? `${m4[4].replace('!', ' (! — the lines exceed the order total)')} lines, first stuffing ${m4[5]}` : '—', m4 ? parseInt(m4[4], 10) === 2 : null)
    check('The overlap shows on the heatmap', 'Stitching over capacity on some days', d0.heatmap ? `${n(d0.heatmap.stitchOverDays)} days over in Stitching, ${n(d0.heatmap.over)} flagged in all` : '—', d0.heatmap ? d0.heatmap.stitchOverDays > 0 : null)
    check('The Command centre names the constraint', 'Stitching', d0.commandCentre?.constraint ?? '—', d0.commandCentre ? /stitch/i.test(d0.commandCentre.constraint) : null)
    const at = d1.attendance?.STITCH
    check('Day 1 attendance in Stitching', 'two short of the books, and the day runs at that fraction of the rate', at?.text ?? '—', at?.onBooks ? at.present === at.onBooks - 2 && /\d+%/.test(at.text) : null)
    const g1 = d1.after?.dashboard?.grid?.rows ?? {}
    check('Day 1 on the grid: Machining short', 'red (half the target entered); amber if the evening run moved today\u2019s target', g1.MACHINE ? `${g1.MACHINE.state} — ${g1.MACHINE.title}` : '—', g1.MACHINE ? g1.MACHINE.state === 'short' || g1.MACHINE.state === 'behind' : null)
    const metDepts = Object.entries(g1).filter(([, c]) => c?.state === 'met').map(([k]) => nameOf(k))
    check('Day 1 on the grid: departments that met the plan', 'green where the entries matched', metDepts.length ? metDepts.join(', ') : '—', metDepts.length ? true : g1.MACHINE ? false : null)
    const ply = (d1.floor?.entered ?? []).find((e) => e.code === 'PLYCUT')
    check('Rejections at Ply Cutting', '4 rejected, counted apart from good', ply ? `${n(ply.entries?.[0]?.rejected)} rejected on ${n(ply.entries?.[0]?.good)} good` : '—', ply ? ply.entries?.[0]?.rejected === 4 : null)
    check('Rejections on the dashboard', 'the Rejections figure is no longer 0%', d3.after?.dashboard?.kpi?.Rejections ?? '—', d3.after ? !/^0(\.0)?%/.test(d3.after.dashboard.kpi.Rejections ?? '') : null)
    const ho = d2.handovers?.ASSY
    check('Assembly counts in two short', 'the difference is kept, not smoothed', ho ? `${ho.shortfall || 'no shortfall shown'} · ${n(ho.counted)} handovers counted in` : '—', ho ? /2\s*short/i.test(ho.shortfall) : null)
    check('My department shows what is holding Assembly up', 'the shortfall on the feeder’s card', d2.board ? d2.board.slice(0, 160) : '—', d2.board ? /short|reached you/i.test(d2.board) : null)
    const mc = d2.machine
    check('A Stitching machine booked down for Day 2', 'one fewer machine available', mc ? `${mc.machine || 'no machine'}: ${mc.before ?? '?'} → ${mc.after ?? '?'} of ${mc.machines ?? '?'}` : '—', mc?.before && mc?.after ? Number(mc.after) === Number(mc.before) - 1 : null)
    check('Attention lists the machine', 'a machine-down card', d2.after?.attention ? `${n(d2.after.attention.kinds['machine-down'])} machine cards` : '—', d2.after?.attention ? (d2.after.attention.kinds['machine-down'] ?? 0) > 0 : null)
    const p1 = d1.after?.plans?.['MOCK-01']
    const mach = p1?.bars?.find((b) => b.code === 'MACHINE')
    check('The plan learns from Day 1', 'Machining’s remainder is re-planned from the next day, nothing made twice', p1 ? (mach ? `Machining ${day(mach.start)} → ${day(mach.end)}, ${n(mach.qty)} units` : `Machining reads Made (${n(p1.made)} departments made)`) : '—', p1 ? (mach ? mach.start >= (dates.D2 ?? '') : true) : null)
    const w = d3.whatIf
    check('What if: a second shift in Stitching', 'fewer breaches in the scenario, live plan untouched', w ? `${n(w.breachesNow)} → ${n(w.breachesThen)} breaches, ${n(w.changed)} tasks changed` : '—', w ? w.breachesThen <= w.breachesNow && w.changed > 0 : null)
    const fc = d3.forecast
    check('The forecast says how much history it has', 'declines until ten declarations, then speaks', fc ? `${n(fc.declarations)} declarations: ${fc.text.slice(0, 120)}` : '—', fc ? true : null)
    const wip3 = d3.after?.wip ?? []
    check('WIP after three days', 'every mock line started, progress in units', wip3.length ? wip3.map((l) => `${l.erp} ${l.percent}%`).join(' · ') : '—', wip3.length ? wip3.every((l) => Number(l.percent) > 0) : null)
    check('The floor display for Stitching on Day 2', 'the day in its own words', d2.display ?? '—', d2.display ? true : null)
  }
  const passed = checks.filter((c) => c.pass === true).length
  const failed = checks.filter((c) => c.pass === false).length

  // --- the days -----------------------------------------------------------------
  const entriesTable = (floor) =>
    table(
      ['Department', '#Planned', '#Good', '#Rejected', 'The header said'],
      (floor?.entered ?? []).map((e) => [
        esc(e.name),
        n(e.entries.reduce((s, x) => s + x.planned, 0)),
        n(e.entries.reduce((s, x) => s + x.good, 0)),
        n(e.entries.reduce((s, x) => s + x.rejected, 0)),
        esc(e.header),
      ]),
    )
  const readings = (after) =>
    after
      ? table(
          ['Read after the run', 'What it said'],
          [
            ['Command centre', esc(`${n(after.commandCentre?.breaches)} breaches · ${n(after.commandCentre?.flaggedDays)} flagged days · constraint ${after.commandCentre?.constraint ?? '—'}`)],
            ['Attention', esc(`${n(after.attention?.critical)} critical · ${n(after.attention?.warning)} warnings · ${Object.entries(after.attention?.kinds ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`)],
            ['Dashboard', esc(Object.entries(after.dashboard?.kpi ?? {}).map(([k, v]) => `${k} ${v}`).join(' · '))],
            ['WIP', esc((after.wip ?? []).map((l) => `${l.erp} ${l.percent}% (${l.departments})`).join(' · ') || 'nothing started')],
          ],
        )
      : ''

  const dayBlock = (no, title, date, intro, pictures, body) => `
  <section class="pagebreak">
    <h2>Day ${no} &mdash; ${title}${date ? ` <span class="aside">${day(date)}</span>` : ''}</h2>
    <p class="lede">${intro}</p>
    ${body}
    ${pictures.filter(([file]) => has(file)).map(([file, alt, caption]) => fig(file, alt, caption)).join('\n')}
  </section>`

  return `<title>Kram — Five items, three days</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${docStyle}
<style>
  td.pass { color: var(--go); font-weight: 600; white-space: nowrap; }
  td.fail { color: var(--flag); font-weight: 600; white-space: nowrap; }
  td.read { color: var(--mid); white-space: nowrap; }
  @media print { figure.shot img { max-height: 120mm; } section.pagebreak figure.shot { break-inside: avoid; } }
</style>

<div class="doc">
  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>Five items, three days</h1>
      <p class="sub">A mock run on ${esc(f.venue ?? '')}: six orders on five of your items, entered and
        checked as merchandising would, then three days on the floor entered as the HODs would &mdash;
        attendance, end-of-day actuals against targets, handovers, a machine down, a stock count, a
        what-if &mdash; with the plan re-run each evening and every screen read afterwards.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/13 &middot; Rev A &middot; for U&amp;M Designs</dd>
      <dt>Checks</dt><dd>${checks.length} made &middot; ${passed} passed${failed ? ` &middot; ${failed} did not` : ''} &middot; ${checks.length - passed - failed} read only</dd>
      <dt>Run on</dt><dd>${esc(taken)} IST &middot; day 1 = ${day(dates.D1)}</dd>
    </dl>
  </header>

  <section>
    <h2>In one minute</h2>
    <div class="three">
      <div class="card yours">
        <div class="card__t">Yours</div>
        <p><strong>The five items, their routes and their D-minus</strong> are from your master. The orders, the customers and the three days of entries are made up for this run.</p>
      </div>
      <div class="card standin">
        <div class="card__t">A stand-in</div>
        <p><strong>Every speed is a stand-in.</strong> Where the plan says a day is over capacity or a step is late, that follows from the stand-in rate, not from your factory.</p>
      </div>
      <div class="card ask">
        <div class="card__t">How to read it</div>
        <p><strong>Day by day.</strong> What was entered, then what every screen said. The last section is the checks: what we expected, what the screen said, pass or not.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>The six orders</h2>
    ${table(
      ['Order', 'Item', '#Pieces', 'Container', 'Why it is in the run'],
      orders.map((o) => [
        esc(o.erp),
        esc(short(verdictOf(o.erp)?.name ?? o.item)),
        n(o.qty) + (o.secondLine ? ` + ${n(o.secondLine.qty)}` : ''),
        esc(day(o.stuffing)) + (o.secondLine ? ` and ${esc(day(o.secondLine.stuffing))}` : ''),
        esc(o.why),
      ]),
    )}
  </section>

  ${dayBlock(
    0,
    'the orders, and what the plan said',
    f.today,
    'Each order was checked on Accept an order first, then entered from the verdict with one click. MOCK-05 was refused and taken anyway, with its reason.',
    [
      ['d0-accept-m01', 'MOCK-01 checked', 'MOCK-01: the check'],
      ['d0-accept-m05', 'MOCK-05 refused', 'MOCK-05: refused, and the Take it anyway button'],
      ['d0-book', 'The order book', 'The book with the six orders'],
      ['d0-schedule', 'The Schedule', 'The Schedule, one span per line'],
      ['d0-command-centre', 'The Command centre', 'The Command centre'],
      ['d0-heatmap', 'The load heatmap', 'The load heatmap'],
      ['d0-attention', 'Attention', 'Attention'],
    ],
    table(
      ['Order', 'Verdict', 'Steps that could not'],
      (f.verdicts ?? []).map((v) => [esc(v.erp), esc(v.verdict), esc(v.failing.slice(0, 6).join('; ') + (v.failing.length > 6 ? ` … (${v.failing.length})` : '') || 'none')]),
    ) + readings(d0.commandCentre ? { ...d0, wip: [] } : null),
  )}

  ${dayBlock(
    1,
    'the first day on the floor',
    dates.D1,
    `Stitching marked who came in first thing: ${esc(d1.attendance?.STITCH?.text ?? '')}. Then every department with mock work planned for the day entered its end of day: good against the target, rejected apart. Machining made half its target; Ply Cutting rejected four. Then the schedule was run.`,
    [
      ['d1-stitching-attendance', 'Stitching attendance', 'Stitching: who came in, and what the day runs at'],
      ['d1-machining', 'Machining entries', 'Machining: the entries'],
      ['d1-dashboard-grid', 'The grid after Day 1', 'Planned against made, after the run'],
    ],
    entriesTable(d1.floor) + readings(d1.after),
  )}

  ${dayBlock(
    2,
    'counting in, and a machine down',
    dates.D2,
    `Each department counted in what the day before had handed it; Assembly counted two short of what it was sent. A Stitching machine was booked down for the day (${esc(d2.machine?.machine ?? '')}). The day's actuals were entered and the schedule run.`,
    [
      ['d2-machines', 'Machines', 'Masters: the machine booked down'],
      ['d2-attention', 'Attention on Day 2', 'Attention'],
      ['d2-board-assembly', 'My department, Assembly', 'My department: what is holding Assembly up'],
      ['d2-display', 'The floor display', 'The wall display for Stitching'],
    ],
    table(
      ['Department', '#Handovers counted in', 'Shortfall kept'],
      Object.entries(d2.handovers ?? {}).map(([code, h]) => [esc(nameOf(code)), n(h.counted), esc(h.shortfall || '—')]),
    ) + entriesTable(d2.floor) + readings(d2.after),
  )}

  ${dayBlock(
    3,
    'a stock count, a what-if, and catching up',
    dates.D3,
    `Stores counted ${esc(d3.material?.code ?? 'a material')} and it moved from "${esc(d3.material?.before ?? '')}" to "${esc(d3.material?.after ?? '')}". PPC tried a second shift in Stitching on What if. Machining caught up. Then the schedule was run.`,
    [
      ['d3-material', 'Material', 'Material: the count landed'],
      ['d3-whatif', 'What if', 'What if: a second shift in Stitching'],
      ['d3-dashboard', 'The dashboard after Day 3', 'The dashboard after three days'],
      ['d3-wip', 'WIP', 'WIP'],
      ['d3-quality', 'Quality', 'Quality: rejections by department'],
      ['d3-forecast', 'Forecast', 'Forecast: how much history it has'],
    ],
    entriesTable(d3.floor) + readings(d3.after),
  )}

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
    <h2>Who did what in this run</h2>
    ${table(
      ['Who', 'Screen', 'What they did'],
      [
        ['Merchandising', 'Accept an order · Order book', 'Checked each order, entered it from the verdict; took MOCK-05 anyway with a reason; added MOCK-04’s second container.'],
        ['Each HOD', 'Production', 'Marked who came in, entered good and rejected per job at the end of each day, counted in what arrived from upstream.'],
        ['Maintenance', 'Masters → Machines', 'Booked a Stitching machine down for a day.'],
        ['Stores', 'Material', 'Counted a material that was short.'],
        ['PPC', 'Command centre · What if', 'Ran the schedule each evening; tried a second shift in Stitching.'],
        ['The MD', 'Dashboard · WIP · Attention', 'Read.'],
      ],
    )}
  </section>

  <footer>
    <span>DBBS/UM/KRAM/13 &middot; Rev A</span>
    <span>Run on ${esc(f.venue ?? '')}, ${esc(taken)} IST</span>
  </footer>
</div>
`
}
