/**
 * The stylesheet every generated Kram document shares — KRAM/09, /10 and /11 —
 * so a folder of them reads as one set. The request notes written by hand
 * carry the same register; this is the version the generators use.
 */
export const docStyle = `<style>
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
</style>`
