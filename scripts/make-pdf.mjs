/**
 * Renders one of the notes in `docs/` to a PDF that can be sent to a client.
 *
 *   node scripts/make-pdf.mjs docs/request-everything-outstanding.html
 *   node scripts/make-pdf.mjs docs/request-panipuri-export.html out.pdf
 *
 * ---------------------------------------------------------------------------
 * Why this is not just "print to PDF from the browser".
 *
 * The notes are written as *fragments* — a `<title>`, a `<style>` and the
 * content, with no doctype, head or body — because that is the shape the
 * Artifact host wraps and publishes. Opened straight from the filesystem they
 * render, but they render as a quirks-mode page with none of the host's
 * skeleton, and the result differs from what the client sees at the link.
 *
 * So this supplies the same skeleton the host does, and adds the print rules
 * the screen version has no reason to carry: A4, real margins, and — the part
 * that matters — nothing allowed to break across a page boundary in the middle
 * of a request. A note whose "what we need back" checklist is split over two
 * pages loses half its items to whoever reads only the first.
 *
 * ---------------------------------------------------------------------------
 * Light, forced.
 *
 * Every note defines a dark palette for the reader who opens it at night. A PDF
 * has no reader preference, it has paper — and a dark page is both unreadable
 * printed and forty pages of toner. `data-theme="light"` is stamped on the
 * root, which the notes' own CSS honours over any media query.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { chromium } from 'playwright'

const [input, output] = process.argv.slice(2)
if (!input) {
  console.error('Usage: make-pdf.mjs <input.html> [output.pdf]')
  process.exit(1)
}
const out = output ?? input.replace(/\.html$/, '.pdf')

const fragment = await readFile(input, 'utf8')

/*
 * The Artifact host's skeleton, reproduced: charset, viewport, and a small
 * reset. Reproduced rather than approximated, because a note that looks right
 * here and wrong at the published link is worse than one that is wrong in both.
 */
const page = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 14px system-ui, sans-serif; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${fragment}
<style>
  /* Print rules. Screen has scrollbars and infinite height; paper has neither. */
  @page { size: A4; margin: 14mm 12mm 16mm; }

  @media print {
    /* White paper, and the panels keep their borders, so the structure that the
       screen version carries in its background tint survives without it. */
    body { background: #ffffff; }

    /* The screen layout centres a 60rem column inside a wide viewport. On A4
       the page margins are the column, so the wrapper gives up both. */
    .doc, .page {
      max-width: none !important;
      padding: 0 !important;
      gap: 1.35rem !important;
    }

    html { font-size: 13.5px; }

    /* Nothing splits mid-thought. Each of these is a unit somebody reads as a
       unit — a request, a warning, a row of a checklist. */
    .ask, .note, .tablewrap, .head, .checklist li, tr, .figure {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
    section { break-inside: auto; }

    /* Keep a heading with at least the start of what it introduces. */
    section > h2 + * { break-before: avoid; }

    a { text-decoration: none; }
  }
</style>
</html>`

const browser = await chromium.launch()
const context = await browser.newContext({
  colorScheme: 'light',
  viewport: { width: 900, height: 1200 },
})
const tab = await context.newPage()

const problems = []
tab.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
tab.on('pageerror', (e) => problems.push(String(e)))

await tab.setContent(page, { waitUntil: 'networkidle' })

// Webfonts load over the network and the notes name real families with real
// fallbacks. Waiting means the PDF gets whichever actually arrived rather than
// whatever had loaded by the time the renderer happened to fire.
await tab.evaluate(() => document.fonts.ready)

const loaded = await tab.evaluate(() =>
  document.fonts.check("16px 'Archivo'") ? 'Archivo' : 'system fallback',
)

await tab.emulateMedia({ media: 'print', colorScheme: 'light' })
const pdf = await tab.pdf({
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
})
await writeFile(out, pdf)
await browser.close()

const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
console.log(
  `${basename(out)} — ${pages || '?'} pages, ${(pdf.length / 1024).toFixed(0)} KB, set in ${loaded}`,
)
if (problems.length) {
  console.log(`\n${problems.length} console problem(s) while rendering:`)
  for (const p of problems.slice(0, 5)) console.log(`  ${p}`)
  process.exit(1)
}
