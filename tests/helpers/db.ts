import pg from 'pg'
import { TEST_DATABASE_URL } from '../../scripts/db/embedded'

const { Client } = pg

/** Runs fn against a fresh connection, always closing it. */
export async function withClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Runs fn inside a transaction that is always rolled back, so tests can insert
 * freely without ordering themselves around each other's leftovers.
 */
export async function withRollback<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(async (client) => {
    await client.query('begin')
    try {
      return await fn(client)
    } finally {
      await client.query('rollback')
    }
  })
}

/**
 * Switches the current transaction to the `authenticated` API role acting as a
 * given user, exactly as a request through PostgREST would.
 *
 * Policy tests must go through this rather than staying as the owning
 * superuser: table owners bypass RLS, so a policy test run as `postgres` passes
 * regardless of what the policy actually says. Call it *after* creating
 * fixtures, since `authenticated` will not be able to.
 */
export async function becomeUser(
  client: pg.Client,
  userId: string,
): Promise<void> {
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
    userId,
  ])
  await client.query('set local role authenticated')
}

/** Creates an auth user (profile follows by trigger) and grants roles. */
export async function createUser(
  client: pg.Client,
  email: string,
  roles: string[] = [],
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [email],
  )
  const id = rows[0].id
  for (const role of roles) {
    await client.query(
      `insert into user_roles (user_id, role) values ($1, $2::app_role)`,
      [id, role],
    )
  }
  return id
}
