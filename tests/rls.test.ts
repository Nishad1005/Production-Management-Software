// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  attempt,
  becomeAnon,
  becomeUser,
  createUser,
  withRollback,
} from './helpers/db'
import { applySeed, createOrder } from './helpers/fixtures'

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


describe('anonymous callers', () => {
  /**
   * The anon key ships in the browser bundle, so anyone who loads the page can
   * make requests with it. Postgres grants EXECUTE on new functions to PUBLIC,
   * which made the whole API callable by strangers — RLS still protected the
   * data, but run_schedule does real work before RLS has anything to say.
   * Found against the live project, not by a test, which is why there is now
   * a test.
   */
  it('cannot execute any function', async () => {
    await withRollback(async (c) => {
      await becomeAnon(c)
      for (const call of [
        `select run_schedule()`,
        `select set_dminus('A', 'B', 1)`,
        `select check_order_acceptance(gen_random_uuid(), 10, current_date)`,
        `select run_what_if('probe')`,
        `select promote_schedule_run(gen_random_uuid())`,
      ]) {
        expect(await attempt(c, call), call).toMatch(/permission denied/)
      }
    })
  })

  it('cannot read any table or view', async () => {
    await withRollback(async (c) => {
      await c.query(
        `insert into departments (code, name, route_position) values ('WOOD', 'Wood', 10)`,
      )
      await becomeAnon(c)

      for (const relation of [
        'departments',
        'department_master',
        'order_book',
        'schedule_gantt',
        'run_history',
      ]) {
        expect(
          await attempt(c, `select * from ${relation}`),
          relation,
        ).toMatch(/permission denied/)
      }
    })
  })
})

describe('a signed-in account with no roles', () => {
  /**
   * Every read policy used to be `to authenticated using (true)`, so any
   * account could read the factory's capacities, lead times, product structure
   * and — had there been any — the whole order book. The application refused
   * such an account and showed it a "no roles yet" screen, which is a screen,
   * not a boundary. Found against the live project by signing in and reading.
   */
  it('can read nothing at all', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const user = await createUser(c, 'roleless@example.com', [])
      await becomeUser(c, user)

      for (const relation of [
        'departments',
        'component_rates',
        'article_dept_dminus',
        'article_bom',
        'orders',
        'customers',
        'shipment_lines',
        'schedule_runs',
      ]) {
        const { rows } = await c.query(`select * from ${relation}`)
        expect(rows, `${relation} is readable without a role`).toEqual([])
      }
    })
  })

  it('can still read its own profile, so it can be told why', async () => {
    await withRollback(async (c) => {
      const user = await createUser(c, 'roleless2@example.com', [])
      await becomeUser(c, user)

      const { rows } = await c.query(`select * from my_access`)
      expect(rows).toHaveLength(1)
      expect(rows[0].roles).toEqual([])
    })
  })

  it('can read again the moment a role is granted', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const user = await createUser(c, 'becomes-hod@example.com', ['hod'])
      await becomeUser(c, user)

      const { rows } = await c.query(`select code from departments`)
      expect(rows.length).toBeGreaterThan(0)
    })
  })
})

/**
 * The engine, run by a person rather than by the owner of the tables.
 *
 * Every other test in this repository calls `run_schedule` as the role that
 * owns the schedule tables, and **a table owner bypasses row-level security**.
 * So 333 green tests said nothing about whether a planner signed into the
 * hosted system could actually run a plan — and on 31 Aug one could not:
 * `schedule_daily_department` had been created with a SELECT policy and no
 * write policy, and the button returned
 *
 *   run_schedule: new row violates row-level security policy
 *
 * This is deliberately a test of the whole engine rather than of one table's
 * policy. A policy test has to be remembered for each new table; this one fails
 * on its own the next time the engine is given somewhere to write and nobody is
 * allowed to write there.
 */
describe('a planner can actually run the plan', () => {
  it('writes every table the engine writes, under row-level security', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      const planner = await createUser(c, 'planner@rls.test', ['planner'])

      await becomeUser(c, planner)
      const { rows } = await c.query<{ id: string }>(
        `select run_schedule(array['confirmed','probable']::order_confidence[],
                             true, 'as a planner') as id`,
      )
      const runId = rows[0].id
      expect(runId).toBeTruthy()

      // Every table the run should have filled. Reading them back as the same
      // user, so a missing SELECT policy fails here too.
      const counts = await c.query<{ tasks: string; load: string; cap: string; dept: string }>(
        `select (select count(*) from schedule_tasks where run_id = $1)::text as tasks,
                (select count(*) from schedule_daily_load where run_id = $1)::text as load,
                (select count(*) from schedule_daily_capacity where run_id = $1)::text as cap,
                (select count(*) from schedule_daily_department where run_id = $1)::text as dept`,
        [runId],
      )
      const got = counts.rows[0]
      expect({
        tasks: Number(got.tasks) > 0,
        load: Number(got.load) > 0,
        capacity: Number(got.cap) > 0,
        departmentDay: Number(got.dept) > 0,
      }).toEqual({ tasks: true, load: true, capacity: true, departmentDay: true })
    })
  })

  it('refuses somebody without the planner role', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 300, stuffingDate: '2026-12-01' })
      const storeman = await createUser(c, 'store@rls.test', ['store'])

      await becomeUser(c, storeman)
      const failure = await attempt(
        c,
        `select run_schedule(array['confirmed']::order_confidence[], true, 'not a planner')`,
      )
      // Proves the test above is testing the policy and not merely that the
      // engine runs: if planning were open to anyone, this would return null.
      expect(failure).toBeTruthy()
    })
  })
})
