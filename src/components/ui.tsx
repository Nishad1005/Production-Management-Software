import type { ReactNode } from 'react'

/**
 * The card every screen is built out of.
 *
 * A white card on a tinted ground, under a slim ink title bar.
 *
 * The bar went away for one round and took the product's face with it: light
 * headers on white cards is what every dashboard looks like. It is back at
 * roughly half its old height, with the title in Archivo and the meta in
 * typewriter capitals — the drawing's title block, not a toolbar.
 *
 * The `title` prop is the anchor for a dozen browser checks (`text=Bottleneck
 * utilisation` and friends), so the wording of any title passed to this
 * component is frozen even though its appearance is not.
 */
export function Panel({
  title,
  meta,
  children,
  className = '',
}: {
  title: string
  meta?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`border-rule bg-sheet rounded-card border shadow-card ${className}`}
    >
      <header className="bg-ink flex flex-wrap items-baseline justify-between gap-3 rounded-t-[5px] px-5 py-2.5 text-white">
        <b className="font-display text-emphasis font-semibold tracking-[-0.01em]">
          {title}
        </b>
        {meta ? (
          <span className="text-faint-inverse font-mono text-[11px] tracking-[0.08em] uppercase">
            {meta}
          </span>
        ) : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

/**
 * A single figure with its name above it, and a colour that means something.
 *
 * The tone is the load vocabulary — clear inside capacity, amber at it, flag
 * over — carried as a left accent rather than as coloured digits, so the
 * number itself stays readable and the status is legible from across a desk.
 */
export function Metric({
  label,
  value,
  tone = 'ink',
  hint,
}: {
  label: string
  value: ReactNode
  tone?: 'ink' | 'flag' | 'clear' | 'amber' | 'blue'
  hint?: string
}) {
  const accents = {
    ink: 'border-l-rule',
    flag: 'border-l-flag',
    clear: 'border-l-clear',
    amber: 'border-l-amber',
    blue: 'border-l-blue',
  }
  const figures = {
    ink: 'text-ink',
    flag: 'text-flag',
    clear: 'text-ink',
    amber: 'text-ink',
    blue: 'text-ink',
  }
  return (
    <div
      className={`border-rule bg-sheet rounded-card border border-l-[3px] p-4 shadow-card ${accents[tone]}`}
    >
      <div className="label">{label}</div>
      <div
        className={`font-display nums text-display mt-1 font-bold tracking-[-0.02em] ${figures[tone]}`}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-faint text-caption mt-1">{hint}</div>
      ) : null}
    </div>
  )
}

/**
 * `scroll` makes a long table scroll inside a box of its own, so its header
 * can stick. Two things follow from how browsers work: a `top-0` header only
 * sticks inside the element that scrolls vertically, which the plain wrapper
 * never does; and collapsed borders are painted by the table rather than the
 * cell, so a stuck header's rule would stay behind — hence `border-separate`
 * with the rule on each cell.
 */
export function Table({ children, scroll = false }: { children: ReactNode; scroll?: boolean }) {
  return (
    <div className={scroll ? 'border-rule-soft max-h-[70vh] overflow-auto border' : '-mx-5 overflow-x-auto px-5'}>
      <table
        className={`nums w-full text-small ${scroll ? 'border-separate border-spacing-0' : 'border-collapse'}`}
      >
        {children}
      </table>
    </div>
  )
}

export function Th({
  children,
  align = 'left',
  sticky = false,
  wrap = false,
  code,
  className = '',
}: {
  // Optional: an action column has a header cell but no heading.
  children?: ReactNode
  align?: 'left' | 'right'
  /** Stays at the top while a `scroll` Table scrolls beneath it. */
  sticky?: boolean
  /** A department name over a narrow column wraps onto two lines. */
  wrap?: boolean
  /** The code behind a named column, for the checks: `th[data-code="SAND"]`. */
  code?: string
  className?: string
}) {
  return (
    <th
      data-code={code}
      className={`text-mid border-ink border-b-[1.5px] py-2.5 pr-3 font-mono text-[11px] font-medium tracking-[0.06em] uppercase ${
        wrap ? 'whitespace-normal align-bottom' : 'whitespace-nowrap'
      } ${align === 'right' ? 'pr-0 text-right' : 'text-left'} ${
        sticky ? 'bg-sheet sticky top-0 z-20' : ''
      } ${className}`}
    >
      {children}
    </th>
  )
}

