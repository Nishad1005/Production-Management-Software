import { MutationCache, QueryClient } from '@tanstack/react-query'

/**
 * Masters and the order book change rarely; schedule runs are immutable once
 * written. A minute of staleness costs nothing and saves a great deal of
 * refetching across the planning screens, which read the same run repeatedly.
 */

type Listener = (message: string | null) => void
const listeners = new Set<Listener>()
let lastError: string | null = null

/** Subscribe to write failures. Returns an unsubscribe function. */
export function onWriteError(listener: Listener): () => void {
  listeners.add(listener)
  listener(lastError)
  return () => {
    listeners.delete(listener)
  }
}

export function clearWriteError() {
  lastError = null
  for (const l of listeners) l(null)
}

/**
 * Postgres is accurate and unhelpful, and the banner is read by people on a
 * factory floor.
 *
 * Two runs of the engine at once — one person impatient in a second tab, two
 * planners at two desks — puts the second one behind the first's locks and it
 * gives up with `canceling statement due to lock timeout`. That is a true
 * sentence that tells the reader nothing they can act on, and it appears at
 * exactly the moment somebody is being shown the software.
 *
 * Only cases where the plain wording is *more* informative are rewritten;
 * anything unrecognised passes through untouched, because a message nobody
 * anticipated is the one most worth reading verbatim. Same rule, and the same
 * reason, as `friendlyAuthError`.
 */
export function friendlyWriteError(message: string): string {
  if (/lock timeout/i.test(message)) {
    return (
      'Something else is using this data right now — most likely a schedule ' +
      'run that has not finished. A run takes about a minute. Nothing was ' +
      'changed; wait for it to finish and try again.'
    )
  }
  if (/statement timeout/i.test(message)) {
    return (
      'That took longer than the database allows and was stopped, so nothing ' +
      'was changed. If it was the schedule, there may be more in the order ' +
      'book than the engine can plan in one run.'
    )
  }
  return message
}

/**
 * A write that fails silently is worse than one that throws: the screen goes on
 * showing the old value and the user believes it saved. Every mutation error is
 * surfaced, without each call site having to remember to handle it.
 */
export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error) => {
      lastError = friendlyWriteError(
        error instanceof Error ? error.message : String(error),
      )
      for (const l of listeners) l(lastError)
    },
    onSuccess: () => clearWriteError(),
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
