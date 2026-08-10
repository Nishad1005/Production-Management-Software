// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { becomeUser, createUser, withRollback } from './helpers/db'

// Spec §16: access is enforced at the database, "regardless of how the request
// is made". These tests run as the `authenticated` API role, because a policy
// test run as the owning superuser passes whatever the policy says.

describe('masters access', () => {
  it('lets any signed-in user read the route', async () => {
    await withRollback(async (c) => {
      await c.query(
        `insert into departments (code, name, route_position) values ('WOOD', 'Wood', 10)`,
      )
      const user = await createUser(c, 'hod@example.com', ['hod'])
      await becomeUser(c, user)

      const { rows } = await c.query(`select code from departments`)
      expect(rows).toHaveLength(1)
    })
  })

  it('refuses master writes from a role without planning rights', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'store@example.com', ['store'])
      await becomeUser(c, user)

      await expect(
        c.query(
          `insert into departments (code, name, route_position) values ('X', 'X', 99)`,
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('allows master writes from a planner', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'ppc@example.com', ['planner'])
      await becomeUser(c, user)

      await c.query(
        `insert into departments (code, name, route_position) values ('STITCH', 'Stitching', 30)`,
      )
      const { rows } = await c.query(`select code from departments`)
      expect(rows.map((r) => r.code)).toEqual(['STITCH'])
    })
  })

  it('records created_by as the acting user', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'ppc2@example.com', ['planner'])
      await becomeUser(c, user)

      await c.query(
        `insert into components (code, name) values ('LEG', 'Leg')`,
      )
      const { rows } = await c.query<{ created_by: string }>(
        `select created_by from components where code = 'LEG'`,
      )
      expect(rows[0].created_by).toBe(user)
    })
  })
})

describe('role escalation', () => {
  it('stops a user granting themselves admin', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'ambitious@example.com', ['hod'])
      await becomeUser(c, user)

      await expect(
        c.query(
          `insert into user_roles (user_id, role) values ($1, 'admin')`,
          [user],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('hides other people’s role grants', async () => {
    await withRollback(async (c) => {
      const mine = await createUser(c, 'a@example.com', ['hod'])
      await createUser(c, 'b@example.com', ['planner'])
      await becomeUser(c, mine)

      const { rows } = await c.query<{ user_id: string }>(
        `select user_id from user_roles`,
      )
      expect(rows.map((r) => r.user_id)).toEqual([mine])
    })
  })
})

describe('derived calendar', () => {
  it('is readable but not writable, even by a planner', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'ppc3@example.com', ['planner'])
      await becomeUser(c, user)

      const { rows } = await c.query(
        `select calendar_date from working_days limit 1`,
      )
      expect(rows).toHaveLength(1)

      await expect(
        c.query(
          `update working_days set is_working = true where calendar_date = '2026-09-13'`,
        ),
      ).rejects.toThrow(/row-level security|permission denied/)
    })
  })
})

describe('employees', () => {
  it('are written by HR, not by planners', async () => {
    await withRollback(async (c) => {
      const planner = await createUser(c, 'ppc4@example.com', ['planner'])
      await becomeUser(c, planner)
      await expect(
        c.query(`insert into employees (emp_code, name) values ('E1', 'A')`),
      ).rejects.toThrow(/row-level security/)
    })

    await withRollback(async (c) => {
      const hr = await createUser(c, 'hr@example.com', ['hr'])
      await becomeUser(c, hr)
      await c.query(`insert into employees (emp_code, name) values ('E1', 'A')`)
      const { rows } = await c.query(`select emp_code from employees`)
      expect(rows).toHaveLength(1)
    })
  })
})
