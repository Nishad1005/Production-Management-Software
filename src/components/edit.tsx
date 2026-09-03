import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui'
import { inputClass } from '@/components/format'

/**
 * A number that becomes an input when clicked.
 *
 * Masters entry is hundreds of small numbers — a D-minus matrix is one cell per
 * article × department — so anything that costs a dialog per value will not get
 * filled in. Commit on Enter or blur, abandon on Escape.
 */
export function EditableNumber({
  value,
  onCommit,
  suffix = '',
  prefix = '',
  placeholder = '—',
  allowEmpty = false,
  min,
  max,
  step = 'any',
  align = 'right',
  width = 'w-20',
}: {
  value: number | null
  onCommit: (next: number | null) => void
  suffix?: string
  prefix?: string
  placeholder?: string
  allowEmpty?: boolean
  min?: number
  max?: number
  step?: number | 'any'
  align?: 'left' | 'right'
  width?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  function begin() {
    setDraft(value === null ? '' : String(value))
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (allowEmpty && value !== null) onCommit(null)
      return
    }
    const next = Number(trimmed)
    if (Number.isNaN(next) || next === value) return
    if (min !== undefined && next < min) return
    if (max !== undefined && next > max) return
    onCommit(next)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={begin}
        className={`hover:decoration-blue nums w-full underline decoration-dotted decoration-1 underline-offset-4 ${
          align === 'right' ? 'text-right' : 'text-left'
        } ${value === null ? 'text-faint' : ''}`}
        title="Click to edit"
      >
        {value === null ? placeholder : `${prefix}${value}${suffix}`}
      </button>
    )
  }

  return (
    <input
      ref={input}
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      className={`${inputClass} ${width} py-1 ${align === 'right' ? 'text-right' : ''}`}
    />
  )
}

/** Same, for short text. */
export function EditableText({
  value,
  onCommit,
  width = 'w-40',
}: {
  value: string
  onCommit: (next: string) => void
  width?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="hover:decoration-blue text-left underline decoration-dotted decoration-1 underline-offset-4"
        title="Click to edit"
      >
        {value}
      </button>
    )
  }

  return (
    <input
      ref={input}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (draft.trim() && draft !== value) onCommit(draft.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setEditing(false)
      }}
      className={`${inputClass} ${width} py-1`}
    />
  )
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="bg-ink/40 fixed inset-0 z-50 grid place-items-start overflow-y-auto p-6 pt-[8vh]"
      onClick={onClose}
    >
      <div
        data-testid="modal"
        className="border-ink bg-sheet rounded-card shadow-pop mx-auto w-full max-w-2xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-rule-soft flex items-center justify-between gap-4 border-b px-5 py-4">
          <div>
            <b className="text-emphasis font-semibold tracking-[-0.01em]">
              {title}
            </b>
            {subtitle ? (
              <span className="text-caption text-faint ml-3">{subtitle}</span>
            ) : null}
          </div>
          {/* A visible control outside a table, so it owes the 44px floor. */}
          <button
            type="button"
            onClick={onClose}
            className="text-faint hover:text-ink -mr-2 min-h-11 px-2 text-title leading-none sm:min-h-0"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function ModalActions({
  onCancel,
  submitLabel,
  busy,
  destructive,
}: {
  onCancel: () => void
  submitLabel: string
  busy?: boolean
  destructive?: boolean
}) {
  return (
    <div className="border-rule-soft mt-5 flex justify-end gap-2 border-t pt-4">
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? 'Working…' : destructive ? submitLabel : submitLabel}
      </Button>
    </div>
  )
}
