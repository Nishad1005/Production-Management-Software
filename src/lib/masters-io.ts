import { query, transaction } from '@/lib/database'

/**
 * Masters as a portable JSON file.
 *
 * The offline build keeps everything in one browser, so anything typed into it
 * is one cleared cache away from gone. That is an acceptable risk for demo data
 * and an unacceptable one for a real route and D-minus matrix entered by PPC.
 *
 * Rows are keyed by their natural keys — codes and dates, never UUIDs — so a
 * file exported from one database applies cleanly to another. That is what makes
 * this the seeding path for Supabase later, rather than a throwaway.
 */

const FORMAT_VERSION = 1

export type MastersFile = {
  kram_masters: number
  exported_at: string
  tables: Record<string, Record<string, unknown>[]>
}

/** Each table, its natural key, and the columns that travel with it. */
const TABLES = [
  {
    name: 'departments',
    select: `select code, name, route_position, yield_pct::float8, buffer_pct::float8, is_active
               from departments order by route_position`,
    conflict: '(code)',
    columns: ['code', 'name', 'route_position', 'yield_pct', 'buffer_pct', 'is_active'],
    values: '($1, $2, $3, $4, $5, $6)',
  },
  {
    name: 'shifts',
    select: `select code, name, to_char(start_time,'HH24:MI') as start_time,
                    to_char(end_time,'HH24:MI') as end_time,
                    net_production_hours::float8, max_ot_hours::float8, is_active
               from shifts order by code`,
    conflict: '(code)',
    columns: ['code', 'name', 'start_time', 'end_time', 'net_production_hours', 'max_ot_hours', 'is_active'],
    values: '($1, $2, $3::time, $4::time, $5, $6, $7)',
  },
  {
    name: 'articles',
    select: `select code, name, category, is_active from articles order by code`,
    conflict: '(code)',
    columns: ['code', 'name', 'category', 'is_active'],
    values: '($1, $2, $3, $4)',
  },
  {
    name: 'components',
    select: `select code, name, uom, is_active from components order by code`,
    conflict: '(code)',
    columns: ['code', 'name', 'uom', 'is_active'],
    values: '($1, $2, $3, $4)',
  },
  {
    name: 'holidays',
    select: `select holiday_date::text, description from holidays order by holiday_date`,
    conflict: '(holiday_date)',
    columns: ['holiday_date', 'description'],
    values: '($1::date, $2)',
  },
] as const

/** Joins to resolve codes back to ids, so the file carries no UUIDs. */
const LINKED = [
  {
    name: 'department_shifts',
    select: `select d.code as department_code, s.code as shift_code,
                    ds.sanctioned_headcount, ds.is_active
               from department_shifts ds
               join departments d on d.id = ds.department_id
               join shifts s on s.id = ds.shift_id
              order by d.route_position, s.code`,
    insert: `insert into department_shifts (department_id, shift_id, sanctioned_headcount, is_active)
             select d.id, s.id, $3::integer, $4::boolean
               from departments d, shifts s
              where d.code = $1 and s.code = $2
             on conflict (department_id, shift_id)
             do update set sanctioned_headcount = excluded.sanctioned_headcount,
                           is_active = excluded.is_active`,
    keys: ['department_code', 'shift_code', 'sanctioned_headcount', 'is_active'],
  },
  {
    name: 'article_bom',
    select: `select a.code as article_code, c.code as component_code, b.qty_per_unit::float8
               from article_bom b
               join articles a on a.id = b.article_id
               join components c on c.id = b.component_id
              order by a.code, c.code`,
    insert: `insert into article_bom (article_id, component_id, qty_per_unit)
             select a.id, c.id, $3::numeric
               from articles a, components c
              where a.code = $1 and c.code = $2
             on conflict (article_id, component_id)
             do update set qty_per_unit = excluded.qty_per_unit`,
    keys: ['article_code', 'component_code', 'qty_per_unit'],
  },
  {
    name: 'article_dept_dminus',
    select: `select a.code as article_code, d.code as department_code,
                    adm.dminus_days, adm.is_complete
               from article_dept_dminus adm
               join articles a on a.id = adm.article_id
               join departments d on d.id = adm.department_id
              order by a.code, d.route_position`,
    // The rows already exist, blank, created by trigger when the article and
    // department were inserted above. This fills them in.
    insert: `insert into article_dept_dminus (article_id, department_id, dminus_days, is_complete)
             select a.id, d.id, $3::integer, $4::boolean
               from articles a, departments d
              where a.code = $1 and d.code = $2
             on conflict (article_id, department_id)
             do update set dminus_days = excluded.dminus_days,
                           is_complete = excluded.is_complete`,
    keys: ['article_code', 'department_code', 'dminus_days', 'is_complete'],
  },
  {
    name: 'component_rates',
    select: `select c.code as component_code, d.code as department_code,
                    s.code as shift_code, cr.units_per_day::float8, cr.is_measured
               from component_rates cr
               join components c on c.id = cr.component_id
               join departments d on d.id = cr.department_id
               join shifts s on s.id = cr.shift_id
              order by d.route_position, c.code, s.code`,
    insert: `insert into component_rates (component_id, department_id, shift_id, units_per_day, is_measured)
             select c.id, d.id, s.id, $4::numeric, $5::boolean
               from components c, departments d, shifts s
              where c.code = $1 and d.code = $2 and s.code = $3
             on conflict (component_id, department_id, shift_id)
             do update set units_per_day = excluded.units_per_day`,
    keys: ['component_code', 'department_code', 'shift_code', 'units_per_day', 'is_measured'],
  },
] as const

export async function exportMasters(): Promise<MastersFile> {
  const tables: MastersFile['tables'] = {}

  for (const t of TABLES) {
    tables[t.name] = (await query(t.select)) as Record<string, unknown>[]
  }
  for (const t of LINKED) {
    tables[t.name] = (await query(t.select)) as Record<string, unknown>[]
  }

  return {
    kram_masters: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    tables,
  }
}

export function downloadMasters(file: MastersFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kram-masters-${file.exported_at.slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Applies a masters file, upserting by natural key.
 *
 * Upsert rather than replace: predictable, non-destructive, and a partly filled
 * file can be applied without wiping what is already there. Order matters —
 * departments and shifts before the pairings that reference them.
 */
export async function importMasters(file: MastersFile): Promise<number> {
  if (file?.kram_masters !== FORMAT_VERSION) {
    throw new Error(
      `This is not a Kram masters file (expected kram_masters ${FORMAT_VERSION}).`,
    )
  }
  if (!file.tables || typeof file.tables !== 'object') {
    throw new Error('The file has no tables section.')
  }

  let applied = 0

  await transaction(async (run) => {
    for (const t of TABLES) {
      for (const row of file.tables[t.name] ?? []) {
        const params = t.columns.map((c) => row[c] ?? null)
        const updates = t.columns
          .filter((c) => !t.conflict.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(', ')
        await run(
          `insert into ${t.name} (${t.columns.join(', ')}) values ${t.values}
           on conflict ${t.conflict} do update set ${updates}`,
          params,
        )
        applied += 1
      }
    }

    for (const t of LINKED) {
      for (const row of file.tables[t.name] ?? []) {
        await run(
          t.insert,
          t.keys.map((k) => row[k] ?? null),
        )
        applied += 1
      }
    }
  })

  return applied
}

export function readJsonFile(file: File): Promise<MastersFile> {
  return file.text().then((text) => {
    try {
      return JSON.parse(text) as MastersFile
    } catch {
      throw new Error('That file is not valid JSON.')
    }
  })
}
