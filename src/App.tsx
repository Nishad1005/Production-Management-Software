import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { AccessContext, useAccess } from '@/lib/access-context'
import { clearWriteError, onWriteError } from '@/lib/queryClient'
import { backend } from '@/lib/backend'
import {
  fetchAccess,
  has,
  OFFLINE_ACCESS,
  signOut,
  useSession,
  type Role,
} from '@/lib/auth'
import { CommandCentre } from '@/routes/CommandCentre'
import { Heatmap } from '@/routes/Heatmap'
import { OrderBook } from '@/routes/OrderBook'
import { Acceptance } from '@/routes/Acceptance'
import { Gantt } from '@/routes/Gantt'
import { Masters } from '@/routes/Masters'
import { CapacitySheet } from '@/routes/CapacitySheet'
import { WhatIf } from '@/routes/WhatIf'
import { Users } from '@/routes/Users'
import { Login, NoAccess } from '@/routes/Login'

/** Which roles each screen is for. Cosmetic — RLS is the real boundary. */
const NAV: { to: string; label: string; end?: boolean; roles: Role[] }[] = [
  { to: '/', label: 'Command centre', end: true, roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/heatmap', label: 'Load heatmap', roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/gantt', label: 'Schedule', roles: ['md', 'planner', 'admin'] },
  { to: '/orders', label: 'Order book', roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/accept', label: 'Accept an order', roles: ['planner', 'merchandiser', 'admin'] },
  { to: '/whatif', label: 'What if', roles: ['planner', 'admin'] },
  { to: '/capacity', label: 'Capacity sheet', roles: ['planner', 'admin'] },
  { to: '/masters', label: 'Masters', roles: ['planner', 'admin'] },
  { to: '/users', label: 'Users', roles: ['admin'] },
]

/**
 * Postgres has to compile and the schema has to apply before anything can
 * render — offline, at least. It takes a second or two on first load and is
 * instant thereafter, so the wait is explained rather than hidden.
 */
function Boot({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'booting' | 'ready' | 'failed'>('booting')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    backend
      .ready()
      .then(() => !cancelled && setState('ready'))
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setState('failed')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'ready') return <>{children}</>

  return (
    <div className="grid min-h-full place-items-center px-6">
      <div className="border-ink bg-sheet max-w-lg border p-6">
        <p className="label">Kram</p>
        {state === 'booting' ? (
          <>
            <p className="font-sans mt-2 text-xl font-bold tracking-tight">
              Starting the database
            </p>
            <p className="text-mid mt-2 text-[13px]">
              Postgres is compiling in the browser and the schema is being
              applied. A moment on first load, instant after that.
            </p>
          </>
        ) : (
          <>
            <p className="font-sans text-flag mt-2 text-xl font-bold tracking-tight">
              The database did not start
            </p>
            <pre className="border-rule text-flag mt-3 overflow-x-auto border p-3 text-[11.5px] whitespace-pre-wrap">
              {error}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Sign-in, where there is anything to sign in to.
 *
 * The offline build has no accounts, so it goes straight through as the owner.
 * Putting a login screen in front of a database with no users in it would be
 * theatre.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, checked, isHosted } = useSession()

  const access = useQuery({
    enabled: !isHosted || Boolean(session),
    queryKey: ['access', session?.user.id ?? 'offline'],
    queryFn: () => fetchAccess(session),
  })

  if (!isHosted) {
    return (
      <AccessContext.Provider value={OFFLINE_ACCESS}>
        {children}
      </AccessContext.Provider>
    )
  }

  if (!checked) return null
  if (!session) return <Login />
  if (access.isLoading) return null

  if (!access.data?.roles.length) {
    return <NoAccess email={session.user.email ?? null} onSignOut={signOut} />
  }

  return (
    <AccessContext.Provider value={access.data}>
      {children}
    </AccessContext.Provider>
  )
}

function WriteErrorBanner() {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => onWriteError(setMessage), [])
  if (!message) return null

  return (
    <div className="border-flag bg-sheet border-b-2">
      <div className="mx-auto flex max-w-[1400px] items-start justify-between gap-4 px-6 py-3">
        <div>
          <p className="text-flag font-sans text-[13px] font-semibold">
            That change was not saved
          </p>
          <p className="text-mid mt-0.5 text-[11.5px]">{message}</p>
        </div>
        <button
          type="button"
          onClick={clearWriteError}
          className="text-faint hover:text-ink text-[16px] leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  const access = useAccess()
  const visible = NAV.filter((item) => has(access, ...item.roles))

  return (
    <div className="min-h-full">
      <header className="gridpaper bg-sheet border-ink border-b-2">
        <div className="mx-auto max-w-[1400px] px-6 pt-7">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="text-blue text-[11px] tracking-[0.18em] uppercase">
                Data Brilliance Business Solutions LLP
              </p>
              <h1 className="font-sans mt-2 text-[42px] leading-none font-extrabold tracking-[-0.03em]">
                Kram{' '}
                <em className="text-blue text-[22px] font-semibold not-italic">
                  production planning &amp; control
                </em>
              </h1>
              <p className="text-mid mt-2 max-w-[62ch] text-[13px]">
                Backward scheduling from the container stuffing date, load
                against capacity by component, and the days a department is
                asked for more than it can make.
              </p>
            </div>

            <div className="border-ink min-w-[240px] border-[1.5px]">
              {[
                ['Ref', 'DBBS/UM/KRAM/01'],
                ['Revision', 'B'],
                ['Client', 'U&M Designs'],
                [
                  access.isOffline ? 'Build' : 'Signed in',
                  access.isOffline ? 'Offline draft' : (access.email ?? ''),
                ],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="border-rule grid grid-cols-[80px_1fr] border-b last:border-b-0"
                >
                  <span className="text-faint border-rule border-r px-2.5 py-1.5 text-[10.5px] tracking-[0.08em] uppercase">
                    {k}
                  </span>
                  <span className="truncate px-2.5 py-1.5 text-[11px] font-medium">
                    {v}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
            <nav className="flex flex-wrap gap-x-6 gap-y-1">
              {visible.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `font-sans border-b-2 pb-2.5 text-[13px] font-semibold ${
                      isActive
                        ? 'border-blue text-blue'
                        : 'text-mid hover:text-ink border-transparent'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            {!access.isOffline ? (
              <div className="flex items-center gap-3 pb-2.5">
                <span className="text-faint text-[11px]">
                  {access.roles.join(' · ')}
                </span>
                <button
                  type="button"
                  onClick={signOut}
                  className="text-mid hover:text-flag text-[11.5px]"
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <WriteErrorBanner />

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>

      <footer className="border-ink bg-sheet mt-6 border-t-2">
        <div className="text-faint mx-auto flex max-w-[1400px] flex-wrap justify-between gap-4 px-6 py-5 text-[11px] tracking-[0.06em]">
          <span>
            {access.isOffline
              ? 'Kram — offline draft. Postgres runs in the browser.'
              : 'Kram — hosted. Access is enforced in the database.'}
          </span>
          <span>
            Reports load against capacity. Takes no view on overtime, hiring or
            ship dates.
          </span>
        </div>
      </footer>
    </div>
  )
}

export function App() {
  return (
    <HashRouter>
      <Boot>
        <AuthGate>
          <Shell>
            <Routes>
              <Route path="/" element={<CommandCentre />} />
              <Route path="/heatmap" element={<Heatmap />} />
              <Route path="/gantt" element={<Gantt />} />
              <Route path="/orders" element={<OrderBook />} />
              <Route path="/accept" element={<Acceptance />} />
              <Route path="/whatif" element={<WhatIf />} />
              <Route path="/capacity" element={<CapacitySheet />} />
              <Route path="/masters" element={<Masters />} />
              <Route path="/users" element={<Users />} />
            </Routes>
          </Shell>
        </AuthGate>
      </Boot>
    </HashRouter>
  )
}
