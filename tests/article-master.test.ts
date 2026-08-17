// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { withRollback } from './helpers/db'
import { applySeed, createOrder, runSchedule } from './helpers/fixtures'

/**
 * Articles as a master.
 *
 * Until now the only way to add one was SQL, which made the first task anybody
 * entering real data would face the one task they could not do. What these
 * guard is mostly the edges: that a new article cannot schedule until somebody
 * says when each department must finish, and that switching one off does not
 * quietly take the orders already placed against it with it.
 */

const master = async (c: pg.Client, code: string) =>
  (
    await c.query<{
      name: string
      category: string | null
      is_active: boolean
      departments_routed: number
      missing_dminus: number
      can_schedule: boolean
      open_orders: number
    }>(`select * from article_master where code = $1`, [code])
  ).rows[0]

describe('adding an article', () => {
  it('takes a code, a name and a category', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article('CHAIR-9', 'Bergen Chair', 'Dining')`)

      const a = await master(c, 'CHAIR-9')
      expect(a.name).toBe('Bergen Chair')
      expect(a.category).toBe('Dining')
      expect(a.is_active).toBe(true)
    })
  })

  it('cannot be scheduled until it has a route and its D-minus', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article('CHAIR-9', 'Bergen Chair')`)

      // Nothing routed: nowhere to make it.
      let a = await master(c, 'CHAIR-9')
      expect(a.departments_routed).toBe(0)
      expect(a.can_schedule).toBe(false)

      // Routed, but nobody has said when wood must finish. A blank D-minus
      // blocks scheduling rather than defaulting to zero — the whole point of
      // the incomplete flag.
      await c.query(`select set_capacity_cell('CHAIR-9', 'WOOD', 40)`)
      a = await master(c, 'CHAIR-9')
      expect(a.departments_routed).toBe(1)
      expect(a.missing_dminus).toBe(1)
      expect(a.can_schedule).toBe(false)

      await c.query(`select set_dminus('CHAIR-9', 'WOOD', 30)`)
      a = await master(c, 'CHAIR-9')
      expect(a.missing_dminus).toBe(0)
      expect(a.can_schedule).toBe(true)
    })
  })

  it('gets a blank D-minus cell against every department, flagged incomplete', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article('CHAIR-9', 'Bergen Chair')`)

      const { rows } = await c.query<{ n: string; incomplete: string }>(
        `select count(*) as n,
                count(*) filter (where not is_complete) as incomplete
           from article_dept_dminus adm
           join articles a on a.id = adm.article_id
          where a.code = 'CHAIR-9'`,
      )
      const departments = (
        await c.query<{ n: string }>(
          `select count(*) as n from departments where is_active`,
        )
      ).rows[0].n
      expect(rows[0].n).toBe(departments)
      expect(rows[0].incomplete).toBe(departments)
    })
  })

  it('corrects the name rather than making a second article', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article('CHAIR-9', 'Bergan Chair', 'Dining')`)
      await c.query(`select set_article('CHAIR-9', 'Bergen Chair', 'Dining')`)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from articles where code = 'CHAIR-9'`,
      )
      expect(Number(rows[0].n)).toBe(1)
      expect((await master(c, 'CHAIR-9')).name).toBe('Bergen Chair')
    })
  })

  it('refuses a blank code', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_article('   ', 'Nameless')`),
      ).rejects.toThrow(/needs a code/)
    })
  })

  it('refuses a blank name', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(c.query(`select set_article('CHAIR-9', '')`)).rejects.toThrow(
        /needs a name/,
      )
    })
  })
})

describe('switching an article off', () => {
  it('takes it out of the capacity sheet without deleting anything', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article_active('AARA-LC', false)`)

      const { rows: sheet } = await c.query<{ n: string }>(
        `select count(*) as n from capacity_sheet where article_code = 'AARA-LC'`,
      )
      expect(Number(sheet[0].n)).toBe(0)

      // Still there, and still says so.
      expect((await master(c, 'AARA-LC')).is_active).toBe(false)
    })
  })

  it('leaves the orders already placed against it planned', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      await runSchedule(c)
      // Counted in the current run: schedule_gantt spans every run ever made,
      // so a bare count would grow by re-running and prove nothing.
      const planned = async () =>
        (
          await c.query<{ n: string }>(
            `select count(*) as n from schedule_gantt
              where run_id = (select id from schedule_runs where is_current)`,
          )
        ).rows[0].n
      const before = await planned()

      await c.query(`select set_article_active('AARA-LC', false)`)
      await runSchedule(c)

      // Switching an article off means "do not sell it again", not "forget the
      // container that is already booked". A plan that silently dropped work
      // the factory is committed to would be the worst kind of wrong here.
      const after = await planned()
      expect(after).toBe(before)
      expect(Number(after)).toBeGreaterThan(0)
    })
  })

  it('counts the orders against it, so the decision is informed', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      expect((await master(c, 'AARA-LC')).open_orders).toBe(0)
      await createOrder(c, { qty: 100, stuffingDate: '2026-12-01' })
      expect((await master(c, 'AARA-LC')).open_orders).toBe(1)
    })
  })

  it('comes back when the same code is added again', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await c.query(`select set_article_active('AARA-LC', false)`)
      await c.query(`select set_article('AARA-LC', 'Aara Lounge Chair')`)
      expect((await master(c, 'AARA-LC')).is_active).toBe(true)
    })
  })

  it('refuses to switch off something that does not exist', async () => {
    await withRollback(async (c) => {
      await applySeed(c)
      await expect(
        c.query(`select set_article_active('NOSUCH', false)`),
      ).rejects.toThrow(/unknown article/)
    })
  })
})
