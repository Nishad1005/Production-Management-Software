import { QueryClient } from '@tanstack/react-query'

/**
 * Masters and the order book change rarely; schedule runs are immutable once
 * written. A minute of staleness costs nothing and saves a great deal of
 * refetching across the planning screens, which read the same run repeatedly.
 *
 * Anything that must be current — the freshness timestamps on imported data,
 * for instance — sets its own staleTime at the call site.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
