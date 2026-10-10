#!/usr/bin/env node
/**
 * Times the scheduling engine on the fixtures the suite guards, as the owner
 * and as a signed-in planner, so a number in the log was taken where the cost
 * is actually paid.
 *
 *   node scripts/bench-engine.mjs [--fixtures=sparse,dense,um,um4]
 *                                 [--roles=owner,planner]
 *                                 [--dump <dir>] [--explain] [--plans=N]
 *                                 [--pglite] [--stale-plans] [--custom-plans]
 *                                 [--timeout=300]
 *
 * The tests run as the table owner, where row-level security does not apply,
 * and the engine's cost on Supabase was almost entirely row-level security:
 * every one of its per-cell function calls paid the policy once. Locally as
 * owner the dense fixture planned in under five seconds while the live project
 * took 37 seconds for a fiftieth of the work. So each fixture is run twice —
 * once as `postgres`, once as `authenticated` with a planner's claims, exactly
 * as a request through PostgREST arrives — and the planner's figure is the one
 * that predicts the site.
 *
 * `--dump <dir>` writes the run's four schedule tables as CSV by natural key,
 * without identity columns, so a directory taken before a change and one
 * taken after can be `diff -r`ed: the proof that a faster engine wrote the
 * same plan. `--explain` loads auto_explain and prints the slowest statements
 * inside the engine, which is what decides where the next second goes.
 * `--pglite` times the demonstration build's boot run in PGlite, because the
 * offline build pays the engine on every master edit.
 *
 * Boots its own cluster on its own port and data directory, so it never shares
 * one with a test run — but it is still a Postgres on this machine, and a
 * number taken while the suite or a browser check was running is a number
 * taken on a busy machine. Run it alone.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import { applySchema, MIGRATIONS_DIR, migrationFiles } from './db/embedded.ts'
import {
  DENSE_FIXTURE,
  SPARSE_FIXTURE,
  umFixture,
} from '../tests/helpers/scale-fixtures.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const FIXTURES = {
  sparse: SPARSE_FIXTURE,
  dense: DENSE_FIXTURE,
  um: umFixture(),
  um4: umFixture({ componentsPerCell: 4 }),
}
const fixtures = option('fixtures', 'sparse,dense,um,um4').split(',')
const roles = option('roles', 'owner,planner').split(',')
const dumpDir = option('dump', null)
const explain = flag('explain')
const plans = Number(option('plans', 0)) // full plans for the N slowest statements
const customPlans = flag('custom-plans') // plan_cache_mode = force_custom_plan on the session
// A cap on every run. The function's own 120-second ceiling is armed by the
// session's timer on Supabase and not on a fresh local session, where the old
// engine sat inside one U&M-scale run for twenty minutes before it was killed.
const timeoutSeconds = Number(option('timeout', 300))

for (const f of fixtures) {
  if (!FIXTURES[f]) {
    console.error(`No fixture called ${f}. Known: ${Object.keys(FIXTURES).join(', ')}`)
    process.exit(1)
  }
}

// Its own cluster, beside the test one and never on its port.
const PORT = 54330
const DB = 'kram_bench'
const DATA_DIR = join(repoRoot, 'node_modules', '.cache', 'kram-bench-pg')

const results = []
const log = (s) => console.log(s)

if (flag('pglite')) {
  await benchPglite()
}

if (fixtures.length && roles.length && !flag('pglite-only')) {
  await benchPostgres()
}

log('')
log('| fixture | role | tasks | load rows | capacity rows | engine ms (warm) | cold ms |')
log('|---|---|---:|---:|---:|---:|---:|')
for (const r of results) {
  log(
    `| ${r.fixture} | ${r.role} | ${fmt(r.tasks)} | ${fmt(r.loads)} | ${fmt(r.capacities)} | ${r.warm} | ${r.cold} |`,
  )
}

function fmt(n) {
  return n === undefined || n === null ? '—' : Number(n).toLocaleString('en-IN')
}

async function benchPostgres() {
  await rm(DATA_DIR, { recursive: true, force: true })
  const serverLog = []
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    onLog: (m) => serverLog.push(String(m)),
    onError: (m) => serverLog.push(String(m)),
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase(DB)
  const client = pg.getPgClient(DB)
  await client.connect()
  try {
    await applySchema(client)
    const { rows: v } = await client.query('select version()')
    log(v[0].version.split(',')[0])

    if (explain) {
      // Nested statements are what the engine is made of; auto_explain is the
      // only thing that sees inside a plpgsql function without editing it.
      await client.query(`load 'auto_explain'`)
      await client.query(`set auto_explain.log_min_duration = 50`)
      await client.query(`set auto_explain.log_nested_statements = on`)
      await client.query(`set auto_explain.log_analyze = on`)
      await client.query(`set auto_explain.log_timing = off`)
      await client.query(`set auto_explain.log_triggers = on`)
    }
    if (customPlans) await client.query(`set plan_cache_mode = force_custom_plan`)
    await client.query(`set statement_timeout = '${timeoutSeconds}s'`)

    for (const fixture of fixtures) {
      for (const role of roles) {
        serverLog.length = 0
        // A fresh session per run: plpgsql caches the plan of every statement
        // in the function per session, and a plan made for a small run reused
        // on a big one is what turned a five-second dense run into eighty-eight.
        // `--stale-plans` keeps one session throughout, to show that.
        const session = flag('stale-plans') ? client : await fresh(pg)
        try {
          const r = await benchOne(session, fixture, role)
          results.push(r)
          log(
            `${fixture} as ${role}: ${fmt(r.tasks)} tasks, ${fmt(r.loads)} load rows, ` +
              `engine ${r.warm} (cold ${r.cold})`,
          )
          if (explain) {
            const slow = slowest(serverLog.join('\n'))
            for (const s of slow) {
              log(`    ${String(s.ms).padStart(9)} ms  ${s.query}${s.spill ? '  [SPILLS]' : ''}`)
              log(`                   ${s.node}`)
            }
            for (const s of slow.filter((x) => !/^select run_schedule/.test(x.query)).slice(0, plans)) {
              log(`\n--- plan, ${s.ms} ms: ${s.query}\n${s.plan}\n`)
            }
          }
        } finally {
          if (session !== client) await session.end()
        }
      }
    }
  } finally {
    await client.end()
    await pg.stop()
    await rm(DATA_DIR, { recursive: true, force: true })
  }
}

async function fresh(pg) {
  const c = pg.getPgClient(DB)
  await c.connect()
  if (explain) {
    await c.query(`load 'auto_explain'`)
    await c.query(`set auto_explain.log_min_duration = 50`)
    await c.query(`set auto_explain.log_nested_statements = on`)
    await c.query(`set auto_explain.log_analyze = on`)
    await c.query(`set auto_explain.log_timing = off`)
    await c.query(`set auto_explain.log_triggers = on`)
  }
  if (customPlans) await c.query(`set plan_cache_mode = force_custom_plan`)
  await c.query(`set statement_timeout = '${timeoutSeconds}s'`)
  return c
}

async function benchOne(client, fixture, role) {
  const out = { fixture, role }
  await client.query('begin')
  try {
    await client.query(FIXTURES[fixture])
    await client.query('analyze')

    if (role === 'planner') {
      const { rows } = await client.query(
        `insert into auth.users (email) values ('bench@kram.test') returning id`,
      )
      await client.query(
        `insert into user_roles (user_id, role) values ($1, 'planner'::app_role)`,
        [rows[0].id],
      )
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        rows[0].id,
      ])
      await client.query('set local role authenticated')
    }

    let runId = null
    for (const pass of ['cold', 'warm']) {
      await client.query('savepoint run')
      const started = Date.now()
      try {
        const { rows } = await client.query(`select run_schedule() as id`)
        runId = rows[0].id
        await client.query('release savepoint run')
        const { rows: s } = await client.query(
          `select duration_ms from schedule_runs where id = $1`,
          [runId],
        )
        out[pass] = `${s[0].duration_ms} ms`
        out[`${pass}Wall`] = Date.now() - started
      } catch (error) {
        await client.query('rollback to savepoint run')
        out[pass] = /statement timeout/.test(error.message)
          ? `cancelled at ${timeoutSeconds} s`
          : `error: ${error.message.slice(0, 80)}`
        break
      }
    }

    if (runId) {
      const { rows } = await client.query(
        `select r.task_count, r.breach_count,
                (select count(*) from schedule_daily_load where run_id = r.id)::text as loads,
                (select count(*) from schedule_daily_capacity where run_id = r.id)::text as capacities,
                (select count(*) from schedule_daily_department where run_id = r.id)::text as department_days
           from schedule_runs r where r.id = $1`,
        [runId],
      )
      Object.assign(out, {
        tasks: rows[0].task_count,
        breaches: rows[0].breach_count,
        loads: rows[0].loads,
        capacities: rows[0].capacities,
        departmentDays: rows[0].department_days,
      })
      if (dumpDir) await dump(client, runId, join(dumpDir, `${fixture}-${role}`))
    }
    return out
  } finally {
    await client.query('rollback')
  }
}

/**
 * The run as four CSV files by natural key — codes and dates, never ids — so
 * two runs of two engines can be compared with `diff`. Identity columns are
 * left out on purpose: a set-based grid assigns them in a different order and
 * means exactly the same thing.
 */
