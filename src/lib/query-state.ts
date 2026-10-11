/**
 * Where a query stands, for the sentence a panel is allowed to say.
 *
 * Loading, failed and empty are three different things, and a panel that
 * makes a claim about the factory ("nothing is late", "no day is over
 * capacity") says it only when the answer is in. See `Waiting` in
 * src/components/ui.tsx for the words.
 *
 * `refreshing` is the fourth state: the panel has an answer and is fetching a
 * newer one — every write invalidates every query, and a screen opened after
 * one shows what it last knew while the fresh answer is on its way. The panel
 * keeps showing what it has (a flash of "Loading…" over a list on every
 * declaration would be worse), but the attribute says so, because a check
 * that reads the figure while it is `refreshing` reads the old one. The
 * Attention step found this: the badge, mounted on every screen, had refetched
 * after each write; the screen, mounted fresh, called its cached list `ready`.
 */
export type QueryState = 'loading' | 'refreshing' | 'failed' | 'ready'

type Q = { isPending: boolean; isError: boolean; isFetching: boolean }

export function stateOf(q: Q): QueryState {
  return q.isPending
    ? 'loading'
    : q.isError
      ? 'failed'
      : q.isFetching
        ? 'refreshing'
        : 'ready'
}

/**
 * Several queries feeding one panel: loading until all are in, failed if any
 * failed, refreshing while any is fetching a newer answer.
 */
export function stateOfAll(...qs: Q[]): QueryState {
  if (qs.some((q) => q.isError)) return 'failed'
  if (qs.some((q) => q.isPending)) return 'loading'
  if (qs.some((q) => q.isFetching)) return 'refreshing'
  return 'ready'
}

/** Whether the panel has nothing to show yet: it says `Waiting`, not its claim. */
export function waiting(s: QueryState): s is 'loading' | 'failed' {
  return s === 'loading' || s === 'failed'
}
