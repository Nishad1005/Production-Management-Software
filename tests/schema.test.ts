// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient, withRollback } from './helpers/db'

describe('migrations', () => {
  it('create every Phase 0 table', async () => {
    const expected = [
      // Phase 0 — masters
      'article_bom',
      // Phase 8 — money
      'article_costs',
      'article_dept_dminus',
      'article_materials',
      'articles',
      'capacity_overrides',
      'component_rates',
      'components',
      // Phase 8 — money
      'cost_lines',
      'customers',
      // Phase 6 — quality
      'defect_types',
      'department_attendance',
      'department_dependencies',
      'department_shifts',
      'departments',
      // Phase 4 — who was actually there
      'employee_attendance',
      'employees',
      'holidays',
      'kpi_targets',
      // Phase 7 — machines
      'machine_downtime',
      'machines',
      // Phase 5 — material
      'material_stock',
      'materials',
      // Phase 1 — order book
      'orders',
      // Phase 3 — WIP ledger. Sorts above 'profiles': produ… before profi…
      'production_acceptances',
      'production_declarations',
      'production_defects',
      'profiles',
      // Interim data, and the banner that says so
      'provisional_load',
      // Phase 2 — schedule output
      'schedule_daily_capacity',
      'schedule_daily_load',
      'schedule_pins',
      'schedule_runs',
      'schedule_tasks',
      'shifts',
      'shipment_lines',
      'suppliers',
      'user_roles',
      'working_days',
    ]

    const { rows } = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
          order by table_name`,
      ),
    )

    expect(rows.map((r) => r.table_name)).toEqual(expected)
  })

  it('enable row-level security on every table', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ relname: string }>(
        `select relname from pg_class
          where relnamespace = 'public'::regnamespace
            and relkind = 'r' and not relrowsecurity`,
      ),
    )
    expect(rows.map((r) => r.relname)).toEqual([])
  })

  it('attach the updated_at trigger to every table that has the column', async () => {
    // Stated as an invariant rather than a count: a column without its trigger
    // is a table whose updated_at quietly lies, and that should fail the moment
    // it appears rather than the next time somebody remembers to bump a number.
    const { rows } = await withClient((c) =>
      c.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_attribute a
             on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
          where c.relnamespace = 'public'::regnamespace
            and c.relkind = 'r'
            and not exists (
              select 1 from pg_trigger t
               where t.tgrelid = c.oid
                 and t.tgname like 'set_updated_at%'
                 and not t.tgisinternal
            )
          order by c.relname`,
      ),
    )
    expect(rows.map((r) => r.relname)).toEqual([])
  })
})

describe('D-minus matrix', () => {
  it('seeds a blank incomplete row when a department is added', async () => {
    await withRollback(async (c) => {
      await c.query(
        `insert into articles (code, name) values ('ART-A', 'Aara Lounge Chair')`,
      )
      await c.query(
        `insert into departments (code, name, route_position) values ('WOOD', 'Wood', 10)`,
      )

      const { rows } = await c.query<{
        dminus_days: number | null
        is_complete: boolean
      }>(
        `select dminus_days, is_complete from article_dept_dminus
           join articles a on a.id = article_id
          where a.code = 'ART-A'`,
      )

      expect(rows).toHaveLength(1)
      expect(rows[0].dminus_days).toBeNull()
      expect(rows[0].is_complete).toBe(false)
    })
  })

  it('refuses to mark a row complete while the value is missing', async () => {
    await withRollback(async (c) => {
      await c.query(
        `insert into articles (code, name) values ('ART-B', 'Test Article')`,
      )
      await c.query(
        `insert into departments (code, name, route_position) values ('SAND', 'Sanding', 20)`,
      )

      await expect(
        c.query(`update article_dept_dminus set is_complete = true`),
      ).rejects.toThrow(/article_dept_dminus_complete_has_value/)
    })
  })
})

describe('capacity overrides', () => {
  const setup = `
    insert into departments (code, name, route_position) values ('WOOD', 'Wood', 10);
    insert into shifts (code, name, start_time, end_time) values ('A', 'Shift A', '06:00', '14:00');
    insert into components (code, name) values ('LEG', 'Leg');
  `

  it('reject two overlapping overrides at the same specificity', async () => {
    await withRollback(async (c) => {
      await c.query(setup)
      const ids = `
        (select id from departments where code = 'WOOD'),
        (select id from shifts where code = 'A')
      `

      await c.query(
        `insert into capacity_overrides (department_id, shift_id, from_date, to_date, units_per_day, reason)
         values (${ids}, '2026-09-01', '2026-09-10', 0, 'Annual maintenance shutdown')`,
      )

      await expect(
        c.query(
          `insert into capacity_overrides (department_id, shift_id, from_date, to_date, units_per_day, reason)
           values (${ids}, '2026-09-05', '2026-09-15', 20, 'Partial running')`,
        ),
      ).rejects.toThrow(/capacity_overrides_no_overlap/)
    })
  })

  it('allow a component override to overlap a department-wide one', async () => {
    await withRollback(async (c) => {
      await c.query(setup)
      const ids = `
        (select id from departments where code = 'WOOD'),
        (select id from shifts where code = 'A')
      `

      await c.query(
        `insert into capacity_overrides (department_id, shift_id, from_date, to_date, units_per_day, reason)
         values (${ids}, '2026-09-01', '2026-09-10', 30, 'Reduced running')`,
      )

      await expect(
        c.query(
          `insert into capacity_overrides (department_id, shift_id, component_id, from_date, to_date, units_per_day, reason)
           values (${ids}, (select id from components where code = 'LEG'),
                   '2026-09-05', '2026-09-08', 5, 'Leg jig under repair')`,
        ),
      ).resolves.toBeDefined()
    })
  })

  it('resolve capacity most-specific-first', async () => {
    await withRollback(async (c) => {
      await c.query(setup)
      const ids = `
        (select id from departments where code = 'WOOD'),
        (select id from shifts where code = 'A')
      `
      await c.query(
        `insert into component_rates (component_id, department_id, shift_id, units_per_day)
         values ((select id from components where code = 'LEG'), ${ids}, 40)`,
      )
      await c.query(
        `insert into capacity_overrides (department_id, shift_id, from_date, to_date, units_per_day, reason)
         values (${ids}, '2026-09-01', '2026-09-10', 30, 'Reduced running')`,
      )
      await c.query(
        `insert into capacity_overrides (department_id, shift_id, component_id, from_date, to_date, units_per_day, reason)
         values (${ids}, (select id from components where code = 'LEG'),
                 '2026-09-05', '2026-09-08', 5, 'Leg jig under repair')`,
      )

      const q = (date: string) =>
        c
          .query<{ cap: string }>(
            `select resolve_capacity(
               (select id from departments where code = 'WOOD'),
               (select id from shifts where code = 'A'),
               (select id from components where code = 'LEG'),
               $1::date) as cap`,
            [date],
          )
          .then((r) => Number(r.rows[0].cap))

      // Standing rate, department-wide override, component override.
      expect(await q('2026-08-20')).toBe(40)
      expect(await q('2026-09-02')).toBe(30)
      expect(await q('2026-09-06')).toBe(5)
    })
  })
})
