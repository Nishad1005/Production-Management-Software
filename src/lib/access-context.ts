import { createContext, useContext } from 'react'
import { OFFLINE_ACCESS, type Access } from '@/lib/auth'

/**
 * The signed-in user's roles, for deciding what to show.
 *
 * Its own file so App.tsx exports components and nothing else — mixing the two
 * breaks React Fast Refresh. Defaults to full offline access, which is what the
 * browser-only build actually has.
 */
export const AccessContext = createContext<Access>(OFFLINE_ACCESS)

export const useAccess = () => useContext(AccessContext)
