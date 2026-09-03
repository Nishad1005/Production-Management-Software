import { useState } from 'react'
import { signIn } from '@/lib/auth'
import { Button, Field } from '@/components/ui'
import { inputClass } from '@/components/format'

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="gridpaper grid min-h-full place-items-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="text-center">
          <p className="text-blue font-mono text-[11px] tracking-[0.16em] uppercase">
            Data Brilliance Business Solutions LLP
          </p>
          <h1 className="font-display text-display mt-2 font-extrabold tracking-[-0.03em]">
            Kram
          </h1>
          <p className="text-mid text-small mt-1.5">
            Production planning &amp; control for U&amp;M Designs.
          </p>
        </div>

        <form
          className="border-ink bg-sheet rounded-card shadow-card mt-6 border p-8"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await signIn(email.trim(), password)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="space-y-4">
            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Password">
              <input
                className={inputClass}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
          </div>

          {error ? (
            <p className="border-flag bg-flag-wash text-flag rounded-control text-caption mt-4 border-l-[3px] px-3 py-2">
              {error}
            </p>
          ) : null}

          <div className="mt-5">
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>

          <p className="text-faint text-caption mt-5">
            Accounts are created by an administrator. If you cannot sign in, or
            you sign in and see nothing, ask them to check your roles — a new
            account has none until it is given some.
          </p>
        </form>
      </div>
    </div>
  )
}

/**
 * Signed in, but with no roles. Distinct from a login failure and worth saying
 * plainly: everything is working, the account simply has no permissions yet,
 * and every screen would be blank if we let them through.
 */
export function NoAccess({
  email,
  onSignOut,
}: {
  email: string | null
  onSignOut: () => void
}) {
  return (
    <div className="gridpaper grid min-h-full place-items-center px-6 py-16">
      <div className="border-ink bg-sheet rounded-card shadow-card w-full max-w-lg border p-8">
        <p className="label">Kram</p>
        <h1 className="font-display text-title mt-2 font-bold tracking-[-0.02em]">
          Your account has no roles yet
        </h1>
        <p className="text-mid text-small mt-3">
          You are signed in as <strong>{email}</strong>, but no roles have been
          assigned, so there is nothing you can see. An administrator can grant
          them from the Users screen.
        </p>
        <div className="mt-5">
          <Button variant="quiet" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
