/**
 * The hosted project, from a script: the environment file, a signed-in
 * client, and a read that pages.
 *
 * Three scripts had their own copy of the first two and none of them paged.
 * PostgREST returns at most a thousand rows and reports nothing when it stops
 * — the browser client learned this on 30 Aug, the demonstration script on
 * 2 Sep, and the workbook generator was found on 11 Oct handing PPC a sheet
 * with the last 440 of 1,440 cells blank. Anything that reads the hosted
 * project from here goes through `selectAll`.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** `.env.hosted.local`, the one place the URL and the public key live. */
export async function loadEnv() {
  const text = await readFile(`${repoRoot}/.env.hosted.local`, 'utf8').catch(() => {
    throw new Error('.env.hosted.local not found — this reads the hosted project.')
  })
  const env = Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
      }),
  )
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('.env.hosted.local is missing the URL or anon key.')
  }
  return env
}

/** A client signed in as a user, exactly as the browser would be. */
export async function hostedClient(email, password) {
  const env = await loadEnv()
  const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  const { error } = await db.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Sign in failed: ${error.message}`)
  return db
}

/**
 * Every row of a view, a thousand at a time. `order` has to be given, because
 * a page of an unordered read is a page of whatever the planner felt like.
 */
export async function selectAll(db, view, columns, order) {
  const page = 1000
  const rows = []
  for (let from = 0; ; from += page) {
    let query = db.from(view).select(columns).range(from, from + page - 1)
    for (const column of order) query = query.order(column)
    const { data, error } = await query
    if (error) throw new Error(`${view}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < page) break
  }
  return rows
}
