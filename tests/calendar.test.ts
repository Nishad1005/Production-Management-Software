// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient, withRollback } from './helpers/db'

// Spec §3 parameter 4: six-day week, Sunday off, plus a holiday calendar.
// 2026-09-06 and 2026-09-13 are Sundays; 2026-09-12 is a Saturday.

const day = (client: Parameters<Parameters<typeof withClient>[0]>[0]) => ({
  isWorking: async (date: string) =>
    client
      .query<{ is_working: boolean }>(
        `select is_working from working_days where calendar_date = $1`,
        [date],
      )
      .then((r) => r.rows[0]?.is_working),

  prev: async (date: string) =>
    client
      .query<{ d: string }>(`select prev_working_day($1)::text as d`, [date])
      .then((r) => r.rows[0].d),

  minus: async (date: string, n: number) =>
    client
      .query<{ d: string }>(
        `select subtract_working_days($1, $2)::text as d`,
        [date, n],
      )
      .then((r) => r.rows[0].d),

  between: async (from: string, to: string) =>
    client
      .query<{ n: number }>(`select working_days_between($1, $2) as n`, [
        from,
        to,
      ])
      .then((r) => r.rows[0].n),
})

describe('working-day calendar', () => {
  it('is built by the migration, spanning years either side of today', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ n: string; lo: string; hi: string }>(
        `select count(*) as n, min(calendar_date)::text as lo, max(calendar_date)::text as hi
           from working_days`,
      ),
    )
    expect(Number(rows[0].n)).toBeGreaterThan(2000)
    expect(rows[0].lo < '2024-01-01').toBe(true)
    expect(rows[0].hi > '2029-01-01').toBe(true)
  })

  it('closes Sundays and keeps Saturdays open', async () => {
    await withClient(async (c) => {
      const d = day(c)
      expect(await d.isWorking('2026-09-06')).toBe(false)
      expect(await d.isWorking('2026-09-13')).toBe(false)
      expect(await d.isWorking('2026-09-12')).toBe(true)
    })
  })

  it('rolls a Sunday back to the Saturday before it', async () => {
    await withClient(async (c) => {
      const d = day(c)
      expect(await d.prev('2026-09-13')).toBe('2026-09-12')
      // A working day is its own previous working day.
      expect(await d.prev('2026-09-14')).toBe('2026-09-14')
    })
  })

  it('skips Sundays when counting backwards', async () => {
    await withClient(async (c) => {
      const d = day(c)
      // Mon 14th back one working day is Sat 12th, not Sun 13th.
      expect(await d.minus('2026-09-14', 1)).toBe('2026-09-12')
      // Six working days back from Mon 14th crosses one Sunday.
      expect(await d.minus('2026-09-14', 6)).toBe('2026-09-07')
      expect(await d.minus('2026-09-14', 0)).toBe('2026-09-14')
    })
  })

  it('counts working days inclusively', async () => {
    await withClient(async (c) => {
      // Mon 7th to Sun 13th is six working days: Sunday the 13th is closed.
      expect(await day(c).between('2026-09-07', '2026-09-13')).toBe(6)
    })
  })

  it('closes a declared holiday and renumbers around it', async () => {
    await withRollback(async (c) => {
      const d = day(c)
      expect(await d.isWorking('2026-09-10')).toBe(true)
      const before = await d.minus('2026-09-14', 3)

      await c.query(
        `insert into holidays (holiday_date, description) values ('2026-09-10', 'Ganesh Chaturthi')`,
      )

      expect(await d.isWorking('2026-09-10')).toBe(false)
      // The same count backwards now reaches one calendar day further.
      const after = await d.minus('2026-09-14', 3)
      expect(after < before).toBe(true)
    })
  })

  it('returns null past the end of the horizon rather than guessing', async () => {
    await withClient(async (c) => {
      const { rows } = await c.query<{ d: string | null }>(
        `select subtract_working_days('2099-01-01'::date, 5)::text as d`,
      )
      expect(rows[0].d).toBeNull()
    })
  })
})
