/**
 * U&M's planning sheet, turned into the things Kram loads.
 *
 * The sheet is a time-and-action calendar: one row per SKU, a quantity under
 * each dispatch date, and a day-count for each of seventeen steps counted back
 * from the dispatch day. This module is the whole of the translation, and it
 * lives apart from both its callers on purpose — `tests/um-sample-sheet.test.ts`
 * dry-runs it against a local database and `scripts/load-um-sample.mjs` applies
 * it to the hosted one, and a translation that existed twice would be two
 * translations within a week.
 *
 * ---------------------------------------------------------------------------
 * Three places where their sheet and Kram's model differ, and what is done
 * about each. All three are decisions, and they are stated here rather than
 * buried in the mapping:
 *
 * 1. **Their steps are not Kram's departments.** Three of their columns are two
 *    departments planned as one step — *Ply cutting and assembly*, *Wood and
 *    metal finishing*, *Foam and fibre*. Both departments take the column's
 *    figure. Kram keeps them separate because they have separate crews and will
 *    have separate rates; the sheet only says they share a deadline.
 *
 * 2. **Their QC columns are deadlines, not production.** A checkpoint becomes a
 *    department with a rate so large the work always fits in a day, hung
 *    *beside* the flow rather than in it: it depends on the step it inspects
 *    and nothing depends on it. That is deliberate. The sheet routinely gives a
 *    checkpoint the same day as the next production step (Wood QC 37, Sanding
 *    37), and Kram holds a step behind everything that feeds it — so a
 *    checkpoint placed in the line would leave Sanding no days at all and raise
 *    a breach the sheet's authors never intended.
 *
 * 3. **Equal figures between real production steps are left exactly as given.**
 *    The Betsy chair has Machining and Ply-cutting-and-assembly both at 34.
 *    Kram reads that as "no time between them" and says so. It is not softened
 *    here, because whether it is deliberate is a question for PPC and a loader
 *    that quietly resolved it would be answering on their behalf.
 */

/** `${article}::${department}` — the convention the interim loader set. */
export const componentCode = (sku, department) => `${sku}::${department}`

/** Each SKU's day-count per Kram department, expanded from the sheet's steps. */
export function daysByDepartment(sheet, row) {
  const out = new Map()
  sheet.steps.forEach((step, i) => {
    for (const code of step.departments) out.set(code, row.days[i])
  })
  return out
}

/**
 * The masters file `import_masters` takes, as one atomic call.
 *
 * `existing` carries what the target database already knows, so an upsert does
 * not flatten it: the names and yields of departments that already exist, and
 * the names of articles that do. Pass nothing for an empty database.
 */
export function buildMasters(sheet, existing = {}) {
  const knownDepartments = existing.departments ?? new Map()
  const knownArticles = existing.articles ?? new Map()
  const checkpoints = new Set(
    sheet.departments.filter((d) => d.checkpoint).map((d) => d.code),
  )

  const departments = sheet.departments.map((d) => {
    const known = knownDepartments.get(d.code)
    return {
      code: d.code,
      name: known?.name ?? d.name,
      route_position: d.position,
      // A checkpoint loses nothing: inflating every upstream quantity by a
      // further 2% for each of seven inspections would be inventing scrap.
      //
      // Including a checkpoint that already exists. The first live load kept
      // Final QC at the 98% it had carried as a placeholder, while the local
      // dry run created it fresh at 100% — and that one figure moved Fitting
      // from 3.96 days of work to 4.04, which is the difference between
      // fitting a four-day window and breaching it. Four breaches appeared on
      // the hosted project that the rehearsal had not shown.
      yield_pct: d.checkpoint ? 100 : (known?.yield_pct ?? 98),
      is_active: true,
    }
  })

  const department_dependencies = sheet.feeds.map(([feeder, department]) => ({
    department_code: department,
    depends_on_code: feeder,
  }))

  // Without a shift row the engine drops a department from every plan and says
  // nothing — the defect that had the live system scheduling two departments of
  // fourteen in August. Only for the departments that are new.
  const department_shifts = sheet.departments
    .filter((d) => !knownDepartments.has(d.code))
    .map((d) => ({
      department_code: d.code,
      shift_code: 'GEN',
      sanctioned_headcount: 0,
      is_active: true,
    }))

  const articles = []
  const components = []
  const article_bom = []
  const component_rates = []
  const article_dept_dminus = []

  for (const row of sheet.rows) {
    articles.push({
      code: row.sku,
      name: knownArticles.get(row.sku) ?? row.name,
      category: row.category,
      is_active: true,
    })
    for (const [department, days] of daysByDepartment(sheet, row)) {
      const code = componentCode(row.sku, department)
      components.push({
        code,
        name: `${department} work on ${row.sku}`,
        uom: 'NOS',
        is_active: true,
      })
      article_bom.push({
        article_code: row.sku,
        component_code: code,
        qty_per_unit: 1,
      })
      component_rates.push({
        component_code: code,
        department_code: department,
        shift_code: 'GEN',
        units_per_day: checkpoints.has(department)
          ? sheet.checkpoint_rate_per_day
          : sheet.rate_per_day,
        is_measured: false,
      })
      article_dept_dminus.push({
        article_code: row.sku,
        department_code: department,
        dminus_days: days,
        is_complete: true,
      })
    }
  }

  return {
    kram_masters: 1,
    tables: {
      departments,
      department_dependencies,
      department_shifts,
      articles,
      components,
      article_bom,
      article_dept_dminus,
      component_rates,
    },
  }
}

/**
 * One order per quantity on the sheet.
 *
 * The sheet does not say which dispatches belong to one customer order, so
 * nothing here pretends to know: each cell is its own order with a single
 * shipment line, numbered by the row and column it came from so any figure on
 * screen can be traced straight back to a cell.
 */
export function buildOrders(sheet, prefix = 'SAMPLE-') {
  const orders = []
  sheet.rows.forEach((row, r) => {
    row.qty.forEach((qty, c) => {
      if (!qty) return
      orders.push({
        erp_order_no: `${prefix}R${r + 1}-D${c + 1}`,
        sku: row.sku,
        qty,
        stuffing_date: sheet.dispatches[c],
        container_ref: `Dispatch column ${c + 1}`,
      })
    })
  })
  return orders
}

/**
 * Every place the sheet gives a step the same day as, or an earlier day than,
 * something that feeds it — worked out from the sheet alone, so a caller can
 * check that Kram reports exactly these and no others.
 */
export function expectedConflicts(sheet) {
  const out = []
  for (const row of sheet.rows) {
    const days = daysByDepartment(sheet, row)
    for (const [feeder, department] of sheet.feeds) {
      if (days.get(department) >= days.get(feeder)) {
        out.push({ sku: row.sku, feeder, department, days: days.get(department) })
      }
    }
  }
  return out
}
