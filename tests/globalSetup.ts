import {
  startEmbeddedPostgres,
  type EmbeddedHandle,
} from '../scripts/db/embedded'

let handle: EmbeddedHandle | undefined

// One cluster for the whole run. Booting Postgres costs a few seconds; paying
// that per test file would make the suite something nobody runs.
export async function setup() {
  handle = await startEmbeddedPostgres()
}

export async function teardown() {
  await handle?.stop()
}
