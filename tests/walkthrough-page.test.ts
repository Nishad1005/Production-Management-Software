// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script module, shared with the generator.
import { walkthroughPage } from '../scripts/lib/walkthrough-page.mjs'

/**
 * The walkthrough's page (KRAM/09), built without a browser.
 *
 * The document goes to the client as a PDF, and the two ways it can be wrong
 * are both silent. A figure the capture did not supply prints as the word
 * `undefined` or `NaN` in the middle of a sentence. A picture renamed in the
 * capture and not in the page is a missing image — which `make-pdf.mjs` now
 * refuses to build, but only once somebody runs it against the hosted project.
 *
 * Neither needs the hosted project to catch. This builds the page from the
 * real sheet and a set of figures shaped like the capture's, and reads the
 * result.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const sheet = JSON.parse(readFileSync(`${root}scripts/data/um-sample-sheet.json`, 'utf8'))

/** What `make-walkthrough.mjs` reads off the screens, as of the sample load. */
const facts = {
  generatedAt: '2026-10-04T07:08:00.000Z',
  lines: 11,
  tasks: 220,
  breaches: 18,
  flaggedDays: 145,
  constraint: 'Machining',
  critical: 33,
  warnings: 4,
  sameDay: 5,
  firstFinding: 'PACK cannot make SAMPLE-Edison Counter Stool - Sapphir · 3 Oct as planned',
  scheduleOrder: 'SAMPLE-Edison Counter Stool - Sapphir · 3 Oct',
  heatDepartments: 20,
  heatDays: 67,
  heatOver: 145,
  heatCell: { date: '2026-09-03', value: 3, title: 'SAND · 2026-09-03 · 3.00 of capacity' },
  heatCellJobs: 3,
  orders: 11,
  orderBreaches: [
    { order: 'SAMPLE-Edison Counter Stool - Sapphir · 3 Oct', breaches: 4 },
    { order: 'SAMPLE-Betsy Chair - Powder Blue · 10 Oct', breaches: 2 },
    { order: 'SAMPLE-Betsy Counter Stool · 17 Oct (1)', breaches: 0 },
  ],
  accept: {
    sku: '125043138',
    qty: 150,
    date: '2026-12-15',
    verdict: '4 of 20 steps cannot be made to this date.',
    failing: ['SAND', 'STITCH', 'STAPLE', 'PACK'],
  },
  pairings: 1044,
  articles: 72,
  sheetConflicts: 5,
  mapDepartments: 20,
  whatIf: {
    note: 'Sanding with a second shift',
    department: 'Sanding',
    code: 'SAND',
    breachesNow: 18,
    breachesThen: 14,
    flaggedNow: 145,
    flaggedThen: 137,
    deptBreachesNow: 4,
    deptBreachesThen: 0,
    rows: [
      { code: 'SAND', now: 4, then: 0 },
      { code: 'STITCH', now: 4, then: 4 },
      { code: 'PACK', now: 4, then: 4 },
    ],
  },
}

const page: string = walkthroughPage({ facts, sheet, site: 'kraam.netlify.app' })
/** The words a reader sees: tags and the stylesheet taken out. */
const prose = page
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ')

describe('the sample walkthrough (KRAM/09)', () => {
  it('prints no figure it was not given', () => {
    // The page is long enough to be the page, or the checks below pass on a stub.
    expect(prose.length).toBeGreaterThan(6000)
    expect(prose).not.toMatch(/\bundefined\b/)
    expect(prose).not.toMatch(/\bNaN\b/)
    expect(prose).not.toMatch(/\bnull\b/)
    expect(prose).not.toMatch(/\[object Object\]/)
  })

  it('refers only to pictures the capture actually takes', () => {
    const script = readFileSync(`${root}scripts/make-walkthrough.mjs`, 'utf8')
    const taken = new Set([
      ...[...script.matchAll(/shot\('([a-z0-9-]+)'/g)].map((m) => m[1]),
      ...[...script.matchAll(/name: '([a-z0-9-]+)'/g)].map((m) => m[1]),
      ...[...script.matchAll(/\$\{outDir\}\/([a-z0-9-]+)\.png/g)].map((m) => m[1]),
    ])
    const shown = [...page.matchAll(/src="walkthrough\/([a-z0-9-]+)\.png"/g)].map((m) => m[1])

    // Nine stops, one of them in two halves, and the sign-in screen.
    expect(shown.length).toBeGreaterThanOrEqual(11)
    expect(shown.filter((name) => !taken.has(name))).toEqual([])
  })

  it('works the example from the sheet, not from a sentence somebody typed', () => {
    const row = sheet.rows[0]
    const qty = row.qty.find((q: number | null) => q)
    // 152 pieces at 40 a day, and the two days the sheet leaves Sanding.
    expect(prose).toContain(`${(qty / sheet.rate_per_day).toFixed(1)} days`)
    expect(prose).toMatch(/Assembly\s+32 days before dispatch, and\s+Sanding\s+30 days\s+before/)
    expect(prose).toMatch(/does not fit/)

    // Change the sheet and the example must follow it.
    const tighter = structuredClone(sheet)
    tighter.rate_per_day = 80
    const again: string = walkthroughPage({ facts, sheet: tighter, site: 'x' })
    expect(again).toContain(`${(qty / 80).toFixed(1)} days`)
    expect(again).not.toContain(`${(qty / 40).toFixed(1)} days`)
  })

  it('names departments, not codes, where it speaks for the screen', () => {
    expect(prose).toMatch(/refused, at Sanding, Stitching, Stapling and Final Packing/)
    expect(prose).toMatch(/Final Packing cannot finish the Edison Counter Stool dispatch of 3 Oct 2026/)
  })

  it('carries no login of any kind', () => {
    // No address, so no half of a login. The guide says where to sign in and
    // that the login is sent separately.
    //
    // This test first forbade the real password by name — and so wrote the
    // real password into a public repository. A check for a secret must never
    // contain the secret: forbid the *shape*, and keep the value out of every
    // tracked file, tests included.
    expect(page).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
    expect(prose).toMatch(/sent separately, never in a\s+document/)
  })
})
