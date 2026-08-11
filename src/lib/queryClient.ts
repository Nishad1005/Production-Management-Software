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
 * A write that fails silently is worse than one that throws: the screen goes on
 * showing the old value and the user believes it saved. Every mutation error is
 * surfaced, without each call site having to remember to handle it.
 */
export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error) => {
      lastError = error instanceof Error ? error.message : String(error)
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
