import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { getDatabase } from '@/lib/database'
import { CommandCentre } from '@/routes/CommandCentre'
import { Heatmap } from '@/routes/Heatmap'
import { OrderBook } from '@/routes/OrderBook'
import { Acceptance } from '@/routes/Acceptance'
import { Gantt } from '@/routes/Gantt'
import { Masters } from '@/routes/Masters'

const NAV = [
  { to: '/', label: 'Command centre', end: true },
  { to: '/heatmap', label: 'Load heatmap' },
  { to: '/gantt', label: 'Schedule' },
  { to: '/orders', label: 'Order book' },
  { to: '/accept', label: 'Accept an order' },
  { to: '/masters', label: 'Masters' },
]

/**
 * Postgres has to compile and the schema has to apply before anything can
 * render. It takes a second or two on first load and is instant thereafter,
 * so the wait is explained rather than hidden behind a spinner.
 */
function Boot({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'booting' | 'ready' | 'failed'>('booting')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    getDatabase()
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

function Shell({ children }: { children: React.ReactNode }) {
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
            <div className="border-ink min-w-[220px] border-[1.5px]">
              {[
                ['Ref', 'DBBS/UM/KRAM/01'],
                ['Revision', 'B'],
                ['Client', 'U&M Designs'],
                ['Build', 'Offline draft'],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="border-rule grid grid-cols-[80px_1fr] border-b last:border-b-0"
                >
                  <span className="text-faint border-rule border-r px-2.5 py-1.5 text-[10.5px] tracking-[0.08em] uppercase">
                    {k}
                  </span>
                  <span className="px-2.5 py-1.5 text-[11px] font-medium">
                    {v}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <nav className="mt-6 flex flex-wrap gap-x-6 gap-y-1">
            {NAV.map((item) => (
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
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>

      <footer className="border-ink bg-sheet mt-6 border-t-2">
        <div className="text-faint mx-auto flex max-w-[1400px] flex-wrap justify-between gap-4 px-6 py-5 text-[11px] tracking-[0.06em]">
          <span>Kram — offline draft. Postgres runs in the browser.</span>
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
        <Shell>
          <Routes>
            <Route path="/" element={<CommandCentre />} />
            <Route path="/heatmap" element={<Heatmap />} />
            <Route path="/gantt" element={<Gantt />} />
            <Route path="/orders" element={<OrderBook />} />
            <Route path="/accept" element={<Acceptance />} />
            <Route path="/masters" element={<Masters />} />
          </Routes>
        </Shell>
      </Boot>
    </HashRouter>
  )
}
