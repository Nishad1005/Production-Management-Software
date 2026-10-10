import { useSearchParams } from 'react-router'

/**
 * A tab that lives in the URL.
 *
 * `#/masters?tab=dminus` opens Masters on the D-minus matrix, so a tab can be
 * linked to, reloaded, and reached by the browser checks without clicking
 * through. The hash router keeps the query inside the hash, and react-router
 * parses it into `location.search`, which is what `useSearchParams` reads;
 * `window.location.search` stays empty and must not be used.
 *
 * The default tab is kept out of the URL, so the plain address still means
 * "the first tab". Replacing rather than pushing keeps the back button for
 * screens, not tabs.
 */
export function useTab<T extends string>(
  defaultTab: T,
  valid: readonly T[],
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = (valid as readonly string[]).includes(raw ?? '') ? (raw as T) : defaultTab
  const setTab = (next: T) =>
    setParams(
      (p) => {
        if (next === defaultTab) p.delete('tab')
        else p.set('tab', next)
        return p
      },
      { replace: true },
    )
  return [tab, setTab]
}
