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
    'route_dependency_grid',
    'production_worklist',
    'wip_by_order',
    'wip_pending_acceptance',
    'overtime_and_headcount',
    'employee_list',
    'employee_day',
    'department_manpower_day',
    'article_master',
    'declaration_list',
    'acceptance_list',
    'attendance_list',
    'order_list',
    'material_master',
    'material_shortage',
    'material_requirements',
    'defect_pareto',
    'quality_by_department',
    'defect_list',
    'machine_master',
    'machine_status',
    'machine_downtime_list',
    'article_cost_summary',
    'purchase_commitments',
    'cash_out_weekly',
    'attention',
    'attention_count',
    'measured_rate',
    'shipment_risk',
    'forecast_readiness',
    'provisional_state',
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
    [
      'set_department_dependency',
      { p_department_code: 'X', p_depends_on_code: 'Y', p_enabled: true },
    ],
    [
      'declare_production',
      {
        p_shipment_line_id: '00000000-0000-0000-0000-000000000000',
        p_department_code: 'X',
        p_component_code: 'Y',
        p_date: '2026-01-01',
        p_shift_code: 'GEN',
        p_good: 1,
      },
    ],
    [
      'accept_production',
      {
        p_declaration_id: '00000000-0000-0000-0000-000000000000',
        p_department_code: 'X',
        p_qty: 1,
      },
    ],
    [
      'set_employee_attendance',
      { p_emp_code: 'X', p_date: '2026-01-01', p_status: 'present' },
    ],
    ['set_employee', { p_emp_code: 'X', p_name: 'Nobody' }],
    ['set_article', { p_code: 'X', p_name: 'Nothing' }],
    ['set_article_active', { p_code: 'X', p_is_active: false }],
    ['set_material', { p_code: 'X', p_name: 'Nothing' }],
    ['set_defect_type', { p_code: 'X', p_name: 'Nothing' }],
    ['set_machine', { p_code: 'X', p_name: 'Nothing', p_department_code: 'Y' }],
    ['set_cost_line', { p_code: 'X', p_name: 'Nothing' }],
    ['set_article_cost_line', { p_article_code: 'X', p_cost_line_code: 'Y', p_amount: 1 }],
    ['set_material_rate', { p_material_code: 'X', p_rate: 1 }],
    ['mark_provisional', { p_what: 'probe' }],
    ['purge_provisional', {}],
    [
      'set_machine_downtime',
      { p_machine_code: 'X', p_from_date: '2026-01-01', p_to_date: '2026-01-02', p_reason: 'probe' },
    ],
    [
      'attribute_defect',
      {
        p_shipment_line_id: '00000000-0000-0000-0000-000000000000',
        p_department_code: 'X',
        p_component_code: 'Y',
        p_date: '2026-01-01',
        p_shift_code: 'GEN',
        p_defect_code: 'Z',
        p_qty: 1,
      },
    ],
    ['set_material_stock', { p_material_code: 'X', p_qty_on_hand: 1 }],
    [
      'set_article_material',
      { p_article_code: 'X', p_material_code: 'Y', p_department_code: 'Z', p_qty_per_unit: 1 },
    ],
    ['set_employee_active', { p_emp_code: 'X', p_is_active: false }],
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

/**
 * How long each view takes as a signed-in user, which is the only place it can
 * be measured.
 *
 * Local Postgres runs the tests as the table owner and bypasses row-level
 * security entirely, so a view that is 8ms here can be seconds on Supabase where
 * every underlying table applies a policy. `article_master` crossed the API's
 * eight-second ceiling on the live project and killed a script on a *read* —
 * the Masters screen reads the same view, so this is a screen that breaks for a
 * real user, not a scripting inconvenience.
 *
 * Reported rather than asserted: the right threshold depends on the project's
 * size, and a number invented here would fail for the wrong reasons.
 */
async function timeViews(db) {
  console.log('\nHow long each view takes, signed in')
  const views = [
    'article_master', 'capacity_sheet', 'order_book', 'schedule_gantt',
    'attention', 'material_shortage', 'measured_rate', 'shipment_risk',
    'wip_by_order', 'quality_by_department', 'machine_master', 'department_master',
    // The eight the Attention screen actually asks for, in parallel. The union
    // above is kept in the list because it is worth knowing whether it still
    // exceeds the API's ceiling — but no screen depends on it any more.
    'attention_breach', 'attention_overloaded', 'attention_material_late',
    'attention_material_short', 'attention_route_conflict',
    'attention_machine_down', 'attention_article_unplannable',
    'attention_handover',
  ]
  const slow = []
  for (const view of views) {
    const t0 = Date.now()
    const { error, count } = await db
      .from(view)
      .select('*', { count: 'exact', head: true })
    const ms = Date.now() - t0
    if (error) {
      console.log(`  ${'FAIL'} ${view} — ${error.message.slice(0, 60)}`)
      failures += 1
      continue
    }
    const mark = ms > 2000 ? 'SLOW' : 'ok  '
    if (ms > 2000) slow.push(view)
    console.log(`  ${mark} ${view.padEnd(24)} ${String(ms).padStart(6)} ms · ${count ?? 0} rows`)
  }
  if (slow.length) {
    console.log(
      `\n  ${slow.length} view(s) over two seconds. The API cancels at eight, so` +
        ' these are screens\n  that will fail for a user before they fail here.',
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

  await timeViews(db)

  const isAdmin = roles.includes('admin')

  // An admin sees everyone — the Users screen depends on it. Anyone else sees
  // themselves and no one else. Asserting the same thing for both would
  // report the Users screen working as a failure, which is the second time a
  // check here has cried wolf by ignoring the roles the account holds.
  const { data: profiles } = await db.from('profiles').select('id')
  const seen = profiles?.length ?? 0
  report(
    isAdmin ? 'sees every profile (is admin)' : 'sees only their own profile',
    isAdmin ? seen >= 1 : seen <= 1,
    `${seen} rows`,
  )

  // Privilege escalation, the check that matters most — but only meaningful
  // for an account that is not already an admin. An admin granting a role is
  // the feature, and a check that cannot tell the two apart would report a
  // working system as broken, or worse, get ignored.
  if (isAdmin) {
    report('escalation check skipped — already an admin', true)
  } else {
    await db.rpc('grant_role', { p_user_id: auth.user.id, p_role: 'admin' })
    const { data: after } = await db.from('my_access').select('*')
    const gained = (after?.[0]?.roles ?? []).includes('admin')
    report('cannot grant itself admin', !gained, gained ? 'ESCALATED' : undefined)
  }

  const { error: listError } = await db.rpc('list_users')
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

  // The engine, actually run.
  //
  // This is here because everything above it passed for weeks while
  // run_schedule failed on every single call: Supabase preloads `safeupdate`
  // for the roles PostgREST connects as, native Postgres does not, and the
  // engine carried an UPDATE with no WHERE clause. 108 green tests against a
  // product whose central function had never once worked in production.
  //
  // Reading a view proves the door is open. Only calling the function proves
  // anything is behind it.
  if (canPlan) {
    const { error: runError } = await db.rpc('run_schedule', {
      p_make_current: false,
      p_note: 'verify:live probe',
    })
    report('can run the schedule', !runError, runError?.message?.slice(0, 60))

    // Idempotent — rebuilds the same calendar over the same horizon. Fails the
    // same way, which meant no holiday could be added or removed.
    const { error: calError } = await db.rpc('rebuild_working_days', {})
    report('can rebuild the calendar', !calError, calError?.message?.slice(0, 60))
  }

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
