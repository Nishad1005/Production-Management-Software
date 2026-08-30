// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'

/**
 * Spec §11 sizes the real workload: "324 orders averaging two shipment lines,
 * across seven departments, three components and up to three shifts gives
 * roughly 40,000 tasks and 300,000–400,000 daily-load rows per run. A set-based
 * Postgres workload measured in seconds."
 *
 * This builds that shape and checks the claim. The assertion is deliberately
 * loose — wall-clock in CI is not a precise instrument — but a regression that
 * turns the engine row-by-row would blow through it by orders of magnitude,
 * which is the failure worth catching.
 */
const FIXTURE = `
  insert into shifts (code, name, start_time, end_time) values
    ('GEN', 'General', '09:00', '18:00'),
    ('A',   'Shift A', '06:00', '14:00'),
    ('B',   'Shift B', '14:00', '22:00');

  insert into departments (code, name, route_position, yield_pct)
  select 'D' || i, 'Department ' || i, i * 10, 98
    from generate_series(1, 7) i;

  insert into department_shifts (department_id, shift_id, sanctioned_headcount)
  select d.id, s.id, 12 from departments d cross join shifts s;

  insert into components (code, name)
  select 'C' || i, 'Component ' || i from generate_series(1, 3) i;

  insert into articles (code, name) values ('ART', 'Scale-test article');

  insert into article_bom (article_id, component_id, qty_per_unit)
  select (select id from articles where code = 'ART'), c.id, 2 from components c;

  -- Every department works every component, on every shift.
  insert into component_rates (component_id, department_id, shift_id, units_per_day)
  select c.id, d.id, s.id, 200
    from components c cross join departments d cross join shifts s;

  -- D-minus 70, 60, ... 10 down the route.
  update article_dept_dminus adm
     set dminus_days = 80 - (d.route_position), is_complete = true
    from departments d
   where adm.department_id = d.id;

  insert into customers (code, name) values ('C1', 'Scale-test customer');

  -- Sized so each task spans roughly eight working days against 600/day of
  -- combined shift capacity. That is what produces the spec's 300–400k
  -- daily-load rows; a token quantity would fit every task into one day and
  -- quietly test a tenth of the workload.
  insert into orders (erp_order_no, customer_id, article_id, total_qty)
  select 'SO-' || i,
         (select id from customers where code = 'C1'),
         (select id from articles where code = 'ART'),
         4000
    from generate_series(1, 324) i;

  -- Two shipment lines each, stuffing dates spread across about six months.
  insert into shipment_lines (order_id, line_no, qty, stuffing_date)
  select o.id, l.line_no, 2000,
         date '2027-01-04' + ((row_number() over (order by o.erp_order_no, l.line_no))::integer % 180)
    from orders o
    cross join (values (1), (2)) as l (line_no);
`

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

      // "Measured in seconds", not minutes.
      expect(stats.duration_ms).toBeLessThan(60_000)
    })
  })
})

/**
 * The shape the live project actually has, which the fixture above does not.
 *
 * Above, every article is ordered and every rate is in the plan, so the
 * capacity grid could be built from the whole masters set and nothing would
 * show. U&M's project holds seventy-one articles and twelve orders: five sixths
 * of the rates belong to articles nobody has ordered. The engine built the grid
 * from all of them, and `resolve_capacity` is a function call per cell.
 *
 * The measurement that prompted this, from the live project: 45 seconds to
 * schedule 24 tasks, and 120 seconds — the ceiling — once the missing
 * departments were staffed.
 */
const SPARSE = `
  insert into shifts (code, name, start_time, end_time)
  values ('GEN', 'General', '09:00', '18:00');

  insert into departments (code, name, route_position, yield_pct)
  select 'D' || i, 'Department ' || i, i * 10, 98 from generate_series(1, 14) i;

  insert into department_shifts (department_id, shift_id, sanctioned_headcount)
  select d.id, s.id, 10 from departments d cross join shifts s;

  -- Seventy-one articles, one component per department each, as the interim
  -- loader builds them.
  insert into articles (code, name)
  select 'ART' || i, 'Article ' || i from generate_series(1, 71) i;

  insert into components (code, name)
  select a.code || '::' || d.code, a.code || ' at ' || d.code
    from articles a cross join departments d;

  insert into article_bom (article_id, component_id, qty_per_unit)
  select a.id, c.id, 1
    from articles a
    join departments d on true
    join components c on c.code = a.code || '::' || d.code;

  insert into component_rates (component_id, department_id, shift_id, units_per_day)
  select c.id, d.id, s.id, 100
    from articles a
    join departments d on true
    join components c on c.code = a.code || '::' || d.code
    cross join shifts s;

  update article_dept_dminus adm
     set dminus_days = 150 - d.route_position, is_complete = true
    from departments d
   where adm.department_id = d.id;

  insert into customers (code, name) values ('C1', 'Sparse-test customer');

  -- Twelve orders, on twelve of the seventy-one articles.
  insert into orders (erp_order_no, customer_id, article_id, total_qty)
  select 'SO-' || i,
         (select id from customers where code = 'C1'),
         (select id from articles where code = 'ART' || i),
         180
    from generate_series(1, 12) i;

  insert into shipment_lines (order_id, line_no, qty, stuffing_date)
  select o.id, 1, 180,
         date '2027-02-01' + ((row_number() over (order by o.erp_order_no))::integer * 7)
    from orders o;
`

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
    // The narrowing must not move a single number on the heatmap. Components
    // with capacity and no load contributed zero to a department's utilisation,
    // so dropping them changes what `schedule_component_load` lists and nothing
    // that `schedule_department_day` reports.
    await withRollback(async (c) => {
      await c.query(SPARSE)
      await c.query(`select run_schedule()`)
      const narrow = await c.query(
        `select department_id, load_date, round(utilisation, 6) as utilisation, status
           from schedule_department_day
          where run_id = current_run_id()
          order by department_id, load_date`,
      )

      // Every rated pairing put back into the grid, as the engine used to do.
      await c.query(
        `insert into schedule_daily_capacity
           (run_id, department_id, shift_id, component_id, load_date, capacity)
         select current_run_id(), cr.department_id, cr.shift_id, cr.component_id,
                w.calendar_date, cr.units_per_day
           from component_rates cr
           join working_days w on w.is_working
          where w.calendar_date between
                  (select min(load_date) from schedule_daily_capacity
                    where run_id = current_run_id())
              and (select max(load_date) from schedule_daily_capacity
                    where run_id = current_run_id())
         on conflict do nothing`,
      )
      // The put-back has to have actually put something back, or the
      // comparison below compares a thing with itself and proves nothing.
      const grew = await c.query<{ before: string; after: string }>(
        `select (select count(distinct component_id) from schedule_daily_capacity
                  where run_id = current_run_id())::text as after,
                $1::text as before`,
        [String(12 * 14)],
      )
      expect(Number(grew.rows[0].after)).toBeGreaterThan(Number(grew.rows[0].before))

      const wide = await c.query(
        `select department_id, load_date, round(utilisation, 6) as utilisation, status
           from schedule_department_day
          where run_id = current_run_id()
          order by department_id, load_date`,
      )

      expect(wide.rows.length).toBeGreaterThan(0)
      expect(narrow.rows).toEqual(wide.rows)
    })
  })
})