async function dump(client, runId, dir) {
  await mkdir(dir, { recursive: true })
  const files = {
    'tasks.csv': `
      select coalesce(string_agg(line, E'\\n' order by k1, k2, k3, k4), '') as body
        from (
          select o.erp_order_no as k1, sl.line_no as k2, d.code as k3, c.code as k4,
                 concat_ws(',', o.erp_order_no, sl.line_no, d.code, c.code,
                   coalesce(t.due_date::text, ''), coalesce(t.start_date::text, ''),
                   coalesce(t.end_date::text, ''), t.qty_required::text,
                   coalesce(t.days_needed::text, ''), t.is_feasible::text,
                   coalesce(t.breach_reason::text, ''), t.is_pinned::text) as line
            from schedule_tasks t
            join shipment_lines sl on sl.id = t.shipment_line_id
            join orders o on o.id = sl.order_id
            join departments d on d.id = t.department_id
            join components c on c.id = t.component_id
           where t.run_id = $1
        ) x`,
    'loads.csv': `
      select coalesce(string_agg(line, E'\\n' order by k1, k2, k3, k4, k5, k6), '') as body
        from (
          select o.erp_order_no as k1, sl.line_no as k2, d.code as k3, s.code as k4,
                 c.code as k5, l.load_date as k6,
                 concat_ws(',', o.erp_order_no, sl.line_no, d.code, s.code, c.code,
                   l.load_date::text, l.qty_planned::text) as line
            from schedule_daily_load l
            join shipment_lines sl on sl.id = l.shipment_line_id
            join orders o on o.id = sl.order_id
            join departments d on d.id = l.department_id
            join shifts s on s.id = l.shift_id
            join components c on c.id = l.component_id
           where l.run_id = $1
        ) x`,
    'capacity.csv': `
      select coalesce(string_agg(line, E'\\n' order by k1, k2, k3, k4), '') as body
        from (
          select d.code as k1, s.code as k2, c.code as k3, g.load_date as k4,
                 concat_ws(',', d.code, s.code, c.code, g.load_date::text, g.capacity::text) as line
            from schedule_daily_capacity g
            join departments d on d.id = g.department_id
            join shifts s on s.id = g.shift_id
            join components c on c.id = g.component_id
           where g.run_id = $1
        ) x`,
    'department-days.csv': `
      select coalesce(string_agg(line, E'\\n' order by k1, k2), '') as body
        from (
          select d.code as k1, x.load_date as k2,
                 concat_ws(',', d.code, x.load_date::text, x.utilisation::text,
                   x.components_loaded::text, x.status::text) as line
            from schedule_daily_department x
            join departments d on d.id = x.department_id
           where x.run_id = $1
        ) x`,
  }
  for (const [name, sql] of Object.entries(files)) {
    const { rows } = await client.query(sql, [runId])
    await writeFile(join(dir, name), rows[0].body + '\n')
  }
}

