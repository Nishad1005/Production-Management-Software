/**
 * "One order, start to finish" — DBBS/UM/KRAM/12, as an HTML fragment.
 *
 * `make-journey.mjs` takes the pictures and reads the figures; this turns both
 * into the document.
 *
 * ---------------------------------------------------------------------------
 * Who it is for.
 *
 * Everyone at U&M who will touch an order — the MD, merchandising, PPC,
 * stores, a department head, the person at the packing bench — and who has
 * not seen the software. One order is followed from the customer's first
 * question to the container, and every stop says three things: what the
 * screen is for, what the numbered things in the picture are, and who at U&M
 * does this and when. No software words. "Breach", "D-minus" and "stuffing
 * date" are explained the first time they appear and not before.
 *
 * Every figure is read off the screen in the same visit as its picture.
 * Nothing is claimed about the factory: the speeds behind every date are
 * stand-ins, and the first page says so.
 */

import { docStyle } from './doc-style.mjs'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const day = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const n = (v) => Number(v).toLocaleString('en-IN')
const workingDays = (from, to) => {
  let count = 0
  const d = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() !== 0) count++
  return count
}

const badge = (i) => `<span class="n">${i}</span>`
const marks = (items) =>
  `<ol class="marks">${items.map((text, i) => `<li>${badge(i + 1)}<span>${text}</span></li>`).join('')}</ol>`

