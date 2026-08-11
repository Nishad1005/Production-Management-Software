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
        <p className="text-blue text-[11px] tracking-[0.18em] uppercase">
          Data Brilliance Business Solutions LLP
        </p>
        <h1 className="font-sans mt-2 text-[42px] leading-none font-extrabold tracking-[-0.03em]">
          Kram
        </h1>
        <p className="text-mid mt-2 text-[13px]">
          Production planning &amp; control for U&amp;M Designs.
        </p>

        <form
          className="border-ink bg-sheet mt-7 border p-6"
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
            <p className="border-flag text-flag mt-4 border-l-[3px] py-1 pl-3 text-[12px]">
              {error}
            </p>
          ) : null}

          <div className="mt-5">
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>

          <p className="text-faint mt-5 text-[11.5px]">
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
      <div className="border-ink bg-sheet w-full max-w-lg border p-6">
        <p className="label">Kram</p>
        <h1 className="font-sans mt-2 text-2xl font-bold tracking-tight">
          Your account has no roles yet
        </h1>
        <p className="text-mid mt-3 text-[13px]">
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
