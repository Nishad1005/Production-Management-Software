import type { ReactNode } from 'react'

/**
 * The strip itself. Buttons, not links, so the phone check that measures
 * every anchor on a screen never applies, and 44px tall on a phone either
 * way. It scrolls sideways inside its own box rather than widening the page,
 * exactly as the menu bar does.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix,
}: {
  tabs: readonly { id: T; label: ReactNode; count?: number | string }[]
  value: T
  onChange: (next: T) => void
  testIdPrefix: string
}) {
  return (
    <div
      role="tablist"
      className="border-rule-soft -mx-6 flex snap-x gap-x-5 overflow-x-auto border-b px-6 sm:mx-0 sm:flex-wrap sm:gap-x-6 sm:overflow-visible sm:px-0"
    >
      {tabs.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`${testIdPrefix}-${t.id}`}
            onClick={() => onChange(t.id)}
            className={`text-small -mb-px flex min-h-11 shrink-0 snap-start items-center gap-1.5 border-b-2 pb-2.5 font-medium sm:min-h-0 ${
              active ? 'border-blue text-blue' : 'text-mid hover:text-ink border-transparent'
            }`}
          >
            {t.label}
            {t.count !== undefined && t.count !== '' ? (
              <span className="text-faint font-mono text-[11px]">{t.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
