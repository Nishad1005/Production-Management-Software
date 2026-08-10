// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'

const seedPath = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'supabase',
  'seed.sql',
)

describe('placeholder seed', () => {
  it('applies cleanly and leaves the article fully schedulable', async () => {
    await withRollback(async (c) => {
      await c.query(await readFile(seedPath, 'utf8'))

      const { rows: route } = await c.query<{ code: string }>(
        `select code from departments where is_active order by route_position`,
      )
      expect(route.map((r) => r.code)).toEqual([
        'WOOD',
        'FABCUT',
        'STITCH',
        'ASSY',
      ])

      // Spec §4: an article with any incomplete D-minus cell must not be
      // schedulable. The seed exists to make one article that is.
      const { rows: incomplete } = await c.query<{ n: string }>(
        `select count(*) as n
           from article_dept_dminus adm
           join articles a on a.id = adm.article_id
           join departments d on d.id = adm.department_id
          where a.code = 'AARA-LC' and d.is_active and not adm.is_complete`,
      )
      expect(Number(incomplete[0].n)).toBe(0)

      // Every BOM component must be made by exactly one department, or the
      // engine has nowhere to place the work.
      const { rows: orphans } = await c.query<{ code: string }>(
        `select c.code
           from article_bom b
           join components c on c.id = b.component_id
           join articles a on a.id = b.article_id
          where a.code = 'AARA-LC'
            and not exists (
              select 1 from component_rates cr where cr.component_id = c.id
            )`,
      )
      expect(orphans.map((r) => r.code)).toEqual([])
    })
  })

  it('is idempotent', async () => {
    await withRollback(async (c) => {
      const seed = await readFile(seedPath, 'utf8')
      await c.query(seed)
      await c.query(seed)

      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from departments`,
      )
      expect(Number(rows[0].n)).toBe(4)
    })
  })
})
