// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

/**
 * Phase 7 — machines.
 *
 * This phase changes `resolve_capacity`, which is the function every date in
 * the system eventually rests on. So the tests that matter most are the ones
 * proving what it does *not* do: a department with no machines recorded must
 * come out exactly as it did before, and an explicit override must still beat
 * everything underneath it.
 */

const DAY = '2026-11-04'

async function stitching(c: pg.Client) {
  await applySeed(c)
  // Thirty covers a day with a crew of three, so attendance has something to
  // scale and the two factors can be told apart.
  await c.query(
    `update component_rates set manpower = 3
      where department_id = (select id from departments where code = 'STITCH')`,
  )
}

const capacity = async (c: pg.Client, date = DAY) =>
  Number(
    (
      await c.query<{ units: string }>(
        `select resolve_capacity(
           (select id from departments where code = 'STITCH'),
           (select id from shifts where code = 'GEN'),
           (select id from components where code = 'COVER'),
           $1::date)::text as units`,
        [date],
      )
    ).rows[0].units,
  )

const addMachines = async (c: pg.Client, n: number) => {
  for (let i = 1; i <= n; i++) {
    await c.query(`select set_machine($1, $2, 'STITCH', 'Juki DDL-8700')`, [
      `STITCH-${i}`,
      `Lockstitch ${i}`,
    ])
  }
}

describe('a department nobody has told us about', () => {
  it('is left exactly as it was', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      // The whole risk of this phase. No machines recorded is not no machines
      // available, and treating it as zero would take every department in the
      // factory to nothing the day this migration landed.
      expect(await capacity(c)).toBe(30)

      const { rows } = await c.query<{ availability: string | null }>(
        `select machine_availability(
           (select id from departments where code = 'STITCH'), $1::date
         )::text as availability`,
        [DAY],
      )
      expect(rows[0].availability).toBeNull()
    })
  })
})

describe('machines against the day', () => {
  it('leaves a department alone while everything is running', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      expect(await capacity(c)).toBe(30)
    })
  })

  it('takes the day down in proportion to what is down', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )
      // Three of four running.
      expect(await capacity(c)).toBe(22.5)
    })
  })

  it('only on the days it is actually down', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )
      expect(await capacity(c, '2026-11-05')).toBe(30)
    })
  })

  it('multiplies with attendance rather than replacing it', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      await c.query(`select set_attendance('STITCH', 'GEN', $1::date, 2)`, [DAY])
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )
      // Two of three people on three of four machines: 30 × 2/3 × 3/4 = 15.
      // Either factor alone would overstate the day, and taking the worse of
      // the two would understate it.
      expect(await capacity(c)).toBe(15)
    })
  })

  it('lets a typed figure beat both', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )
      await c.query(
        `select set_day_capacity('STITCH', 'GEN', $1::date, 12, 'Running one line only')`,
        [DAY],
      )
      // Somebody has said what the day is. That always wins — it is a person
      // looking at the floor, not the software inferring from two ratios.
      expect(await capacity(c)).toBe(12)
    })
  })

  it('goes to nothing when every machine is down', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 2)
      for (const code of ['STITCH-1', 'STITCH-2']) {
        await c.query(
          `select set_machine_downtime($1, $2::date, $2::date, 'Annual service')`,
          [code, DAY],
        )
      }
      // Counted, and there is nothing running. A real zero, unlike the
      // department nobody has recorded machines for.
      expect(await capacity(c)).toBe(0)
    })
  })

  it('ignores a machine that has been retired', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 4)
      await c.query(`select set_machine_active('STITCH-4', false)`)
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )
      // Two of three now, not three of four — a retired machine is not a
      // machine that is down, and counting it either way would be wrong.
      expect(await capacity(c)).toBeCloseTo(20, 3)
    })
  })
})

describe('recording downtime', () => {
  it('refuses two entries over the same day', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 2)
      await c.query(
        `select set_machine_downtime('STITCH-1', '2026-11-02', '2026-11-06', 'Service')`,
      )
      // Counted out twice, a machine takes the department below where it is.
      await expect(
        c.query(
          `select set_machine_downtime('STITCH-1', '2026-11-05', '2026-11-08', 'Belt')`,
        ),
      ).rejects.toThrow(/machine_downtime_no_overlap/)
    })
  })

  it('insists on a reason', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 1)
      await expect(
        c.query(
          `select set_machine_downtime('STITCH-1', $1::date, $1::date, '  ')`,
          [DAY],
        ),
      ).rejects.toThrow()
    })
  })

  it('refuses a run that ends before it starts', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 1)
      await expect(
        c.query(
          `select set_machine_downtime('STITCH-1', '2026-11-08', '2026-11-02', 'Service')`,
        ),
      ).rejects.toThrow(/machine_downtime_dates/)
    })
  })

  it('shows today and what is coming', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 3)
      await c.query(
        `select set_machine_downtime('STITCH-1', current_date, current_date + 2,
           'Head 3 stripped', 'breakdown')`,
      )
      await c.query(
        `select set_machine_downtime('STITCH-2', current_date + 20, current_date + 21,
           'Annual service')`,
      )

      const { rows } = await c.query<{
        machines: number
        available: number
        available_pct: number
      }>(`select * from machine_status where department_code = 'STITCH'`)
      expect(rows[0].machines).toBe(3)
      expect(rows[0].available).toBe(2)
      expect(rows[0].available_pct).toBeCloseTo(66.7, 1)

      const { rows: dt } = await c.query<{
        machine_code: string
        active_today: boolean
        upcoming: boolean
        days: number
        kind: string
      }>(`select * from machine_downtime_list order by from_date`)
      expect(dt[0].active_today).toBe(true)
      expect(dt[0].days).toBe(3)
      expect(dt[0].kind).toBe('breakdown')
      expect(dt[1].upcoming).toBe(true)
    })
  })
})

