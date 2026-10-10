// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { becomeUser, createUser, withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'
import {
  DENSE_FIXTURE as FIXTURE,
  SPARSE_FIXTURE as SPARSE,
} from './helpers/scale-fixtures'

describe('engine at production scale', () => {
  it('schedules 324 orders across seven departments in seconds', async () => {
    await withRollback(async (c) => {
      await c.query(FIXTURE)

      const wall = Date.now()
      const { rows: run } = await c.query<{ id: string }>(
        `select run_schedule() as id`,
      )
      const wallMs = Date.now() - wall

      const { rows } = await c.query<{
        task_count: number
        breach_count: number
        duration_ms: number
        loads: string
        capacities: string
      }>(
        `select r.task_count, r.breach_count, r.duration_ms,
                (select count(*) from schedule_daily_load where run_id = r.id)::text as loads,
                (select count(*) from schedule_daily_capacity where run_id = r.id)::text as capacities
           from schedule_runs r where r.id = $1`,
        [run[0].id],
      )

      const stats = rows[0]
      // eslint-disable-next-line no-console
      console.log(
        `\n  scale: ${stats.task_count} tasks, ${Number(stats.loads).toLocaleString()} load rows, ` +
          `${Number(stats.capacities).toLocaleString()} capacity rows, ` +
          `engine ${stats.duration_ms}ms, wall ${wallMs}ms\n`,
      )

      // 648 shipment lines × 7 departments × 3 components.
      expect(stats.task_count).toBe(648 * 7 * 3)
      expect(Number(stats.loads)).toBeGreaterThan(100_000)

      // "Measured in seconds", not minutes. 4.6 s on 11 Oct 2026 with the grid
      // built as one statement; 60 s was the bound before that, and the old
      // engine sat at 5.5 s under it as the owner while taking 95 s as a
      // planner — which the next test is for.
      expect(stats.duration_ms).toBeLessThan(15_000)
    })
  })

  it('costs a planner what it costs the owner', async () => {
    /*
     * Every test in this suite runs as the table owner, where row-level
     * security does not apply, and the engine's cost on the live project was
     * almost entirely row-level security: a function call per grid cell, each
     * its own statement, each paying the policy once; then a summary that
     * re-read 300,000 rows through a security_invoker view. The owner saw 5.5
     * seconds on this fixture and a signed-in planner saw 95. No test noticed,
     * because no test had ever run the engine as a planner at scale.
     *
     * The same fixture, as the authenticated role with a planner's claims,
     * exactly as a request through PostgREST arrives. 4.5 s on 11 Oct 2026.
     */
    await withRollback(async (c) => {
      await c.query(FIXTURE)
      const planner = await createUser(c, 'planner@scale.test', ['planner'])
      await becomeUser(c, planner)

      const { rows: run } = await c.query<{ id: string }>(`select run_schedule() as id`)
      const { rows } = await c.query<{ task_count: number; duration_ms: number }>(
        `select task_count, duration_ms from schedule_runs where id = $1`,
        [run[0].id],
      )
      expect(rows[0].task_count).toBe(648 * 7 * 3)
      expect(rows[0].duration_ms).toBeLessThan(20_000)
    })
  })

  it('makes no call per cell or per task', async () => {
    // The static half of the guard above. The four functions below are each
    // a statement of their own when called from the engine, and a statement
    // per cell is what cost a minute a run; the engine has them as joins now.
    // Read from pg_proc, so it is the installed engine and not a file.
    await withRollback(async (c) => {
      const { rows } = await c.query<{ prosrc: string }>(
        `select prosrc from pg_proc where proname = 'run_schedule'`,
      )
      expect(rows).toHaveLength(1)
      const body = rows[0].prosrc.replace(/--[^\n]*/g, '')
      for (const fn of ['resolve_capacity(', 'machine_availability(', 'prev_working_day(', 'next_working_day(', 'working_days_between(']) {
        expect(body, `run_schedule calls ${fn} per row`).not.toContain(fn)
      }
    })
  })
})

