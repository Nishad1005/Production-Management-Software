// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The documentation, checked mechanically.
 *
 * `docs/PROJECT-LOG.md` §5 already records the lesson this file applies: a
 * comment asking somebody to remember is not a mechanism. The log said fifteen
 * migrations when there were thirty-two, then thirty-seven when there were
 * forty-four, and the README claimed fifty-three tests for a suite of nearly
 * three hundred. Every one of those was written by somebody who meant it at the
 * time.
 *
 * A stale document is worse than none, because it is believed. So the two
 * claims that drift silently and can be checked without judgement are checked
 * here, and the suite fails when a phase lands without the docs following it.
 *
 * Not every figure belongs here. The test count cannot check itself, and prose
 * cannot be verified by a machine — this covers the counts that are facts about
 * the repository.
 */

const root = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(root + p, 'utf8')

/** Written out, because the documents are written out. */
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety',
]

function inWords(n: number): string {
  if (n < 20) return ONES[n]
  const tens = TENS[Math.floor(n / 10)]
  const ones = n % 10
  return ones ? `${tens}-${ONES[ones]}` : tens
}

describe('the project log tells the truth about the repository', () => {
  it('counts the migrations that actually exist', () => {
    const migrations = readdirSync(root + 'supabase/migrations').filter((f) =>
      f.endsWith('.sql'),
    ).length
    const log = read('docs/PROJECT-LOG.md')

    // "All forty-four migrations applied". The sentence is the one in §2 that
    // a reader uses to decide whether the live project is up to date.
    const claim = log.match(/All ([a-z-]+) migrations applied/)
    expect(claim, 'the migration count sentence has been reworded').not.toBeNull()
    expect(claim![1]).toBe(inWords(migrations))
  })

  it('counts the screens the browser check drives', () => {
    const script = read('scripts/screenshot.mjs')
    const screens = script
      .slice(script.indexOf('const SCREENS'), script.indexOf(']', script.indexOf('const SCREENS')))
      .match(/hash:/g)!.length
    const steps = (script.match(/^await step\(/gm) ?? []).length

    const log = read('docs/PROJECT-LOG.md')
    const claim = log.match(/drives ([a-z-]+) screens plus ([a-z-]+)\s*\n?interactions/)
    expect(claim, 'the browser-check sentence has been reworded').not.toBeNull()
    expect(claim![1]).toBe(inWords(screens))
    expect(claim![2]).toBe(inWords(steps))
  })
})

describe('the guide covers the software', () => {
  it('has a section for every screen in the navigation', () => {
    const app = read('src/App.tsx')
    const navLabels = [...app.matchAll(/\{ to: '\/[a-z]*', label: '([^']+)'/g)].map(
      (m) => m[1],
    )
    expect(navLabels.length).toBeGreaterThan(10)

    const guide = read('docs/GUIDE.md')
    const screens = guide.slice(
      guide.indexOf('## The screens'),
      guide.indexOf('## Reading the numbers'),
    )
    const documented = [...screens.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim())

    // A screen somebody can click and nobody has written down is exactly the
    // gap that left My department, WIP and Users undocumented for a fortnight —
    // the three a supervisor, a merchandiser and an administrator use daily.
    const missing = navLabels.filter((label) => !documented.includes(label))
    expect(missing).toEqual([])
  })
})
