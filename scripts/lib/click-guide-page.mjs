/**
 * The click guide's page: DBBS/UM/KRAM/11, as an HTML fragment.
 *
 * `make-click-guide.mjs` performs the actions and writes the manifest — each
 * action's steps, pictures, what changed and why, with the figures read off
 * the screen in the same visit. This lays that out, grouped by screen in the
 * order of the menu. The words live beside the actions, in the capture, for
 * the reason given there.
 */
import { docStyle } from './doc-style.mjs'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const badge = (i) => `<span class="n">${i}</span>`

const LABELS = { before: 'Before', dialog: 'The dialog', after: 'After', typed: 'As you type', warning: 'The warning', department: 'Then', 'no-route': 'After adding', 'no-dminus': 'After a rate', ready: 'After a day-count' }

function figure(img) {
  const narrow = img.width && img.width < 900
  const notes = (img.notes ?? [])
    .map((t, i) => `<li>${badge(i + 1)}<span>${esc(t)}</span></li>`)
    .join('')
  return `
      <figure class="shot${narrow ? ' shot--narrow' : ''}">
        <div class="shot__label">${esc(LABELS[img.label] ?? img.label)}</div>
        <img src="click-guide/${img.file}" alt="${esc(img.label)}" />
        ${notes ? `<ol class="marks marks--figure">${notes}</ol>` : ''}
      </figure>`
}

function card(a, no) {
  if (a.failed) {
    return `
  <article class="act act--missing">
    <div class="act__bar"><span class="act__no">${no}</span><span class="act__title">${esc(a.name)}</span><span class="act__screen">${esc(a.screen)}</span></div>
    <div class="act__body"><p class="lede">Not photographed on this run: ${esc(a.failed)}.</p></div>
  </article>`
  }
  return `
  <article class="act">
    <div class="act__bar"><span class="act__no">${no}</span><span class="act__title">${esc(a.name)}</span><span class="act__screen">${esc(a.screen)}</span></div>
    <div class="act__body">
      <ol class="steps">${a.steps.map((s) => `<li><span>${esc(s)}</span></li>`).join('')}</ol>
      ${a.images.map(figure).join('')}
      <div class="pair">
        <div class="sample"><div class="sample__t">What changed</div><p>${esc(a.changed)}</p></div>
        <div class="tell"><div class="tell__t">Why it matters</div><p>${esc(a.why)}</p></div>
      </div>
    </div>
  </article>`
}

export function clickGuidePage({ takenAt, actions }) {
  const taken = new Date(takenAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const screens = []
  for (const a of actions) {
    const last = screens.at(-1)
    if (last && last.screen === a.screen) last.actions.push(a)
    else screens.push({ screen: a.screen, actions: [a] })
  }
  const ok = actions.filter((a) => !a.failed).length
  let no = 0
  const body = screens
    .map(
      (s) => `
  <section class="screen-group">
    <h2>${esc(s.screen)}</h2>
    ${s.actions.map((a) => card(a, ++no)).join('')}
  </section>`,
    )
    .join('')

  const contents = screens
    .map((s) => `<tr><td class="term">${esc(s.screen)}</td><td class="def">${s.actions.map((a) => esc(a.name)).join(' &middot; ')}</td></tr>`)
    .join('')

  return `<title>Kram — Every click</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${docStyle}
<style>
  .act { background: var(--sheet); border: 1px solid var(--rule); margin-top: 0.9rem; }
  .act__bar { background: var(--bar); color: var(--bar-text); padding: 0.55rem 1rem; display: flex; gap: 0.85rem; align-items: baseline; flex-wrap: wrap; }
  .act__no { font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.11em; opacity: 0.78; }
  .act__title { font-weight: 600; font-size: 1.02rem; }
  .act__screen { margin-left: auto; font-family: var(--mono); font-size: 0.6875rem; letter-spacing: 0.09em; text-transform: uppercase; opacity: 0.85; }
  .act__body { padding: 0.9rem 1rem 1rem; display: grid; gap: 0.8rem; }
  .act--missing .act__bar { background: var(--amber); }
  figure.shot--narrow img { width: auto; max-width: 100%; margin: 0 auto; }
  .shot__label { font-family: var(--mono); font-size: 0.625rem; letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint); padding: 0.3rem 0.6rem; background: var(--sheet); border-bottom: 1px solid var(--rule); }
  .marks--figure { padding: 0.45rem 0.6rem; background: var(--sheet); border-top: 1px solid var(--rule); font-size: 0.85rem; gap: 0.3rem 1rem; }
  .screen-group > h2 { margin-top: 1.6rem; }
  @media print {
    /* A card with three pictures is taller than a page. Let it break between
       its parts rather than carry the whole card over and leave a page blank:
       each picture, and the two closing boxes, stay whole. */
    .act { break-inside: auto; }
    .act__bar { break-after: avoid; }
    .act__body { gap: 0.6rem; }
    figure.shot, .pair, ol.steps { break-inside: avoid; }
    figure.shot img { max-height: 110mm; }
    .screen-group > h2 { break-after: avoid; }
    .marks--figure { grid-template-columns: 1fr 1fr; }
  }
</style>

<div class="doc">
  <header class="head">
    <div class="head__main">
      <div class="firm">Data Brilliance Business Solutions LLP</div>
      <h1>Every click</h1>
      <p class="sub">Each control in Kram, photographed before and after: what you
        press, what changes, and why it matters.</p>
    </div>
    <dl class="stamp">
      <dt>Ref</dt><dd>DBBS/UM/KRAM/11 &middot; Rev A &middot; for anyone learning or showing the software</dd>
      <dt>Pictures taken</dt><dd>${esc(taken)} IST, on the demonstration build</dd>
      <dt>Companions</dt><dd>KRAM/09 (the sample, illustrated) &middot; KRAM/10 (how each function works) &middot; KRAM/08 (every term)</dd>
    </dl>
  </header>

  <section>
    <h2>How to read this</h2>
    <p class="lede">${ok} actions, grouped by screen in the order of the menu. Each one
      has the steps in words, a picture before with the control numbered, the
      dialog if there is one, and a picture after with what changed numbered.
      Under the pictures: what moved, and why the software works that way.</p>
    <div class="note amber">
      <p><strong>These pictures are of the demonstration build</strong>, where every
        figure is invented so that every screen has something on it. The controls
        are the same on the live system; the numbers are not. Two things exist only
        there: the sign-in page, and the Users screen where roles are given.</p>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Screen</th><th>Actions</th></tr></thead>
      <tbody>${contents}</tbody>
    </table></div>
  </section>

  ${body}

  <footer>
    <span>DBBS/UM/KRAM/11 &middot; Rev A &middot; pictures taken ${esc(taken)} IST</span>
    <span>Demonstration data. Not a production plan.</span>
  </footer>
</div>
`
}
