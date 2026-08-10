import { isSupabaseConfigured } from '@/lib/supabase'

export function App() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-16 font-mono">
      <p className="text-blue text-xs tracking-[0.18em] uppercase">
        Data Brilliance Business Solutions LLP
      </p>
      <h1 className="font-sans mt-3 text-5xl font-extrabold tracking-tight">
        Kram
      </h1>
      <p className="text-mid mt-4 max-w-prose text-sm">
        Production planning &amp; control for U&amp;M Designs. Backward
        scheduling from the container stuffing date, component-level load
        against capacity, and the days a department is asked for more than it
        can make.
      </p>

      <div className="border-rule bg-sheet mt-10 border p-5 text-sm">
        <p className="text-faint text-[11px] tracking-[0.1em] uppercase">
          Backend
        </p>
        <p className="mt-2">
          {isSupabaseConfigured ? (
            <span className="text-clear">Supabase configured.</span>
          ) : (
            <span className="text-flag">
              Not configured — copy <code>.env.example</code> to{' '}
              <code>.env.local</code> and fill it from the Supabase project API
              settings.
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
