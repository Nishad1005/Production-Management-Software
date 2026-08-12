import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { schemaVersion } from '@/lib/schema-version'

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

/**
 * Derived from the SQL above rather than declared, so it changes exactly when
 * the schema or the demonstration data changes and never needs remembering.
 * See schema-version.ts for what the constant it replaces cost.
 */
const SCHEMA_VERSION = schemaVersion({ ...migrations, ...authShim, ...seeds })
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
    const stale = localStorage.getItem(STORAGE_KEY) !== SCHEMA_VERSION
    if (stale) await dropLocalDatabase()

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

    // Deleting the store can be *blocked* — by another tab, or by a connection
    // the page it replaced has not finished closing — and the request resolves
    // either way rather than reporting it. When that happens the old schema is
    // still sitting there, and the check above finds it and skips the rebuild:
    // the browser keeps a database it has already decided is out of date, and
    // nothing says so. Clearing it in SQL depends on nothing but the connection
    // we are holding.
    if (stale && rows[0]?.present) {
      await db.exec(`drop schema public cascade; create schema public;`)
    }

    if (stale || !rows[0]?.present) {
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
 * Runs several statements as one unit, rolled back entirely if any of them
 * fails. Used by the masters import, where a file applied halfway would leave
 * the route describing a factory that does not exist.
 */
export async function transaction<T>(
  fn: (run: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const db = await getDatabase()
  return db.transaction(async (tx) => fn((sql, params) => tx.query(sql, params)))
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
