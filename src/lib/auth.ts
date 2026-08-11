import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { backend, select, supabaseClient } from '@/lib/backend'

/**
 * Signing in, and knowing what you are allowed to do.
 *
 * Only the hosted backend has accounts. The offline build is a single-user
 * demonstration running as the database owner, so it reports full access and no
 * session — pretending otherwise would put a login screen in front of a
 * database that has no users in it.
 *
 * Nothing here is a security boundary. Roles are read to decide what to *show*;
 * what anyone can actually read or write is decided by row-level security, in
 * the database, on every request.
 */

export type Role =
  | 'md'
  | 'planner'
  | 'merchandiser'
  | 'hod'
  | 'hr'
  | 'purchase'
  | 'store'
  | 'quality'
  | 'maintenance'
  | 'accounts'
  | 'admin'
  | 'kiosk'

export type Access = {
  userId: string | null
  email: string | null
  fullName: string
  departmentCode: string | null
  roles: Role[]
  isOffline: boolean
}

export const OFFLINE_ACCESS: Access = {
  userId: null,
  email: null,
  fullName: 'Offline demonstration',
  departmentCode: null,
  // The offline build runs as the owner, so every screen is reachable. Listing
  // the roles keeps the UI code identical between the two.
  roles: ['admin', 'planner', 'merchandiser', 'md'],
  isOffline: true,
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [checked, setChecked] = useState(!supabaseClient)

  useEffect(() => {
    if (!supabaseClient) return

    supabaseClient.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecked(true)
    })

    const { data: sub } = supabaseClient.auth.onAuthStateChange((_e, next) => {
      setSession(next)
      setChecked(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return { session, checked, isHosted: Boolean(supabaseClient) }
}

type AccessRow = {
  user_id: string
  full_name: string
  department_code: string | null
  roles: string[]
}

/** Reads the caller's own profile and roles. */
export async function fetchAccess(session: Session | null): Promise<Access> {
  if (backend.kind === 'offline') return OFFLINE_ACCESS

  const rows = await select<AccessRow>('my_access')
  const row = rows[0]

  return {
    userId: session?.user.id ?? null,
    email: session?.user.email ?? null,
    fullName: row?.full_name || (session?.user.email ?? ''),
    departmentCode: row?.department_code ?? null,
    roles: (row?.roles ?? []) as Role[],
    isOffline: false,
  }
}

export async function signIn(email: string, password: string) {
  if (!supabaseClient) throw new Error('No hosted backend configured')
  const { error } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  })
  if (error) throw new Error(friendlyAuthError(error.message))
}

export async function signOut() {
  await supabaseClient?.auth.signOut()
}

/**
 * Supabase's messages are accurate and unhelpful. A shop floor does not need
 * to know the difference between a wrong password and an unknown address —
 * and telling them would confirm which addresses exist.
 */
function friendlyAuthError(message: string) {
  if (/invalid login credentials/i.test(message)) {
    return 'That email address and password do not match.'
  }
  if (/email not confirmed/i.test(message)) {
    return 'This account has not been confirmed yet. An administrator can confirm it in the Supabase dashboard.'
  }
  return message
}

export function has(access: Access | undefined, ...roles: Role[]) {
  if (!access) return false
  return roles.some((role) => access.roles.includes(role))
}
