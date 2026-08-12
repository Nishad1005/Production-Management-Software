import { rpc, select } from '@/lib/backend'

/**
 * Masters as a portable JSON file.
 *
 * Keyed by natural keys — codes and dates, never internal ids — so a file
 * exported from one database applies cleanly to another. That is what makes it
 * the path for PPC's real figures: enter them in the offline build, save the
 * file, load it into the hosted system.
 *
 * It also stops a cleared browser cache destroying an afternoon's data entry,
 * which is the reason it exists at all.
 *
 * Reads go through views and the write through one function, so this works on
 * either backend.
 */

const FORMAT_VERSION = 1

export type MastersFile = {
  kram_masters: number
  exported_at: string
  tables: Record<string, Record<string, unknown>[]>
}

/** view → the columns that travel, renamed to the file's field names. */
const EXPORTS: {
  table: string
  view: string
  order: string[]
  pick: (row: Record<string, unknown>) => Record<string, unknown>
}[] = [
  {
    table: 'departments',
    view: 'department_master',
    order: ['route_position'],
    pick: (r) => ({
      code: r.code,
      name: r.name,
      route_position: r.route_position,
      yield_pct: r.yield_pct,
      is_active: r.is_active,
    }),
  },
  {
    // Immediately after departments, and imported in that order too: an edge is
    // two department codes and nothing else. Left out of this list until now,
    // which meant a saved file quietly rebuilt a factory where nothing feeds
    // anything.
    table: 'department_dependencies',
    view: 'department_dependency_list',
    order: ['route_position', 'depends_on_code'],
    pick: (r) => ({
      department_code: r.department_code,
      depends_on_code: r.depends_on_code,
    }),
  },
  {
    table: 'shifts',
    view: 'shift_master',
    order: ['code'],
    pick: (r) => ({
      code: r.code,
      name: r.name,
      start_time: r.start_label,
      end_time: r.end_label,
      net_production_hours: r.net_production_hours,
      max_ot_hours: r.max_ot_hours,
      is_active: r.is_active,
    }),
  },
  {
    table: 'articles',
    view: 'article_list',
    order: ['code'],
    pick: (r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      is_active: r.is_active,
    }),
  },
  {
    table: 'components',
    view: 'component_list',
    order: ['code'],
    pick: (r) => ({
      code: r.code,
      name: r.name,
      uom: r.uom,
      is_active: r.is_active,
    }),
  },
  {
    table: 'holidays',
    view: 'holiday_list',
    order: ['holiday_date'],
    pick: (r) => ({
      holiday_date: r.holiday_date,
      description: r.description,
    }),
  },
  {
    table: 'department_shifts',
    view: 'department_shift_grid',
    order: ['route_position', 'shift_code'],
    pick: (r) => ({
      department_code: r.department_code,
      shift_code: r.shift_code,
      sanctioned_headcount: r.sanctioned_headcount,
      is_active: r.is_active,
    }),
  },
  {
    table: 'article_bom',
    view: 'bom_master',
    order: ['article_code', 'component_code'],
    pick: (r) => ({
      article_code: r.article_code,
      component_code: r.component_code,
      qty_per_unit: r.qty_per_unit,
    }),
  },
  {
    table: 'article_dept_dminus',
    view: 'dminus_matrix',
    order: ['article_code', 'route_position'],
    pick: (r) => ({
      article_code: r.article_code,
      department_code: r.department_code,
      dminus_days: r.dminus_days,
      is_complete: r.is_complete,
    }),
  },
  {
    table: 'component_rates',
    view: 'component_rate_master',
    order: ['route_position', 'component_code', 'shift_code'],
    pick: (r) => ({
      component_code: r.component_code,
      department_code: r.department_code,
      shift_code: r.shift_code,
      units_per_day: r.units_per_day,
      is_measured: r.is_measured,
    }),
  },
]

export async function exportMasters(): Promise<MastersFile> {
  const tables: MastersFile['tables'] = {}

  for (const spec of EXPORTS) {
    const rows = await select<Record<string, unknown>>(spec.view, {
      order: spec.order,
    })
    tables[spec.table] = rows.map(spec.pick)
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

/** Applies a masters file, upserting by natural key. Returns rows applied. */
export async function importMasters(file: MastersFile): Promise<number> {
  if (file?.kram_masters !== FORMAT_VERSION) {
    throw new Error(
      `This is not a Kram masters file (expected kram_masters ${FORMAT_VERSION}).`,
    )
  }
  if (!file.tables || typeof file.tables !== 'object') {
    throw new Error('The file has no tables section.')
  }

  return rpc<number>('import_masters', { p_file: file })
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
