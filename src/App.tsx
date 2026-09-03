import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HashRouter, Link, NavLink, Route, Routes } from 'react-router'
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
import { Production } from '@/routes/Production'
import { DepartmentBoard } from '@/routes/DepartmentBoard'
import { Dashboard } from '@/routes/Dashboard'
import { Wip } from '@/routes/Wip'
import { Manpower } from '@/routes/Manpower'
import { Material } from '@/routes/Material'
import { Quality } from '@/routes/Quality'
import { Money } from '@/routes/Money'
import { Attention } from '@/routes/Attention'
import { Display } from '@/routes/Display'
import { FactoryMap } from '@/routes/FactoryMap'
import { Forecast } from '@/routes/Forecast'
import { useAttentionCount, useProvisionalState } from '@/data/attention'
import { WhatIf } from '@/routes/WhatIf'
import { Users } from '@/routes/Users'
import { Login, NoAccess } from '@/routes/Login'

/** Which roles each screen is for. Cosmetic — RLS is the real boundary. */
const NAV: { to: string; label: string; end?: boolean; roles: Role[] }[] = [
  { to: '/attention', label: 'Attention', roles: ['md', 'planner', 'hod', 'purchase', 'store', 'quality', 'admin'] },
  { to: '/', label: 'Command centre', end: true, roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/dashboard', label: 'Dashboard', roles: ['md', 'planner', 'admin'] },
  { to: '/map', label: 'Factory map', roles: ['md', 'planner', 'hod', 'admin'] },
  { to: '/heatmap', label: 'Load heatmap', roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/gantt', label: 'Schedule', roles: ['md', 'planner', 'admin'] },
  { to: '/orders', label: 'Order book', roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/accept', label: 'Accept an order', roles: ['planner', 'merchandiser', 'admin'] },
  { to: '/whatif', label: 'What if', roles: ['planner', 'admin'] },
  { to: '/wip', label: 'WIP', roles: ['md', 'planner', 'merchandiser', 'admin'] },
  { to: '/board', label: 'My department', roles: ['hod', 'planner', 'md', 'admin'] },
  { to: '/production', label: 'Production', roles: ['hod', 'planner', 'md', 'admin'] },
  { to: '/manpower', label: 'Manpower', roles: ['hod', 'hr', 'planner', 'md', 'admin'] },
  { to: '/material', label: 'Material', roles: ['purchase', 'store', 'planner', 'md', 'admin'] },
  { to: '/quality', label: 'Quality', roles: ['quality', 'hod', 'planner', 'md', 'admin'] },
  { to: '/forecast', label: 'Forecast', roles: ['md', 'planner', 'admin'] },
  { to: '/money', label: 'Money', roles: ['accounts', 'purchase', 'md', 'admin'] },
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
      <div className="border-rule-soft bg-sheet rounded-card shadow-card max-w-lg border p-6">
        <p className="label">Kram</p>
        {state === 'booting' ? (
          <>
            <p className="text-title mt-2 font-semibold tracking-[-0.02em]">
              Starting the database
            </p>
            <p className="text-mid text-small mt-2">
              Postgres is compiling in the browser and the schema is being
              applied. A moment on first load, instant after that.
            </p>
          </>
        ) : (
          <>
            <p className="text-flag text-title mt-2 font-semibold tracking-[-0.02em]">
              The database did not start
            </p>
            <pre className="border-rule-soft bg-paper text-flag rounded-control text-caption mt-3 overflow-x-auto border p-3 font-mono whitespace-pre-wrap">
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
    <div className="border-flag/40 bg-flag-wash border-b">
      <div className="mx-auto flex max-w-[1400px] items-start justify-between gap-4 px-6 py-3">
        <div>
          <p className="text-flag text-small font-semibold">
            That change was not saved
          </p>
          <p className="text-mid text-caption mt-0.5">{message}</p>
        </div>
        <button
          type="button"
          onClick={clearWriteError}
          className="text-faint hover:text-ink min-h-11 px-2 text-title leading-none sm:min-h-0"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}

/**
 * The count that makes the rest of the software something you are told rather
 * than something you consult.
 *
 * Criticals only. A badge that counts everything is a badge that always shows a
 * number, and a number that is always there stops being read — the same reason
 * the Attention screen has no dismiss.
 */
/**
 * The hosted system's version of "Offline draft".
 *
 * The offline build has said what it is on every screen since Phase 1, and the
 * rates carry an ESTIMATED tag, because a figure nobody entered must never look
 * like one somebody did. The hosted system had no equivalent — and it is the one
 * people believe, because it has real accounts and their own SKUs in it.
 *
 * Across the top rather than tucked in a corner: it is answering "should I act
 * on what I am about to read", which is not a footnote.
 */
function ProvisionalBanner() {
  const state = useProvisionalState()
  if (!state.data?.is_provisional) return null

  return (
    <div
      className="border-amber/40 bg-amber-wash border-b"
      data-testid="provisional-banner"
    >
      <div className="mx-auto max-w-[1400px] px-4 py-2.5 sm:px-6">
        <p className="text-amber text-small font-semibold">
          These figures are placeholders, not U&amp;M's
        </p>
        <p className="text-mid text-caption mt-0.5 max-w-[95ch]">
          {state.data.what} Rates and D-minus will be replaced cell by cell when
          PPC's sheet is loaded; the {state.data.provisional_orders} orders
          marked <em className="not-italic">{state.data.order_prefix}</em> are
          removed in one command.
        </p>
      </div>
    </div>
  )
}

function AttentionBadge() {
  const count = useAttentionCount()
  const critical = count.data?.critical ?? 0
  if (!critical) return null

  return (
    <Link
      to="/attention"
      data-testid="attention-badge"
      data-critical={critical}
      className="border-flag/30 bg-flag-wash text-flag text-caption flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 font-semibold hover:brightness-95 sm:min-h-0"
    >
      <span className="bg-flag inline-block h-2 w-2 rounded-full" />
      {critical} {critical === 1 ? 'thing needs' : 'things need'} an answer today
    </Link>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  const access = useAccess()
  const visible = NAV.filter((item) => has(access, ...item.roles))

  return (
    <div className="min-h-full">
      <ProvisionalBanner />
      {/*
        An application bar, not a title block.

        What this replaces: a 42px masthead, a paragraph of description and a
        REF/REVISION/CLIENT stamp table — the conventions of a specification
        document, which cost about a third of the first screenful before any
        work appeared. The identity moved to the printed notes, where it
        belongs; the software gets a wordmark and its navigation.
      */}
      <header className="bg-sheet border-rule border-b">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-4">
            <div className="flex items-baseline gap-2.5">
              <span className="text-title font-bold tracking-[-0.02em]">
                Kram
              </span>
              <span className="text-faint text-caption hidden md:inline">
                production planning &amp; control
              </span>
            </div>

            <div className="flex items-center gap-4">
              <AttentionBadge />
              {!access.isOffline ? (
                <>
                  <span className="text-faint text-caption hidden lg:inline">
                    {access.roles.join(' · ')}
                  </span>
                  <button
                    type="button"
                    onClick={signOut}
                    className="text-mid hover:text-flag text-small min-h-11 font-medium sm:min-h-0"
                  >
                    Sign out
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {/* One line that scrolls sideways on a phone rather than three
              wrapped rows. -mx-4/px-4 lets it bleed to the screen edges so
              there is no cut-off item pretending to be the last one. */}
          <nav className="-mx-4 flex snap-x gap-x-5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:gap-x-6 sm:gap-y-1 sm:overflow-visible sm:px-0">
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `text-small flex shrink-0 snap-start items-center border-b-2 pb-2.5 font-medium min-h-11 sm:min-h-0 ${
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
        </div>
      </header>

      <WriteErrorBanner />

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>

      <footer className="border-rule-soft bg-sheet mt-8 border-t">
        <div className="text-faint text-caption mx-auto flex max-w-[1400px] flex-wrap justify-between gap-4 px-6 py-4">
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
          <Routes>
            {/* Outside the Shell on purpose. A wall display has no masthead, no
                navigation and no reference block — that is four hundred pixels
                of chrome nobody standing ten feet away can read, and a control
                nobody should press. */}
            <Route path="/display" element={<Display />} />
            <Route
              path="*"
              element={
                <Shell>
                        <Routes>
                    <Route path="/" element={<CommandCentre />} />
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/map" element={<FactoryMap />} />
                    <Route path="/heatmap" element={<Heatmap />} />
                    <Route path="/gantt" element={<Gantt />} />
                    <Route path="/orders" element={<OrderBook />} />
                    <Route path="/accept" element={<Acceptance />} />
                    <Route path="/whatif" element={<WhatIf />} />
                    <Route path="/wip" element={<Wip />} />
                    <Route path="/board" element={<DepartmentBoard />} />
                    <Route path="/production" element={<Production />} />
                    <Route path="/manpower" element={<Manpower />} />
                    <Route path="/material" element={<Material />} />
                    <Route path="/quality" element={<Quality />} />
                    <Route path="/forecast" element={<Forecast />} />
                    <Route path="/money" element={<Money />} />
                    <Route path="/attention" element={<Attention />} />
                    <Route path="/capacity" element={<CapacitySheet />} />
                    <Route path="/masters" element={<Masters />} />
                    <Route path="/users" element={<Users />} />
                  </Routes>
                </Shell>
              }
            />
          </Routes>
        </AuthGate>
      </Boot>
    </HashRouter>
  )
}