describe('a book that touches a fraction of the masters', () => {
  it('builds capacity for the twelve articles ordered, not the seventy-one', async () => {
    await withRollback(async (c) => {
      await c.query(SPARSE)
      const { rows: run } = await c.query<{ id: string }>(`select run_schedule() as id`)

      const { rows } = await c.query<{
        components_rated: string
        components_in_grid: string
        tasks: number
        duration_ms: number
      }>(
        `select (select count(distinct component_id) from component_rates)::text
                  as components_rated,
                (select count(distinct component_id) from schedule_daily_capacity
                  where run_id = $1)::text as components_in_grid,
                r.task_count as tasks, r.duration_ms
           from schedule_runs r where r.id = $1`,
        [run[0].id],
      )

      // 71 × 14 rated, 12 × 14 ordered. The fixture is only meaningful if the
      // two differ by a lot, so assert that before asserting the point.
      expect(Number(rows[0].components_rated)).toBe(71 * 14)
      expect(Number(rows[0].components_in_grid)).toBe(12 * 14)
      expect(rows[0].tasks).toBe(12 * 14)
    })
  })

  it('leaves the department-level figures identical either way', async () => {
    /*
     * The narrowing must not move a single number on the heatmap: a component
     * with capacity and no load contributes zero to its department's
     * utilisation, so dropping it changes what `schedule_component_load` lists
     * and nothing that a department-day figure reports.
     *
     * This compares the **aggregate over `schedule_component_load`**, not
     * `schedule_department_day`. Since 30 Aug that view reads the stored
     * `schedule_daily_department` table, so adding capacity rows would not move
     * it — the first version of this test compared two identical reads of a
     * table nothing had touched and passed for a week without testing anything.
     * The claim lives in the aggregate, so the aggregate is what is compared.
     */
    await withRollback(async (c) => {
      await c.query(SPARSE)
      await c.query(`select run_schedule()`)

      const aggregate = `
        select department_id, load_date,
               round(sum(utilisation), 6) as utilisation,
               count(*) filter (where qty_planned > 0) as loaded
          from schedule_component_load
         where run_id = current_run_id()
         group by department_id, load_date
         order by department_id, load_date`

      const narrow = await c.query(aggregate)

      // The rated pairings the plan does not touch, put back as the engine used
      // to write them — over a bounded window, because all 994 across the whole
      // horizon is 179,000 rows and a minute and a half of test time for a
      // claim fifteen days prove just as well.
      const added = await c.query(
        `insert into schedule_daily_capacity
           (run_id, department_id, shift_id, component_id, load_date, capacity)
         select current_run_id(), cr.department_id, cr.shift_id, cr.component_id,
                d.load_date, cr.units_per_day
           from component_rates cr
           cross join (
             select distinct load_date from schedule_daily_capacity
              where run_id = current_run_id()
              order by load_date
              limit 15
           ) d
          where not exists (
            select 1 from schedule_tasks t
             where t.run_id = current_run_id()
               and t.component_id = cr.component_id
          )
         on conflict do nothing
         returning 1`,
      )
      // The put-back has to have actually put something back, or the comparison
      // below compares a thing with itself and proves nothing.
      expect(added.rowCount).toBeGreaterThan(0)

      const wide = await c.query(aggregate)
      expect(wide.rows.length).toBeGreaterThan(0)
      expect(narrow.rows).toEqual(wide.rows)
    })
  })

  it('stores the department-day figure the aggregate would have computed', async () => {
    // The other half of materialising it: the engine writes this once, and if
    // the written figure ever drifts from the expression it replaced, every
    // heatmap cell, breach count and flagged day is quietly wrong with nothing
    // to compare against.
    //
    // On the four-department seed rather than the sparse fixture above. The
    // claim is that a stored row equals the aggregate it replaced, which is
    // true of any run — and the sparse fixture plans seventy-one articles,
    // which took this test past three minutes and through its timeout on a
    // busy machine. A check nobody can afford to run is not a check.
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 400, stuffingDate: '2026-12-01' })
      await runSchedule(c)

      const { rows } = await c.query<{ mismatched: string; total: string }>(
        `with computed as (
           select department_id, load_date,
                  round(sum(utilisation), 6) as utilisation,
                  case
                    when sum(utilisation) > 1.0001 then 'over'
                    when sum(utilisation) > 0 then 'loaded'
                    else 'idle'
                  end as status
             from schedule_component_load
            where run_id = current_run_id()
            group by department_id, load_date
         )
         select count(*) filter (
                  where s.utilisation is null
                     or round(s.utilisation, 6) <> c.utilisation
                     or s.status <> c.status
                )::text as mismatched,
                count(*)::text as total
           from computed c
           left join schedule_daily_department s
             on s.run_id = current_run_id()
            and s.department_id = c.department_id
            and s.load_date = c.load_date`,
      )
      expect(Number(rows[0].total)).toBeGreaterThan(0)
      expect(Number(rows[0].mismatched)).toBe(0)
    })
  })

})