/** A department name as a column heading: the name wrapped, the code beneath. */
export function ColumnName({ name, code }: { name: string; code: string }) {
  return (
    <span className="inline-block max-w-[72px] text-right">
      <span className="font-sans block text-[11px] leading-tight font-semibold tracking-normal normal-case">
        {name}
      </span>
      <span className="text-blue block text-[10px]">{code}</span>
    </span>
  )
}

export function Td({
  code,
  title,
  children,
  align = 'left',
  className = '',
}: {
  code?: string
  title?: string
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <td
      data-code={code}
      title={title}
      className={`border-rule-soft border-b py-2.5 pr-3 align-top ${
        align === 'right' ? 'pr-0 text-right' : ''
      } ${className}`}
    >
      {children}
    </td>
  )
}

export function Tag({
  children,
  tone = 'mid',
}: {
  children: ReactNode
  tone?: 'clear' | 'flag' | 'amber' | 'blue' | 'mid'
}) {
  const tones = {
    clear: 'bg-clear-wash text-clear border-clear/40',
    flag: 'bg-flag-wash text-flag border-flag/40',
    amber: 'bg-amber-wash text-amber border-amber/40',
    blue: 'bg-blue-wash text-blue border-blue/40',
    mid: 'bg-paper text-mid border-rule',
  }
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-1.5 py-0.5 font-mono text-[11px] font-medium tracking-[0.04em] whitespace-nowrap uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
  testId,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'quiet'
  type?: 'button' | 'submit'
  /**
   * Anchors a browser check to this button.
   *
   * Named `testId` rather than taken as `data-testid` on purpose: JSX does not
   * type-check hyphenated attributes, so writing `data-testid` on a component
   * that does not forward it compiles cleanly, renders nothing, and fails much
   * later as a click timing out on an element that was never there. This one
   * the compiler can see.
   */
  testId?: string
}) {
  // Same reasoning as inputClass: thumb-sized on a phone, dense on a desk.
  const base =
    'px-3.5 font-semibold rounded-control transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-11 py-2.5 text-body sm:min-h-0 sm:py-2 sm:text-small'
  const styles =
    variant === 'primary'
      ? 'bg-ink text-white hover:bg-blue'
      : 'border border-rule bg-sheet text-ink hover:border-blue hover:text-blue'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`${base} ${styles}`}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="label block pb-1">{label}</span>
      {children}
    </label>
  )
}


export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-mid text-small py-8 text-center">{children}</p>
}

/**
 * Loading, failed and empty are three different things.
 *
 * A screen that reads `query.data ?? []` says "nothing here" while the query
 * is still in flight — and where "nothing here" is a claim about the factory
 * ("nothing is late", "no day is over capacity") that is the worst kind of
 * wrong: it looks entirely normal. So a panel that makes a claim works out
 * where its query stands first, and says the claim only when the answer is
 * in. The Attention screen learned this on 30 Aug; every panel with a claim
 * follows it since 11 Oct. The state is also on the element as data, so the
 * checks can wait for `ready` rather than for a sentence (`refreshing` while a
 * newer answer is on its way: the panel keeps what it has, the check waits). `stateOf` and
 * `stateOfAll`, which work the state out, live in src/lib/query-state.ts so
 * this file exports components and nothing else.
 */
import type { QueryState } from '@/lib/query-state'
/**
 * What to say before the answer is known.
 *
 * Deliberately not a spinner that fades into an empty list: the difference
 * between "checked, nothing wrong" and "not checked yet" is the whole point,
 * so both are stated in words. A failure says plainly that it is about the
 * screen and not about the factory.
 */
export function Waiting({
  state,
  error,
  loading = 'Loading…',
  failed = 'This could not be loaded.',
}: {
  state: QueryState
  error?: unknown
  loading?: string
  failed?: string
}) {
  if (state !== 'failed') {
    return (
      <p data-state="loading" className="text-faint text-small py-8 text-center">
        {loading}
      </p>
    )
  }
  return (
    <div data-state="failed" className="border-flag bg-sheet border-l-2 p-3.5 text-small">
      <div className="text-flag font-semibold">{failed}</div>
      <div className="text-mid mt-1">
        Nothing here is a statement about the factory — it is a statement about
        this screen. {String(error)}
      </div>
    </div>
  )
}
