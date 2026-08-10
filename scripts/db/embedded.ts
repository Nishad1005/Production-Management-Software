import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import type { Client } from 'pg'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..')

export const MIGRATIONS_DIR = join(repoRoot, 'supabase', 'migrations')
const AUTH_SHIM = join(here, 'auth-shim.sql')
const GRANTS = join(here, 'grants.sql')

/**
 * An unusual port, so a stray Postgres on 5432 is never mistaken for ours and
 * a failed teardown is obvious rather than silently reused.
 */
export const TEST_PORT = 54329
export const TEST_DATABASE = 'kram_test'
export const TEST_DATABASE_URL = `postgres://postgres:postgres@localhost:${TEST_PORT}/${TEST_DATABASE}`

const DATA_DIR = join(repoRoot, 'node_modules', '.cache', 'kram-test-pg')

export type EmbeddedHandle = {
  pg: EmbeddedPostgres
  stop: () => Promise<void>
}

/**
 * Boots a throwaway Postgres cluster and applies the auth shim, every
 * migration in order, then the API grants.
 *
 * This exists so the schema and the scheduling engine are executed rather than
 * merely written. A migration that only ever ran in production review is a
 * migration nobody has tested.
 */
export async function startEmbeddedPostgres(): Promise<EmbeddedHandle> {
  // A previous crashed run leaves a data directory that initialise() refuses to
  // overwrite, so clear it rather than failing on somebody else's mess.
  await rm(DATA_DIR, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: TEST_PORT,
    persistent: false,
  })

  await pg.initialise()
  await pg.start()
  await pg.createDatabase(TEST_DATABASE)

  const client = pg.getPgClient(TEST_DATABASE)
  await client.connect()
  try {
    await applySchema(client)
  } finally {
    await client.end()
  }

  return {
    pg,
    stop: async () => {
      await pg.stop()
      await rm(DATA_DIR, { recursive: true, force: true })
    },
  }
}

/**
 * Applies the auth shim and API grants, then every migration in order.
 *
 * Grants go on before the migrations because Supabase hands the API roles
 * access as objects are created. A migration that revokes a privilege has to be
 * able to make it stick.
 */
export async function applySchema(client: Client): Promise<void> {
  await client.query(await readFile(AUTH_SHIM, 'utf8'))
  await client.query(await readFile(GRANTS, 'utf8'))

  for (const file of await migrationFiles()) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      await client.query(sql)
    } catch (cause) {
      throw new Error(`Migration ${file} failed: ${(cause as Error).message}`, {
        cause,
      })
    }
  }
}

/** Migration filenames in the order Supabase would apply them. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  return entries.filter((f) => f.endsWith('.sql')).sort()
}
