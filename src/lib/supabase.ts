import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * False until .env.local carries a project URL and anon key. The shell boots
 * either way and shows a setup screen, rather than throwing on import and
 * leaving a blank page with a console error.
 */
export const isSupabaseConfigured = Boolean(url && anonKey)

/**
 * The browser client, holding the anon key only.
 *
 * Every table it can reach is protected by row-level security, so this key is
 * safe in the bundle. The service role key bypasses RLS and must never appear
 * anywhere under src/ — privileged work runs in Postgres functions instead.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null

/** Use inside data hooks, where a missing client is a programming error. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Copy .env.example to .env.local and fill it from the project API settings.',
    )
  }
  return supabase
}
