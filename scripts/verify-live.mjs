/**
 * Checks access control against the live Supabase project, as real requests.
 *
 *   node scripts/verify-live.mjs                      # anonymous checks only
 *   node scripts/verify-live.mjs <email> <password>   # and as that account
 *
 * This exists because the local suite cannot catch what matters here. Every
 * policy is unit-tested against a native Postgres and all of it was green when
 * a probe against the live project found the whole function API callable by
 * anyone holding the anon key — which ships in the browser bundle by design.
 * Local Postgres and Supabase differ in exactly the way that mattered: one
 * arrives with permissive defaults the other does not.
 *
 * Run it after any migration that touches privileges, policies or functions.
 *
 * Reads the project from .env.hosted.local so there is one place the URL and
 * key live.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

async function loadEnv() {
  const text = await readFile(`${repoRoot}/.env.hosted.local`, 'utf8').catch(
    () => {
      throw new Error(
        '.env.hosted.local not found — this script checks the hosted project.',
      )
    },
  )
  const env = Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('.env.hosted.local is missing the URL or anon key.')
  }
  return env
}

let failures = 0

function report(name, passed, detail) {
  if (!passed) failures += 1
  const mark = passed ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Everything a signed-out visitor could try. */
async function checkAnonymous(db) {
  console.log('\nAnonymous (holding only the public key)')

  for (const view of [
    'department_master',
    'order_book',
    'schedule_gantt',
    'run_history',
    'my_access',
  ]) {
    const { error } = await db.from(view).select('*').limit(1)
    report(
      `cannot read ${view}`,
      Boolean(error),
      error ? undefined : 'READABLE',
    )
  }

  for (const [fn, args] of [
    ['run_schedule', {}],
    ['run_what_if', { p_note: 'probe' }],
    ['list_users', {}],
    ['set_dminus', { p_article_code: 'X', p_department_code: 'Y', p_days: 1 }],
    ['import_masters', { p_file: { kram_masters: 1, tables: {} } }],
  ]) {
    const { error } = await db.rpc(fn, args)
    const blockedAtDoor = error?.message?.includes('function')
    report(
      `cannot call ${fn}`,
      Boolean(error),
      !error
        ? 'ALLOWED'
        : blockedAtDoor
          ? undefined
          : `blocked, but inside the function: ${error.message.slice(0, 50)}`,
    )
  }
}

/** What a signed-in account can actually reach. */
async function checkSignedIn(db, email, password) {
  console.log(`\nSigned in as ${email}`)

  const { data: auth, error: signInError } =
    await db.auth.signInWithPassword({ email, password })
  if (signInError) {
    report('sign in', false, signInError.message)
    return
  }
  report('sign in', true)

  const { data: access } = await db.from('my_access').select('*')
  const roles = access?.[0]?.roles ?? []
  console.log(`  roles: ${roles.length ? roles.join(', ') : '(none)'}`)

  // Reading own access is fine; reading anyone else's profile is not.
  const { data: profiles } = await db.from('profiles').select('id')
  report(
    'sees only their own profile',
    (profiles?.length ?? 0) <= 1,
    `${profiles?.length ?? 0} rows`,
  )

  // Privilege escalation, the check that matters most.
  const { error: escalate } = await db.rpc('grant_role', {
    p_user_id: auth.user.id,
    p_role: 'admin',
  })
  const { data: afterEscalation } = await db.from('my_access').select('*')
  const gainedAdmin = (afterEscalation?.[0]?.roles ?? []).includes('admin')
  report(
    'cannot grant itself admin',
    !gainedAdmin,
    gainedAdmin ? 'ESCALATED' : escalate ? undefined : 'call allowed but no effect',
  )

  const { error: listError } = await db.rpc('list_users')
  const isAdmin = roles.includes('admin')
  report(
    isAdmin ? 'can list users (is admin)' : 'cannot list users',
    isAdmin ? !listError : Boolean(listError),
    listError && !isAdmin ? undefined : listError?.message?.slice(0, 50),
  )

  // What the planning screens would show.
  for (const view of ['department_master', 'order_book', 'run_history']) {
    const { data, error } = await db.from(view).select('*').limit(5)
    report(
      `reads ${view}`,
      !error,
      error ? error.message.slice(0, 45) : `${data.length} rows`,
    )
  }

  const canPlan = roles.some((r) => ['planner', 'admin'].includes(r))
  const { error: writeError } = await db.rpc('set_dminus', {
    p_article_code: 'AARA-LC',
    p_department_code: 'WOOD',
    p_days: 60,
  })
  report(
    canPlan ? 'can edit masters (is planner)' : 'master edits do nothing',
    canPlan ? !writeError : true,
    writeError?.message?.slice(0, 45),
  )

  await db.auth.signOut()
}

const env = await loadEnv()
const [email, password] = process.argv.slice(2)

console.log(`Kram — access control against ${env.VITE_SUPABASE_URL}`)

await checkAnonymous(createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY))

if (email && password) {
  await checkSignedIn(
    createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY),
    email,
    password,
  )
} else {
  console.log('\nNo credentials given — skipped the signed-in checks.')
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
