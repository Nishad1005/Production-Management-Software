// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient } from './helpers/db'

/**
 * No access rule may ask who the caller is once per row.
 *
 * A policy written `using (auth_has_a_role())` is evaluated for every row a
 * scan considers. Each evaluation queries `user_roles`, and on Supabase
 * `auth.uid()` parses the request's JWT claims each time. That was about half a
 * millisecond a row on the hosted project — a second for a thousand-row view,
 * seventy seconds for a schedule run — and it went unseen for two months
 * because every test here runs as the table owner, where no policy is
 * evaluated at all.
 *
 * `using ((select auth_has_a_role()))` is the same rule evaluated once, as an
 * InitPlan. Migration 20261003110000 rewrote every policy that way. This reads
 * the catalogue and fails on any that is not, so a table added next month
 * cannot bring the tax back without someone seeing this test go red.
 *
 * It is a rule about the shape of the policy text, which is normally a brittle
 * thing to assert. It is asserted here because no behavioural test can see the
 * difference: the two forms grant exactly the same access.
 */

/** A call wrapped as Postgres deparses it: `( SELECT auth_x() AS auth_x)`. */
const WRAPPED = [
  /\(\s*select\s+(?:public\.)?auth_[a-z_]+\([^()]*\)(?:\s+as\s+\w+)?\s*\)/gi,
  /\(\s*select\s+auth\.uid\(\)(?:\s+as\s+\w+)?\s*\)/gi,
]
/** Any call to one of the identity functions at all. */
const CALL = /(?:auth_[a-z_]+\(|auth\.uid\()/i

function bare(expression: string | null): boolean {
  if (!expression) return false
  let rest = expression
  for (const w of WRAPPED) rest = rest.replace(w, '')
  return CALL.test(rest)
}

describe('row-level security is paid once per statement', () => {
  it('wraps every identity call in every policy', async () => {
    const { rows } = await withClient((c) =>
      c.query<{
        tablename: string
        policyname: string
        qual: string | null
        with_check: string | null
      }>(
        `select tablename, policyname, qual, with_check
           from pg_policies where schemaname = 'public'
          order by tablename, policyname`,
      ),
    )

    // The schema has policies on every table; if this is small the query has
    // stopped finding them and the assertion below would pass on nothing.
    expect(rows.length).toBeGreaterThan(40)

    const offenders = rows
      .filter((r) => bare(r.qual) || bare(r.with_check))
      .map((r) => `${r.tablename}.${r.policyname}`)
    expect(offenders, 'these evaluate an identity function for every row').toEqual([])
  })

  it('would notice a policy written the old way', () => {
    // The check itself, shown to be capable of failing — both on the form the
    // schema used to have and on a mixed one where only half is wrapped.
    expect(bare('auth_has_a_role()')).toBe(true)
    expect(bare('(auth_can_plan() OR auth_has_a_role())')).toBe(true)
    expect(bare('(user_id = auth.uid())')).toBe(true)
    expect(
      bare('(( SELECT auth_can_plan() AS auth_can_plan) OR auth_has_a_role())'),
    ).toBe(true)

    expect(bare('( SELECT auth_has_a_role() AS auth_has_a_role)')).toBe(false)
    expect(
      bare(
        "(( SELECT auth_has_role('hod'::app_role) AS auth_has_role) AND (department_id = ( SELECT auth_department_id() AS auth_department_id)))",
      ),
    ).toBe(false)
    expect(bare('(id = ( SELECT auth.uid() AS uid))')).toBe(false)
    expect(bare(null)).toBe(false)
  })
})
