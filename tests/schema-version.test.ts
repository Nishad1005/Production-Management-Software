// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { schemaVersion } from '../src/lib/schema-version'

/**
 * The offline build rebuilds its database when this value changes. It used to
 * be the constant `'1'`, with a comment asking whoever touched the schema to
 * bump it, and it stayed `'1'` through thirty migrations and a full rewrite of
 * the demonstration data — so every browser that had ever loaded Kram kept its
 * first database for good.
 *
 * The browser checks could not catch it. Playwright opens a fresh context per
 * run, so localStorage is empty, the comparison always mismatches and the
 * database is always rebuilt. Twenty green steps over a build that was stale
 * for every returning visitor.
 *
 * What failed was not the comparison. It was that the value never changed. So
 * that is what these assert.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('the offline schema version', () => {
  it('changes when any source changes', () => {
    const base = { 'a.sql': 'create table t (id int);', 'b.sql': 'select 1;' }
    const edited = { ...base, 'b.sql': 'select 2;' }
    expect(schemaVersion(edited)).not.toBe(schemaVersion(base))
  })

  it('changes when a source is added or removed', () => {
    const base = { 'a.sql': 'create table t (id int);' }
    const added = { ...base, 'b.sql': 'select 1;' }
    expect(schemaVersion(added)).not.toBe(schemaVersion(base))
    expect(schemaVersion({})).not.toBe(schemaVersion(base))
  })

  it('changes when the same SQL moves to a different file', () => {
    // Otherwise renaming a migration — or splitting one in two — would leave
    // every existing browser on the old database.
    expect(schemaVersion({ 'a.sql': 'select 1;' })).not.toBe(
      schemaVersion({ 'b.sql': 'select 1;' }),
    )
  })

  it('does not change when nothing does', () => {
    const sources = { 'a.sql': 'create table t (id int);', 'b.sql': 'select 1;' }
    expect(schemaVersion(sources)).toBe(schemaVersion({ ...sources }))
  })

  it('ignores the order the bundler hands the files over in', () => {
    // import.meta.glob makes no promise about key order, and a version that
    // flipped between two values would rebuild the database on alternate loads.
    const forwards = { 'a.sql': 'select 1;', 'b.sql': 'select 2;' }
    const backwards = { 'b.sql': 'select 2;', 'a.sql': 'select 1;' }
    expect(schemaVersion(backwards)).toBe(schemaVersion(forwards))
  })

  it('is stable across runs for the real migration set', async () => {
    // Guards the arithmetic itself: a plain multiply by the FNV prime overflows
    // into floating point and stops being a function of its input.
    const dir = join(repoRoot, 'supabase', 'migrations')
    const sources: Record<string, string> = {}
    for (const name of await readdir(dir)) {
      sources[name] = await readFile(join(dir, name), 'utf8')
    }

    const version = schemaVersion(sources)
    expect(version).toBe(schemaVersion(sources))
    expect(version).toMatch(/^[0-9a-f]+-[0-9a-z]+$/)
    // The value the constant used to hold. If the derivation ever produced it,
    // browsers stuck on the old constant would never rebuild.
    expect(version).not.toBe('1')
  })
})
