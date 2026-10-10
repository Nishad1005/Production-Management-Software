/**
 * The shapes the engine is measured against. Shared between the scale test
 * and `scripts/bench-engine.mjs`, so the figures in the log were taken on the
 * same fixtures the suite guards.
 */

/**
 * Spec §11 sizes the real workload: "324 orders averaging two shipment lines,
 * across seven departments, three components and up to three shifts gives
 * roughly 40,000 tasks and 300,000–400,000 daily-load rows per run. A set-based
 * Postgres workload measured in seconds."
 *
 * This builds that shape. Every article is ordered and every rate is in the
 * plan, which is the dense case.
 */
export const DENSE_FIXTURE = `
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

/**
 * The shape the live project actually has, which the fixture above does not.
 *
 * Above, every article is ordered and every rate is in the plan, so the
 * capacity grid could be built from the whole masters set and nothing would
 * show. U&M's project holds seventy-one articles and twelve orders: five sixths
 * of the rates belong to articles nobody has ordered. The engine built the grid
 * from all of them, and `resolve_capacity` was a function call per cell.
 *
 * The measurement that prompted this, from the live project: 45 seconds to
 * schedule 24 tasks, and 120 seconds — the ceiling — once the missing
 * departments were staffed.
 */
export const SPARSE_FIXTURE = `
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

/**
 * U&M's real shape, with the real order book on it.
 *
 * Twenty departments, two shifts both working everywhere, seventy-one articles
 * each routed through the first fourteen departments (the six checkpoints
 * carry no rate, as on the live project before PPC's figures) — 994 rated
 * pairings, the live figure — and 324 orders of two lines each across six
 * months, which is spec §11's order book. `componentsPerCell` is how many
 * components an article has in a department: one is the interim loader's
 * shape, four is closer to a real bill of materials and puts the task count
 * near the spec's forty thousand.
 */
export function umFixture({ componentsPerCell = 1 }: { componentsPerCell?: number } = {}): string {
  return `
  insert into shifts (code, name, start_time, end_time) values
    ('GEN', 'General', '09:00', '18:00'),
    ('A',   'Shift A', '06:00', '14:00');

  insert into departments (code, name, route_position, yield_pct)
  select 'D' || i, 'Department ' || i, i * 10, 98 from generate_series(1, 20) i;

  insert into department_shifts (department_id, shift_id, sanctioned_headcount)
  select d.id, s.id, 10 from departments d cross join shifts s;

  insert into articles (code, name)
  select 'ART' || i, 'Article ' || i from generate_series(1, 71) i;

  insert into components (code, name)
  select a.code || '::' || d.code || '/' || k, a.code || ' at ' || d.code || ' part ' || k
    from articles a
    cross join departments d
    cross join generate_series(1, ${componentsPerCell}) k
   where d.route_position <= 140;

  insert into article_bom (article_id, component_id, qty_per_unit)
  select a.id, c.id, 1
    from articles a
    join components c on c.code like a.code || '::%';

  insert into component_rates (component_id, department_id, shift_id, units_per_day)
  select c.id, d.id, s.id, 100
    from components c
    join departments d on c.code like '%::' || d.code || '/%'
    cross join shifts s;

  -- The six checkpoints have no rate, so no task; they still need a legal
  -- offset, because the matrix holds a row for every pairing.
  update article_dept_dminus adm
     set dminus_days = case when d.route_position <= 140 then 150 - d.route_position else 5 end,
         is_complete = true
    from departments d
   where adm.department_id = d.id;

  insert into customers (code, name) values ('C1', 'U&M-shaped customer');

  -- 324 orders over the seventy-one articles, two lines of 500 each; against
  -- 200 a day across the two shifts that is two and a half days a task.
  insert into orders (erp_order_no, customer_id, article_id, total_qty)
  select 'SO-' || i,
         (select id from customers where code = 'C1'),
         (select id from articles where code = 'ART' || (1 + (i % 71))),
         1000
    from generate_series(1, 324) i;

  insert into shipment_lines (order_id, line_no, qty, stuffing_date)
  select o.id, l.line_no, 500,
         date '2027-02-01' + ((row_number() over (order by o.erp_order_no, l.line_no))::integer % 180)
    from orders o
    cross join (values (1), (2)) as l (line_no);
`
}