/**
 * auto_explain's entries, slowest first: the duration, the first line of the
 * statement, the top plan node, and whether a sort or hash spilled to disk.
 */
function slowest(text, n = 10) {
  const entries = []
  const blocks = text.split(/(?=duration: [\d.]+ ms\s+plan:)/)
  for (const b of blocks) {
    const m = b.match(/^duration: ([\d.]+) ms\s+plan:\s*\n\s*Query Text:([\s\S]*?)\n(?=\s*(?:Seq Scan|Hash|Nested Loop|Merge|Sort|Index|Aggregate|WindowAgg|Insert|Result|CTE|Subquery|Gather|Unique|Limit|Function Scan|Bitmap|Materialize|Memoize|Group|Append|Recursive|ProjectSet))/)
    if (!m) continue
    const rest = b.slice(m[0].length)
    const firstLine = m[2].split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--')) ?? ''
    const node = rest
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^(Seq Scan|Hash|Nested Loop|Merge|Sort|Index|Aggregate|WindowAgg|Insert|Result|CTE|Subquery|Gather|Unique|Limit|Function Scan|Bitmap|Materialize|Memoize|Group|Append|Recursive|ProjectSet)/.test(l))
    entries.push({
      ms: Math.round(Number(m[1])),
      query: firstLine.replace(/\s+/g, ' ').slice(0, 100) || '(statement)',
      node: (node ?? '').slice(0, 110),
      plan: rest.split('\n').filter((l) => l.trim() && !/^\d{4}-\d\d-\d\d /.test(l)).slice(0, 80).join('\n'),
      spill: /Sort Method: external|Batches: (?!1\b)\d+/.test(rest),
    })
  }
  return entries.sort((a, b) => b.ms - a.ms).slice(0, n)
}

