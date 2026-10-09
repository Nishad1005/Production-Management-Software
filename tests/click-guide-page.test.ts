// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script module, shared with the generator.
import { clickGuidePage } from '../scripts/lib/click-guide-page.mjs'

/**
 * The click guide's page (KRAM/11), built without a browser.
 *
 * The capture writes a manifest — steps, pictures, what changed, why — and the
 * page lays it out. As with the walkthrough, the ways it goes wrong are
 * silent: a figure the capture did not read prints as `undefined`, and an
 * action that failed on the run must say so on the page rather than vanish.
 * Built here from a manifest shaped like the capture's.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

const manifest = {
  takenAt: '2026-10-09T06:00:00.000Z',
  actions: [
    {
      id: 'run-schedule',
      screen: 'Command centre',
      name: 'Run the schedule',
      steps: ['Press Run the schedule.'],
      images: [
        { file: 'run-schedule-before.png', label: 'before', notes: ['The button'], width: 1180, height: 600 },
        { file: 'run-schedule-after.png', label: 'after', notes: ['The new stamp'], width: 1180, height: 600 },
      ],
      changed: 'A new plan was written: 102 jobs, 12 that do not fit.',
      why: 'Every run is kept.',
    },
    {
      id: 'masters-holiday',
      screen: 'Masters',
      name: 'Declare a holiday',
      steps: ['Press Add a holiday.'],
      images: [{ file: 'masters-holiday-after.png', label: 'after', notes: [], width: 600, height: 700 }],
      changed: 'The day closed.',
      why: 'D-minus is counted in working days.',
    },
    { id: 'wip-expand', screen: 'WIP', name: 'Open an order', failed: 'timed out waiting for the card' },
  ],
}

const page: string = clickGuidePage(manifest)
const prose = page.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')

describe('the click guide (KRAM/11)', () => {
  it('prints no figure it was not given', () => {
    expect(prose.length).toBeGreaterThan(1500)
    expect(prose).not.toMatch(/\bundefined\b/)
    expect(prose).not.toMatch(/\bNaN\b/)
    expect(prose).not.toMatch(/\[object Object\]/)
  })

  it('counts only the actions that were photographed, and says which were not', () => {
    expect(prose).toMatch(/\b2 actions\b/)
    expect(prose).toMatch(/Not photographed on this run: timed out waiting for the card/)
  })

  it('refers to the pictures by the names the capture writes', () => {
    const script = readFileSync(`${root}scripts/make-click-guide.mjs`, 'utf8')
    // Every picture is `${id}-${label}.png`, and the page must not invent a path.
    expect(script).toContain('const file = `${id}-${label}.png`')
    const shown = [...page.matchAll(/src="click-guide\/([^"]+)"/g)].map((m) => m[1])
    expect(shown).toEqual(['run-schedule-before.png', 'run-schedule-after.png', 'masters-holiday-after.png'])
  })

  it('shows a narrow picture at its own width', () => {
    // Per figure, not across the page: the stylesheet names the class too.
    const figures = [...page.matchAll(/<figure class="([^"]*)">[\s\S]*?src="click-guide\/([^"]+)"/g)].map(
      (m) => [m[2], m[1]],
    )
    expect(Object.fromEntries(figures)).toEqual({
      'run-schedule-before.png': 'shot',
      'run-schedule-after.png': 'shot',
      'masters-holiday-after.png': 'shot shot--narrow',
    })
  })

  it('carries no login of any kind', () => {
    expect(page).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
  })
})
