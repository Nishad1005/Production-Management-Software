import { useDepartments } from '@/data/planning'
import {
  ALL_ROLES,
  useGrantRole,
  useRevokeRole,
  useSetUserProfile,
  useUsers,
} from '@/data/users'
import type { Role } from '@/lib/auth'
import { backend } from '@/lib/backend'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { inputClass } from '@/components/format'
import { EditableText } from '@/components/edit'

/**
 * Spec §16: twelve roles, enforced at the database. This screen assigns them.
 *
 * It does not create accounts. Creating a user needs the service role key,
 * which bypasses row-level security entirely and must never reach a browser —
 * so accounts are made in the Supabase dashboard, and what actually decides
 * what anyone can see is set here.
 */
export function Users() {
  const hosted = backend.kind === 'hosted'
  const users = useUsers(hosted)
  const departments = useDepartments()
  const grant = useGrantRole()
  const revoke = useRevokeRole()
  const setProfile = useSetUserProfile()

  if (!hosted) {
    return (
      <Panel title="Users" meta="Hosted system only">
        <p className="text-mid max-w-[70ch] text-caption">
          This build runs a database inside your browser, with no accounts in
          it — there is nobody to administer. Roles and permissions apply to the
          hosted system.
        </p>
      </Panel>
    )
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Users and roles"
        meta={`${users.data?.length ?? 0} accounts`}
      >
        <p className="text-mid mb-4 max-w-[85ch] text-caption">
          Roles decide what each person can reach, and they are enforced in the
          database on every request — not in this screen. A new account has no
          roles and can see nothing until given some.
        </p>

        {users.isError ? (
          <p className="border-flag text-flag border-l-[3px] py-1 pl-3 text-caption">
            {String(users.error).includes('administrator')
              ? 'Only an administrator can see the user list.'
              : String(users.error)}
          </p>
        ) : null}

        {users.data?.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Department</Th>
                <Th>Roles</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.user_id} className={u.is_active ? '' : 'text-faint'}>
                  <Td className="font-semibold">{u.email}</Td>
                  <Td>
                    <EditableText
                      value={u.full_name || '—'}
                      onCommit={(fullName) =>
                        setProfile.mutate({ userId: u.user_id, fullName })
                      }
                    />
                  </Td>
                  <Td>
                    <select
                      className={`${inputClass} w-40 py-1`}
                      value={u.department_code ?? ''}
                      onChange={(e) =>
                        setProfile.mutate({
                          userId: u.user_id,
                          departmentCode: e.target.value || null,
                        })
                      }
                    >
                      <option value="">—</option>
                      {departments.data?.map((d) => (
                        <option key={d.id} value={d.code}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <div className="flex max-w-[520px] flex-wrap gap-1">
                      {ALL_ROLES.map(({ role, label, can }) => {
                        const held = u.roles.includes(role)
                        return (
                          <button
                            key={role}
                            type="button"
                            title={`${label} — ${can}`}
                            onClick={() =>
                              held
                                ? revoke.mutate({ userId: u.user_id, role })
                                : grant.mutate({ userId: u.user_id, role })
                            }
                            className={`rounded-[2px] border px-1.5 py-px text-caption tracking-[0.05em] uppercase ${
                              held
                                ? 'border-clear text-clear font-semibold'
                                : 'border-rule-soft text-faint hover:border-blue hover:text-blue'
                            }`}
                          >
                            {role}
                          </button>
                        )
                      })}
                    </div>
                  </Td>
                  <Td align="right">
                    <button
                      type="button"
                      className="text-faint hover:text-flag text-caption"
                      onClick={() =>
                        setProfile.mutate({
                          userId: u.user_id,
                          isActive: !u.is_active,
                        })
                      }
                    >
                      {u.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : users.isSuccess ? (
          <Empty>No accounts yet.</Empty>
        ) : null}

        <div className="border-rule-soft mt-5 border-t pt-4">
          <p className="label mb-2">Adding someone</p>
          <p className="text-mid max-w-[80ch] text-caption">
            In the Supabase dashboard: <strong>Authentication → Users → Add
            user</strong>, with an email and password, and{' '}
            <em>Auto Confirm User</em> ticked. They appear here on the next
            refresh, with no roles, and can see nothing until you grant some.
          </p>
          <p className="text-faint mt-2 max-w-[80ch] text-caption">
            Account creation needs a key that bypasses every access rule in the
            system, so it is deliberately not done from this screen. Assigning
            roles — which is what actually decides what people see — is.
          </p>
        </div>
      </Panel>

      <Panel title="What each role can do" meta="Specification §16">
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Can do</Th>
            </tr>
          </thead>
          <tbody>
            {ALL_ROLES.map(({ role, label, can }) => (
              <tr key={role}>
                <Td>
                  <Tag tone="blue">{role}</Tag>
                  <span className="ml-2 font-semibold">{label}</span>
                </Td>
                <Td className="text-mid">{can}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-faint mt-3 max-w-[80ch] text-caption">
          Phases 0–2 exercise admin, planner, merchandiser and MD. The rest are
          declared and enforced, and become meaningful as their modules arrive —
          HOD with WIP tracking, HR with manpower, and so on.
        </p>
      </Panel>
    </div>
  )
}

export type { Role }
