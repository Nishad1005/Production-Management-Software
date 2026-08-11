import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

/**
 * Kram's database, running in the browser.
 *
 * PGlite is Postgres 18 compiled to WebAssembly, so the migrations, the
 * scheduling engine and the planning views are byte-for-byte the same SQL that
 * will run on Supabase. Nothing is reimplemented in JavaScript for the offline
 * build, which is the whole point: what the client is shown is the real engine,
 * not a mock of it.
 *
 * What is *not* exercised offline: row-level security. Everything here runs as
 * the owner, so policies are created but never enforced. That is fine for a
 * demonstration and must not be mistaken for having tested access control —
 * tests/rls.test.ts is what covers that, against a native Postgres.
 */

// Vite inlines these at build time, so the published bundle carries the schema
// with it and needs no server to fetch it from.
const migrations = import.meta.glob('/supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const authShim = import.meta.glob('/scripts/db/auth-shim.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const seeds = import.meta.glob('/supabase/seed*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Bumped whenever the schema or demo data changes, to force a rebuild. */
const SCHEMA_VERSION = '1'
const STORAGE_KEY = `kram-schema-version`
const DATA_DIR = 'idb://kram'

let instance: PGlite | undefined
let booting: Promise<PGlite> | undefined

async function applySchema(db: PGlite) {
  const shim = Object.values(authShim)[0]
  if (shim) await db.exec(shim)

  for (const path of Object.keys(migrations).sort()) {
    try {
      await db.exec(migrations[path])
    } catch (cause) {
      throw new Error(`Migration ${path.split('/').pop()} failed: ${String(cause)}`, {
        cause,
      })
    }
  }

  // seed.sql is the placeholder route; seed_demo.sql is the order book that
  // makes the screens worth looking at. Sorting puts them in that order.
  for (const path of Object.keys(seeds).sort()) {
    await db.exec(seeds[path])
  }

  await db.exec(`select run_schedule(p_note => 'Initial run')`)
}

/**
 * Boots the database, applying the schema on first run only. State persists in
 * IndexedDB, so a reload keeps whatever the user entered.
 */
export function getDatabase(): Promise<PGlite> {
  if (instance) return Promise.resolve(instance)
  if (booting) return booting

  booting = (async () => {
    // The schema moved on since this browser last loaded. Rebuilding from
    // scratch beats migrating a demo database.
    if (localStorage.getItem(STORAGE_KEY) !== SCHEMA_VERSION) {
      await dropLocalDatabase()
    }

    const db = await PGlite.create({
      dataDir: DATA_DIR,
      extensions: { btree_gist },
    })

    const { rows } = await db.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'schedule_runs'
       ) as present`,
    )

    if (!rows[0]?.present) {
      await applySchema(db)
      localStorage.setItem(STORAGE_KEY, SCHEMA_VERSION)
    }

    instance = db
    return db
  })()

  return booting
}

/** Runs a query and returns its rows. */
export async function query<T>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await getDatabase()
  const result = await db.query<T>(sql, params)
  return result.rows
}

/** Runs statements for their effect. */
export async function exec(sql: string): Promise<void> {
  const db = await getDatabase()
  await db.exec(sql)
}

/**
 * Deletes the persisted database, waiting for the browser to confirm it.
 *
 * Firing the request without awaiting it means the next PGlite.create() can win
 * the race and open the store that is about to be deleted, which leaves a
 * half-built schema behind and only shows up as a baffling error later.
 */
function dropLocalDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(`/pglite/${DATA_DIR.slice(6)}`)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // Another tab still has it open. Nothing to be done but carry on.
    request.onblocked = () => resolve()
  })
}

/** Throws away all local state and reapplies the schema and demo data. */
export async function resetDatabase(): Promise<void> {
  if (instance) await instance.close()
  instance = undefined
  booting = undefined
  localStorage.removeItem(STORAGE_KEY)
  await dropLocalDatabase()
  await getDatabase()
}
