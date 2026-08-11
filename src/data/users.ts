import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, rpcRows } from '@/lib/backend'
import type { Role } from '@/lib/auth'

export type UserRow = {
  user_id: string
  email: string
  full_name: string
  is_active: boolean
  department_code: string | null
  roles: Role[]
  created_at: string
}

/** Admin only — the function refuses anyone else, and it reads auth.users. */
export function useUsers(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['users'],
    queryFn: () => rpcRows<UserRow>('list_users'),
  })
}

function useUserWrite<TInput>(fn: (input: TInput) => Promise<void>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    // Roles decide what the signed-in user can see, so a change to their own
    // has to refresh more than the list.
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useGrantRole() {
  return useUserWrite<{ userId: string; role: Role }>(async ({ userId, role }) => {
    await rpc('grant_role', { p_user_id: userId, p_role: role })
  })
}

export function useRevokeRole() {
  return useUserWrite<{ userId: string; role: Role }>(async ({ userId, role }) => {
    await rpc('revoke_role', { p_user_id: userId, p_role: role })
  })
}

export function useSetUserProfile() {
  return useUserWrite<{
    userId: string
    fullName?: string
    departmentCode?: string | null
    isActive?: boolean
  }>(async ({ userId, fullName, departmentCode, isActive }) => {
    await rpc('set_user_profile', {
      p_user_id: userId,
      p_full_name: fullName ?? null,
      p_department_code: departmentCode ?? null,
      p_is_active: isActive ?? null,
    })
  })
}

/** Spec §16, in the order the specification lists them. */
export const ALL_ROLES: { role: Role; label: string; can: string }[] = [
  { role: 'md', label: 'MD / Leadership', can: 'Read everything, no edit' },
  { role: 'planner', label: 'PPC / Planner', can: 'Orders, masters, schedule, what-if, pins' },
  { role: 'merchandiser', label: 'Merchandiser', can: 'Orders, date commitment, order acceptance' },
  { role: 'hod', label: 'HOD', can: 'WIP entry for their own department only' },
  { role: 'hr', label: 'HR', can: 'Employees, attendance, leave, overtime' },
  { role: 'purchase', label: 'Purchase', can: 'Purchase orders, suppliers, payment schedule' },
  { role: 'store', label: 'Store', can: 'GRN, material issue, stock' },
  { role: 'quality', label: 'Quality', can: 'Inspections, NCR, CAPA, calibration, audit' },
  { role: 'maintenance', label: 'Maintenance', can: 'Machines, breakdowns, maintenance' },
  { role: 'accounts', label: 'Accounts', can: 'Rates, costing, cash flow' },
  { role: 'admin', label: 'Admin', can: 'Departments, shifts, mappings, users' },
  { role: 'kiosk', label: 'Kiosk', can: 'Read-only department display' },
]