/** The demonstration build's boot run, in PGlite, as src/lib/database.ts does it. */
async function benchPglite() {
  const { PGlite } = await import('@electric-sql/pglite')
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist')
  const db = await PGlite.create({ extensions: { btree_gist } })
  const started = Date.now()
  await db.exec(await readFile(join(here, 'db', 'auth-shim.sql'), 'utf8'))
  for (const f of await migrationFiles()) {
    await db.exec(await readFile(join(MIGRATIONS_DIR, f), 'utf8'))
  }
  for (const s of ['seed.sql', 'seed_demo.sql']) {
    await db.exec(await readFile(join(repoRoot, 'supabase', s), 'utf8'))
  }
  const schemaMs = Date.now() - started
  const out = { fixture: 'pglite demo', role: 'owner' }
  for (const pass of ['cold', 'warm']) {
    const { rows } = await db.query(`select run_schedule(p_note => $1) as id`, [`bench ${pass}`])
    const { rows: s } = await db.query(
      `select r.task_count, r.duration_ms,
              (select count(*) from schedule_daily_load where run_id = r.id)::text as loads,
              (select count(*) from schedule_daily_capacity where run_id = r.id)::text as capacities
         from schedule_runs r where r.id = $1`,
      [rows[0].id],
    )
    out[pass] = `${s[0].duration_ms} ms`
    Object.assign(out, { tasks: s[0].task_count, loads: s[0].loads, capacities: s[0].capacities })
  }
  await db.close()
  results.push(out)
  log(`pglite: schema and seeds in ${schemaMs} ms; boot run ${out.cold}, again ${out.warm}`)
}
