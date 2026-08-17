import type { ReactNode } from 'react'

/** Bordered sheet with a dark title bar — the specification document's panel. */
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
    <section className={`border-ink bg-sheet border ${className}`}>
      <header className="bg-ink flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-white">
        <b className="font-sans text-[13px] font-semibold">{title}</b>
        {meta ? (
          <span className="text-[10.5px] tracking-[0.12em] text-[#93a6b8] uppercase">
            {meta}
          </span>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** A single figure with its name above it. */
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
  const tones = {
    ink: 'text-ink',
    flag: 'text-flag',
    clear: 'text-clear',
    amber: 'text-amber',
    blue: 'text-blue',
  }
  return (
    <div className="border-rule border p-3">
      <div className="label">{label}</div>
      <div
        className={`font-sans nums mt-0.5 text-[26px] leading-tight font-bold tracking-tight ${tones[tone]}`}
      >
        {value}
      </div>
      {hint ? <div className="text-faint mt-0.5 text-[11px]">{hint}</div> : null}
    </div>
  )
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="nums w-full border-collapse text-[12.5px]">
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
      className={`text-blue border-ink border-b-[1.5px] py-2 pr-3 text-[10.5px] tracking-[0.08em] whitespace-nowrap uppercase ${
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
      className={`border-rule-soft border-b py-2 pr-3 align-top ${
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
    clear: 'text-clear',
    flag: 'text-flag',
    amber: 'text-amber',
    blue: 'text-blue',
    mid: 'text-mid',
  }
  return (
    <span
      className={`inline-block rounded-[2px] border border-current px-1.5 py-px text-[10px] font-semibold tracking-[0.05em] uppercase ${tones[tone]}`}
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
    'font-sans px-3.5 font-semibold rounded-[2px] disabled:opacity-40 disabled:cursor-not-allowed min-h-11 py-2.5 text-[14px] sm:min-h-0 sm:py-2 sm:text-[13px]'
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
  return <p className="text-mid py-6 text-center text-[12.5px]">{children}</p>
}
