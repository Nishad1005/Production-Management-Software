import type { ReactNode } from 'react'

/**
 * The card every screen is built out of.
 *
 * Was a hairline box under a solid ink title bar — the specification
 * document's panel, and the thing that made twenty screens read as paperwork.
 * Now a white card on a tinted ground: soft border, small shadow, a light
 * header carrying a 16px title.
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
      className={`border-rule-soft bg-sheet rounded-card border shadow-card ${className}`}
    >
      <header className="border-rule-soft flex flex-wrap items-baseline justify-between gap-3 border-b px-5 pt-4 pb-3">
        <b className="text-emphasis font-semibold tracking-[-0.01em]">{title}</b>
        {meta ? <span className="text-caption text-faint">{meta}</span> : null}
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
      className={`border-rule-soft bg-sheet rounded-card border border-l-[3px] p-4 shadow-card ${accents[tone]}`}
    >
      <div className="label">{label}</div>
      <div
        className={`nums text-display mt-1 font-semibold tracking-[-0.02em] ${figures[tone]}`}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-faint text-caption mt-1">{hint}</div>
      ) : null}
    </div>
  )
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="nums w-full border-collapse text-small">
        {children}
      </table>
    </div>
  )
}

export function Th({
  children,
  align = 'left',
}: {
  // Optional: an action column has a header cell but no heading.
  children?: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={`text-faint border-rule text-caption border-b py-2.5 pr-3 font-medium tracking-[0.04em] whitespace-nowrap uppercase ${
        align === 'right' ? 'pr-0 text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <td
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
    clear: 'bg-clear-wash text-clear',
    flag: 'bg-flag-wash text-flag',
    amber: 'bg-amber-wash text-amber',
    blue: 'bg-blue-wash text-blue',
    mid: 'bg-paper text-mid',
  }
  return (
    <span
      className={`text-caption inline-flex items-center rounded-full px-2 py-0.5 font-medium tracking-[0.02em] whitespace-nowrap uppercase ${tones[tone]}`}
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
      ? 'bg-blue text-white hover:bg-blue/90'
      : 'border border-rule bg-sheet text-ink hover:bg-paper hover:border-faint'
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