function stop({ no, menu, title, shots, items, picture, who }) {
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
            `<figure class="shot${s.tall ? ' shot--tall' : ''}"><img src="journey/${s.file}.png" alt="${esc(s.alt)}" />${
              s.caption ? `<figcaption>${s.caption}</figcaption>` : ''
            }</figure>`,
        )
        .join('')}
      ${marks(items)}
      <div class="pair">
        <div class="sample"><div class="sample__t">In the picture</div><p>${picture}</p></div>
        <div class="tell"><div class="tell__t">Who does this, and when</div><p>${who}</p></div>
      </div>
    </div>
  </article>`
}

export function journeyPage({ facts: f }) {
  const taken = new Date(f.generatedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const article = esc(f.articleName || f.article)
  const short = esc((f.articleName || f.article).replace(/\s+—.*$/, ''))
  const plan = f.plan ?? []
  const first = plan[0] ?? {}
  const last = plan[plan.length - 1] ?? {}
  const span = first.start && last.end ? workingDays(first.start, last.end) : 0
  const fd = f.firstDay ?? {}
  const h = f.handover ?? {}
  const mid = f.wipMid ?? {}
  const ready = f.wipReady ?? {}
  const dash = f.dashboard ?? {}
  const cells = f.orderRowCells ?? []

  const tour = [
    stop({
      no: 1,
      menu: 'Accept an order',
      title: 'The customer asks. Can we take it?',
      shots: [
        { file: 'accept-no', alt: 'The Accept an order screen refusing the first date', caption: `The date the customer first asked for: ${day(f.tooSoon)}` },
      ],
      items: [
        `<strong>Pick the article.</strong> ${article}, from your own article list.`,
        `<strong>The quantity</strong>: ${n(f.qty)} pieces.`,
        `<strong>The container date</strong> the customer wants. The software calls it the <em>stuffing date</em>: the day the container is loaded. Every other date is counted back from it.`,
        `<strong>Press Check.</strong> The whole factory is planned again with this order in it, and then put back exactly as it was. Nothing is saved.`,
        `<strong>The answer in one line:</strong> &ldquo;${esc(f.tooSoonVerdict ?? '')}&rdquo;`,
        `<strong>Which steps, and why.</strong> Every department is listed with the day it would have to start and the day it must finish. The ones that cannot say what is wrong: <em>Late</em> means it would have had to start before today to make that date; <em>Runway</em> means the department before it finishes too late to leave it enough days.`,
      ],
      picture: `${day(f.tooSoon)} is too soon: ${n(f.tooSoonSteps)} of the ${n(f.steps)} steps cannot be done in the days they would have. Your sheet finishes the first step ${f.plan?.length ? 'nearly three months' : 'months'} before the container, so a container six weeks out means those steps should already have started.`,
      who: `Merchandising, while the customer is still on the phone. It takes a few seconds and changes nothing, so it can be tried with three dates in a row.`,
    }),
    stop({
      no: 2,
      menu: 'Accept an order',
      title: 'The date that can be promised',
      shots: [
        { file: 'accept-yes', alt: 'The Accept an order screen saying yes to a later date', caption: `The date that can be promised: ${day(f.stuffing)}` },
      ],
      items: [
        `<strong>Only the date is changed</strong>, to ${day(f.stuffing)}, and Check pressed again.`,
        `<strong>The answer:</strong> &ldquo;${esc(f.yesVerdict ?? '')}&rdquo;`,
        `<strong>Every row reads Clear</strong>, with the day each department would start. The first is ${esc(first.name ?? '')}, on ${first.start ? day(first.start) : ''}.`,
      ],
      picture: `This is the date to promise. It was found in two tries and a few seconds, against everything already in the order book, and nothing was written down anywhere.`,
      who: `Merchandising, before answering the customer. If the customer cannot wait, the same screen with a smaller quantity, or What if with overtime in the department that fails, says what it would take.`,
    }),
    stop({
      no: 3,
      menu: 'Order book',
      title: 'The order is confirmed. Enter it once.',
      shots: [
        { file: 'order-form', alt: 'The Add an order form, filled in', caption: 'Add an order' },
        { file: 'order-book', alt: 'The order book with the new order in it', caption: 'The order book, a moment later' },
      ],
      items: [
        `<strong>The order number</strong> from the ERP: ${esc(f.erp)}. When the ERP export arrives, this screen is filled from it instead of by hand.`,
        `<strong>The customer</strong>, from the list.`,
        `<strong>The article.</strong>`,
        `<strong>The quantity.</strong> One order can ship in more than one container; each container is a line of its own, with its own date.`,
        `<strong>The container date</strong> &mdash; the one the Check said yes to.`,
        `<strong>Press Add order.</strong> The plan is worked out again straight away, with this order in it. The row below shows it in the book.`,
      ],
      picture: `The new row in the book: ${esc(cells[0] ?? f.erp)}, ${esc(cells[1] ?? '')}, ${esc(cells[2] ?? '')}, ${esc(cells[3] ?? '')} pieces, ${esc(cells[4] ?? '1')} container, stuffing ${esc(cells[5] ?? '')}, ${esc((cells[6] ?? '').toLowerCase())}. Every department's dates for this order exist from this moment.`,
      who: `Merchandising or PPC, the day the order is confirmed. Once, for the whole order.`,
    }),
    stop({
      no: 4,
      menu: 'Schedule',
      title: 'The plan: every department, counted back from the container',
      shots: [{ file: 'schedule', alt: 'The Schedule screen with the order opened, one bar per department' }],
      items: [
        `<strong>The order</strong>: ${esc(f.scheduleHeading ?? '')}. The thin line across the top is its whole span.`,
        `<strong>The first bar</strong> is ${esc(first.name ?? '')}: ${first.start ? day(first.start) : ''} to ${first.end ? day(first.end) : ''}, ${n(first.qty ?? 0)} pieces. Each bar is one department's work, from the day it starts to the day it must finish.`,
        `<strong>The last bar</strong> is ${esc(last.name ?? '')}, just before the container.`,
        `<strong>The container day.</strong> Everything is counted back from here: your sheet says how many days before the container each department must be finished, and the software holds every department to it.`,
        `<strong>A deadline mark.</strong> The thin black line on a bar is that department's own deadline from your sheet.`,
      ],
      picture: `${n(plan.length)} departments, one after another, ${n(span)} working days from the first cut to the last carton. Green means the department has the days it needs. Nobody drew this: it follows from the sheet's day-counts, the quantity and each department's speed.`,
      who: `PPC reads it; nobody has to make it. A department head opens it to see when their part starts. A bar can be dragged to another day if there is a reason, and the software will then say what that costs.`,
    }),
    stop({
      no: 5,
      menu: 'Material',
      title: 'What to buy, and by when',
      shots: [{ file: 'material', alt: 'The Material screen: what to order now, and the store against the plan' }],
      items: [
        `<strong>Order now, or it will be late.</strong> Every material the plan needs that is not in the store, with the last day it can be ordered: the day the department needs it, less the supplier's lead time.`,
        `<strong>One card per material.</strong> ${f.orderNow?.count ? `${n(f.orderNow.count)} are past the day they should have been ordered for the orders already running. The first is ${esc(f.orderNow.first)}: order by ${esc(f.orderNow.by)}${f.orderNow.lead ? `, ${esc(f.orderNow.lead)} days from the supplier` : ''}.` : 'Nothing is urgent yet.'}`,
        `<strong>Against the store.</strong> What the whole plan needs of each material, what was last counted, and whether that covers it.`,
        `<strong>Leather</strong> is the long one: eight weeks from the supplier, so it is ordered before the first piece of wood is cut.`,
      ],
      picture: `The store screen does not know about one order; it knows about all of them together, which is the only way a shortage can be seen. A material that has never been counted says so, rather than pretending to be short or covered.`,
      who: `Stores count; purchase orders. Each morning, the &ldquo;Order now&rdquo; list is the shopping list.`,
    }),
    stop({
      no: 6,
      menu: 'Production',
      title: `The first day on the floor: ${esc(fd.dept ?? first.name ?? '')}`,
      shots: [
        { file: 'production-top', alt: 'The Production screen: the department and the day', caption: `${esc(fd.dept ?? '')}, ${fd.date ? day(fd.date) : ''}` },
        { file: 'production-before', alt: 'What the department was asked for, before entering the day', caption: 'Before' },
        { file: 'production-after', alt: 'The same list after the day is entered', caption: 'After pressing Enter' },
      ],
      items: [
        `<strong>The department</strong> picks itself from the list. On a phone or the department's own computer, it stays picked.`,
        `<strong>The day.</strong> It opens on today.`,
        `<strong>Planned.</strong> ${n(Math.round(fd.planned ?? 0))} pieces of this order today &mdash; the day's share of the ${n(fd.total ?? 0)} this department must make.`,
        `<strong>Good</strong>: how many came out right.`,
        `<strong>Rejected</strong>: how many did not. Counted separately, never as a percentage.`,
        `<strong>Not yet entered</strong> is what every job says until the figures are in.`,
        `<strong>Entered.</strong> That is the whole entry: two numbers, once a day, per job.`,
      ],
      picture: `Between the day and the list, the screen also asks who came in, and the day's capacity follows from it. ${n(Math.round(fd.planned ?? 0))} asked, ${n(Math.round(fd.planned ?? 0))} made. Further down the route, ${esc(f.rejectedAt?.dept ?? 'Sanding')} will reject ${n(f.rejectedAt?.qty ?? 4)} pieces; they are entered the same way and appear on the Quality screen with the department's name on them.`,
      who: `Each department head, or whoever keeps the register, at the end of the shift. The plan does not move while people are working; the next morning's run takes what was made into account.`,
    }),
    stop({
      no: 7,
      menu: 'Production',
      title: 'Handed over, and counted in',
      shots: [{ file: 'handover', alt: 'Assembly counting in what Ply Cutting handed over' }],
      items: [
        `<strong>Who sent it, and when.</strong> ${esc(h.from ?? '')} declared these pieces; they now sit at ${esc(h.to ?? 'Assembly')}'s door.`,
        `<strong>They made</strong> ${n(h.declared ?? 0)}.`,
        `<strong>You received.</strong> Enter what is actually there. Here ${n(h.received ?? 0)}.`,
        `<strong>The difference is kept</strong>: &ldquo;${esc(h.shortfall ?? '')}&rdquo;. It is not smoothed over and it is not an argument; it is a record.`,
        `<strong>Count in.</strong> From now on the software knows ${esc(h.to ?? 'Assembly')} has the pieces, and what it owes the department after it.`,
      ],
      picture: `Two sides to every handover: the department that made it says so, the department that receives it counts it. Where both agree, nothing happens. Where they differ, the difference is on record with both names on it.`,
      who: `The receiving department, first thing in the shift, standing up, usually on a phone.`,
    }),
    stop({
      no: 8,
      menu: 'WIP',
      title: 'Where is it now?',
      shots: [{ file: 'wip-running', alt: 'The WIP screen with the order part-made and its route opened' }],
      items: [
        `<strong>How far through the route</strong>: ${esc(mid.percent ?? '')}%, ${esc(mid.departments ?? '')}, ${esc(mid.container ?? '')}.`,
        `<strong>The strip</strong> is the route, one block per department in order. Green is finished, amber is under way, grey has not started. The shape says where the work is faster than any number.`,
        `<strong>Open it</strong> and every department is listed with what it has made against what it must make.`,
      ],
      picture: `Half the route is done. Everything on this screen is a count of pieces, declared by the department that made them and counted in by the next; no estimate anywhere. A department usually makes a piece or two more than the job needs, and that shows here too.`,
      who: `Anyone, any time. The MD's &ldquo;where is the Nordic order?&rdquo; is answered here without a phone call.`,
    }),
    stop({
      no: 9,
      menu: 'Floor display',
      title: 'The same order, on the department’s wall',
      shots: [{ file: 'display', alt: 'The floor display for Stitching', tall: false }],
      items: [
        `<strong>Due today or overdue</strong>: what this department has to finish today, by order. Today: &ldquo;${esc(f.display?.today ?? '')}&rdquo; &mdash; our order is among the jobs still ahead.`,
        `<strong>Waiting on</strong>: what is already due to this department from the ones feeding it and has not arrived, with what reached it so far.`,
      ],
      picture: `${esc(f.display?.dept ?? 'Stitching')}'s screen, as a television on the wall would show it: no menu, no buttons, large type, and it remembers which department it is.`,
      who: `Nobody. It refreshes itself. One television per department is enough.`,
    }),
    stop({
      no: 10,
      menu: 'Command centre &rarr; Schedule',
      title: 'The plan learns from the floor',
      shots: [{ file: 'schedule-made', alt: 'The Schedule after a run, with finished departments marked Made' }],
      items: [
        `<strong>Made.</strong> After a run, a department that has declared the whole job no longer has a bar; it reads Made. ${n(f.madeCount ?? 0)} of ${n(plan.length)} here.`,
        `<strong>The rest</strong> is planned again from what remains: ${n(f.remainingBars ?? 0)} bars still to come, each sized to what is still to make.`,
      ],
      picture: `Pressing Run the schedule on the Command centre takes a few seconds. A department that fell behind is not left in the past: its remaining work is moved to start from today, after the departments feeding it, and the reason reads <em>Late</em> if it still misses its date. Nothing that has been made is planned twice.`,
      who: `PPC, each morning, after attendance is entered and before the day starts. Any change to a master &mdash; a holiday, a machine down, a new order &mdash; runs it as well.`,
    }),
    stop({
      no: 11,
      menu: 'WIP &rarr; Dashboard',
      title: 'Ready to stuff',
      shots: [
        { file: 'wip-ready', alt: 'The WIP screen with the order under Ready to stuff', caption: 'WIP' },
        { file: 'dashboard', alt: 'The MD dashboard with the containers-ready figure', caption: 'Dashboard' },
      ],
      items: [
        `<strong>Ready to stuff.</strong> The order moves here the moment every department has declared the whole job: ${esc(ready.percent ?? '')}%, ${esc(ready.departments ?? '')}.`,
        `<strong>The same strip</strong>, all green.`,
        `<strong>Containers ready</strong> on the MD's dashboard counts it: ${esc(dash.containersReady ?? '')}. Beside it, the nine figures the dashboard was asked for, all of them from the same entries the departments made along the way.`,
      ],
      picture: `From the customer's first question to this screen, nobody typed a date. The dates came from your sheet's day-counts and the speeds; the progress came from two numbers a day per department. The container date was kept.`,
      who: `Packing declares the last job; dispatch reads the list. What left the factory is the one thing not yet recorded, and is next.`,
    }),
  ]

  return `<title>Kram — One order, start to finish</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${docStyle}

<div class="doc">

  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>One order, start to finish</h1>
      <p class="sub">${n(f.qty)} of your ${short}, followed from the customer&rsquo;s first
        question to the container. Eleven stops across ten screens, in the order they are used,
        and who at U&amp;M uses each one.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/12 &middot; Rev A &middot; for U&amp;M Designs</dd>
      <dt>The order</dt><dd>${esc(f.erp)} &middot; ${article} &middot; ${n(f.qty)} pieces &middot; container ${day(f.stuffing)}</dd>
      <dt>Pictures taken</dt><dd>${esc(taken)} IST, from the demonstration build</dd>
    </dl>
  </header>

  <!-- ================================================================ -->
  <section>
    <h2>In one minute</h2>
    <div class="three">
      <div class="card yours">
        <div class="card__t">Yours</div>
        <p><strong>The article, the fourteen departments and the route</strong> are U&amp;M&rsquo;s own,
          as they are on your sheet. The order is made up for this document.</p>
      </div>
      <div class="card standin">
        <div class="card__t">A stand-in</div>
        <p><strong>Every speed is invented.</strong> Nobody at U&amp;M has given us a pieces-a-day
          figure yet, so every date here follows from a made-up one. The shape of the journey is
          real; the dates are not.</p>
      </div>
      <div class="card ask">
        <div class="card__t">How to read it</div>
        <p><strong>One stop per screen, in the order they are used.</strong> The numbers on each
          picture are explained beneath it. The last box on every page says who does this at
          U&amp;M, and when.</p>
      </div>
    </div>
    <div class="note">
      <p><strong>The whole journey in one sentence.</strong> Merchandising checks a date and enters
        the order; the software plans every department back from the container; stores buy what
        the plan says; each department enters two numbers a day and counts in what it receives;
        the plan re-learns every morning; and the order moves to <em>Ready to stuff</em> the
        moment the last department has finished. Nobody types a date after the first one.</p>
    </div>
  </section>

  ${tour.join('\n')}

  <!-- ================================================================ -->
  <section class="pagebreak">
    <h2>Who does what, each day</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Who</th><th>Screen</th><th>When</th><th>What they do</th></tr></thead>
      <tbody>
        <tr><td class="term">Merchandising</td><td>Accept an order</td><td class="def">While the customer asks</td><td class="def">Check the date. Promise the one that says Yes.</td></tr>
        <tr><td class="term">Merchandising / PPC</td><td>Order book</td><td class="def">When confirmed</td><td class="def">Enter the order once. Dates for every department follow.</td></tr>
        <tr><td class="term">Stores and purchase</td><td>Material</td><td class="def">Each morning</td><td class="def">Order what the list says, by the day it says. Count stock when it changes.</td></tr>
        <tr><td class="term">HR / the gate</td><td>Manpower</td><td class="def">Start of shift</td><td class="def">Mark who is in. Capacity for the day follows from it.</td></tr>
        <tr><td class="term">Every department head</td><td>Production</td><td class="def">End of shift</td><td class="def">Good and rejected, per job. Count in what arrived from upstream.</td></tr>
        <tr><td class="term">PPC</td><td>Command centre</td><td class="def">Each morning</td><td class="def">Run the schedule. Read Attention. Fix what it names.</td></tr>
        <tr><td class="term">The MD</td><td>Dashboard, WIP</td><td class="def">Whenever</td><td class="def">Nine figures, and where any order is. No phone calls.</td></tr>
        <tr><td class="term">The wall</td><td>Floor display</td><td class="def">Always</td><td class="def">Shows each department its own day. Nobody operates it.</td></tr>
      </tbody>
    </table></div>

    <h3>What is not in this journey, on purpose</h3>
    <p>A real speed for any department, a real bill of materials, and what left the factory. The
      first two are what we have asked you for (KRAM/04 and KRAM/06); the third is next on our
      list. Everything else you have seen works today, on the live system, with your own
      article list.</p>
  </section>

  <footer>
    <span>DBBS/UM/KRAM/12 &middot; Rev A</span>
    <span>Pictures from the demonstration build, ${esc(taken)} IST</span>
  </footer>
</div>
`
}