/**
 * The masters file is how a floor's worth of typing reaches the hosted system,
 * and a machine list is exactly that kind of typing — somebody walked the
 * factory to get it. So it has to survive the round trip.
 */
describe('machines in the masters file', () => {
  it('travel out and back, keyed by department code', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 3)

      const { rows: exported } = await c.query<{ file: unknown }>(
        `select jsonb_build_object(
           'kram_masters', 1,
           'tables', jsonb_build_object(
             'departments', (select jsonb_agg(to_jsonb(x)) from (
                select code, name, route_position, yield_pct, is_active
                  from department_master) x),
             'machines', (select jsonb_agg(to_jsonb(x)) from (
                select code, name, department_code, machine_type, asset_no, is_active
                  from machine_master) x)
           )) as file`,
      )

      // Lose one and rename another, the way a browser with a cleared cache
      // would have lost the afternoon.
      await c.query(`delete from machines where code = 'STITCH-3'`)
      await c.query(`update machines set name = 'wrong' where code = 'STITCH-1'`)

      await c.query(`select import_masters($1::jsonb)`, [
        JSON.stringify(exported[0].file),
      ])

      const { rows } = await c.query<{ code: string; name: string; department_code: string }>(
        `select code, name, department_code from machine_master order by code`,
      )
      expect(rows.map((r) => r.code)).toEqual(['STITCH-1', 'STITCH-2', 'STITCH-3'])
      expect(rows[0].name).toBe('Lockstitch 1')
      expect(rows[0].department_code).toBe('STITCH')
    })
  })

  /**
   * Both of these failed when this function was hand-copied rather than
   * regenerated. Neither would have shown up as an error on screen: the first
   * refused an import that had always worked, and the second would have
   * switched on every shift on every department and roughly doubled the
   * factory, silently.
   */
  it('does not fall over on a department/shift pairing with no crew', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      // department_shift_grid is a cross join, so it carries a row for every
      // department against every shift — including the ones nobody staffs,
      // where the headcount is null.
      const { rows } = await c.query<{ file: unknown }>(
        `select jsonb_build_object('kram_masters', 1, 'tables', jsonb_build_object(
           'departments', (select jsonb_agg(to_jsonb(x)) from (
              select code, name, route_position, yield_pct, is_active
                from department_master) x),
           'shifts', (select jsonb_agg(to_jsonb(x)) from (
              select code, name, start_label as start_time, end_label as end_time,
                     net_production_hours, max_ot_hours, is_active from shift_master) x),
           'department_shifts', (select jsonb_agg(to_jsonb(x)) from (
              select department_code, shift_code, sanctioned_headcount, is_active
                from department_shift_grid) x)
         )) as file`,
      )
      await expect(
        c.query(`select import_masters($1::jsonb)`, [JSON.stringify(rows[0].file)]),
      ).resolves.toBeDefined()
    })
  })

  it('does not switch on a shift the file says is off', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      const before = (
        await c.query<{ n: string }>(
          `select count(*) as n from department_shifts where is_active`,
        )
      ).rows[0].n

      const { rows } = await c.query<{ file: unknown }>(
        `select jsonb_build_object('kram_masters', 1, 'tables', jsonb_build_object(
           'departments', (select jsonb_agg(to_jsonb(x)) from (
              select code, name, route_position, yield_pct, is_active
                from department_master) x),
           'shifts', (select jsonb_agg(to_jsonb(x)) from (
              select code, name, start_label as start_time, end_label as end_time,
                     net_production_hours, max_ot_hours, is_active from shift_master) x),
           'department_shifts', (select jsonb_agg(to_jsonb(x)) from (
              select department_code, shift_code, sanctioned_headcount, is_active
                from department_shift_grid) x)
         )) as file`,
      )
      await c.query(`select import_masters($1::jsonb)`, [JSON.stringify(rows[0].file)])

      // Same number running as before. Defaulting the flag to true here would
      // put every department on every shift and roughly double the factory.
      const after = (
        await c.query<{ n: string }>(
          `select count(*) as n from department_shifts where is_active`,
        )
      ).rows[0].n
      expect(after).toBe(before)
    })
  })

  it('leave downtime out of the masters file, deliberately', async () => {
    await withRollback(async (c) => {
      await stitching(c)
      await addMachines(c, 2)
      await c.query(
        `select set_machine_downtime('STITCH-1', $1::date, $1::date, 'Timing belt')`,
        [DAY],
      )

      // A masters file is merged into another database. Downtime is an event
      // that happened in *this* one — it belongs in the backup file, with the
      // production ledger, not in something applied on top of a live system.
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from information_schema.columns
          where table_name = 'machine_master' and column_name like '%downtime%'`,
      )
      expect(Number(rows[0].n)).toBe(0)
    })
  })
})
