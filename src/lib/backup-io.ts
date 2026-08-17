import { select } from '@/lib/backend'
import { exportMasters, type MastersFile } from '@/lib/masters-io'

/**
 * Everything, as one file.
 *
 * The schema is backed up already — it is thirty-three migrations in git, and a
 * database can be rebuilt from them in one command. The masters have a file of
 * their own. What has no copy anywhere is the data people typed: the order
 * book, and above all the production ledger.
 *
 * That distinction is the whole design. Rates and D-minus can be re-entered
 * from a spreadsheet, painfully. **What a department declared it made on a
 * Tuesday cannot be reconstructed from anything**, by anyone, ever. It exists
 * in one Supabase project and nowhere else, and this is how it gets out.
 *
 * Reads go through views, so it works against either backend — the same file
 * comes out of the offline demo and the hosted system.
 *
 * ---------------------------------------------------------------------------
 * This is a copy, not a restore.
 *
 * There is deliberately no import for the transactional half. Masters upsert by
 * natural key and are safe to apply twice; a production declaration is an event,
 * and replaying events into a database that may already hold some of them is
 * how a factory ends up with a day it made twice. Rebuilding from this file is
 * a job someone does once, carefully, with the file in front of them.
 * ---------------------------------------------------------------------------
 */

const FORMAT_VERSION = 1

export type BackupFile = {
  kram_backup: number
  exported_at: string
  masters: MastersFile['tables']
  data: Record<string, Record<string, unknown>[]>
  counts: Record<string, number>
}

/**
 * view → the rows that travel. Order matters only for legibility; nothing here
 * is applied automatically.
 */
const DATA: { table: string; view: string; order: string[] }[] = [
  { table: 'customers', view: 'customer_list', order: ['code'] },
  { table: 'orders', view: 'order_list', order: ['erp_order_no'] },
  {
    table: 'shipment_lines',
    view: 'shipment_line_list',
    order: ['erp_order_no', 'line_no'],
  },
  // The irreplaceable two.
  {
    table: 'production_declarations',
    view: 'declaration_list',
    order: ['production_date', 'erp_order_no'],
  },
  {
    table: 'production_acceptances',
    view: 'acceptance_list',
    order: ['production_date', 'erp_order_no'],
  },
  { table: 'employees', view: 'employee_list', order: ['emp_code'] },
  {
    table: 'employee_attendance',
    view: 'attendance_list',
    order: ['attendance_date', 'emp_code'],
  },
  {
    table: 'department_attendance',
    view: 'department_attendance_list',
    order: ['attendance_date', 'department_code'],
  },
  {
    table: 'capacity_overrides',
    view: 'capacity_override_list',
    order: ['from_date', 'department_code'],
  },
  // A pin is somebody overruling the engine, and the reason they gave. The
  // schedule can be re-run; the reason cannot be recovered from anything.
  { table: 'schedule_pins', view: 'pin_list', order: ['pinned_start_date'] },
]

export async function exportBackup(): Promise<BackupFile> {
  const masters = await exportMasters()

  const data: BackupFile['data'] = {}
  for (const spec of DATA) {
    data[spec.table] = await select<Record<string, unknown>>(spec.view, {
      order: spec.order,
    })
  }

  // Written into the file rather than left to be counted later: a file whose
  // own header says 412 declarations is one you can check at a glance against
  // a screen, without parsing anything.
  const counts: BackupFile['counts'] = {}
  for (const [table, rows] of Object.entries(masters.tables)) {
    counts[table] = rows.length
  }
  for (const [table, rows] of Object.entries(data)) {
    counts[table] = rows.length
  }

  return {
    kram_backup: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    masters: masters.tables,
    data,
    counts,
  }
}

export function downloadBackup(file: BackupFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kram-backup-${file.exported_at.slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** What the file holds, for showing next to the button that made it. */
export function summarise(file: BackupFile) {
  const ledger =
    (file.counts.production_declarations ?? 0) +
    (file.counts.production_acceptances ?? 0)
  return {
    orders: file.counts.orders ?? 0,
    lines: file.counts.shipment_lines ?? 0,
    ledger,
    people: file.counts.employees ?? 0,
    rows: Object.values(file.counts).reduce((n, c) => n + c, 0),
  }
}
