/**
 * The backward-scheduling algorithm as implemented in the capacity-flagging
 * prototype (docs/source/capacity-modules-prototype.html), ported line for line.
 *
 * This is not a second implementation written from the specification — it is a
 * transcription of code that already ran and whose output the client has seen.
 * Its whole value is being an independent check on the SQL engine, so it should
 * be changed only to track the prototype, never to make a test pass.
 *
 * Original, for comparison:
 *
 *   function back(due,qty,cap){
 *     var n=Math.ceil(qty/cap),out=[],d=new Date(due),D=[];
 *     while(d.getDay()===0){d.setDate(d.getDate()-1);}
 *     while(D.length<n){if(d.getDay()!==0){D.push(new Date(d));}d.setDate(d.getDate()-1);}
 *     for(var i=0;i<n;i++){out.push({date:D[i],qty:i===n-1?qty-cap*(n-1):cap});}
 *     return out;
 *   }
 */

/** Departments exactly as the prototype seeds them. */
export const PROTOTYPE_DEPTS = [
  { code: 'WOOD', name: 'Wood', dminus: 60, capacity: 40, headcount: 10 },
  { code: 'FABCUT', name: 'Fabric cutting', dminus: 50, capacity: 60, headcount: 6 },
  { code: 'STITCH', name: 'Stitching', dminus: 40, capacity: 30, headcount: 12 },
  { code: 'ASSY', name: 'Assembly', dminus: 25, capacity: 50, headcount: 10 },
] as const

/** The prototype's default order inputs. */
export const PROTOTYPE_ORDERS = [
  { id: 'A', qty: 100, stuffingDate: '2026-08-01' },
  { id: 'B', qty: 500, stuffingDate: '2026-08-10' },
  { id: 'C', qty: 250, stuffingDate: '2026-08-20' },
] as const

const MS_PER_DAY = 86_400_000

/**
 * Dates are handled as integer day counts rather than Date objects. The
 * prototype uses local-time Dates, which is fine in a browser in one timezone
 * and a source of off-by-one bugs in a test suite; counting days sidesteps it
 * without changing any arithmetic.
 */
function toDayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / MS_PER_DAY
}

function toIso(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** 0 = Sunday, matching Date.getDay(). 1970-01-01 was a Thursday. */
function dayOfWeek(day: number): number {
  return (((day + 4) % 7) + 7) % 7
}

export type Placement = { date: string; qty: number }

/** back(): the last `ceil(qty/cap)` working days ending at the due date. */
export function back(dueIso: string, qty: number, cap: number): Placement[] {
  const n = Math.ceil(qty / cap)
  let d = toDayNumber(dueIso)
  while (dayOfWeek(d) === 0) d -= 1

  const days: number[] = []
  while (days.length < n) {
    if (dayOfWeek(d) !== 0) days.push(d)
    d -= 1
  }

  return days.map((day, i) => ({
    date: toIso(day),
    // The earliest day carries the remainder; every later day is full.
    qty: i === n - 1 ? qty - cap * (n - 1) : cap,
  }))
}

export type LoadKey = string // `${departmentCode}|${isoDate}`

/**
 * Total planned quantity per department per day, across all orders — the figure
 * the prototype's grid colours and the SQL engine's schedule_daily_load must
 * agree with.
 */
export function referenceLoad(
  orders: ReadonlyArray<{ qty: number; stuffingDate: string }>,
  depts: ReadonlyArray<{ code: string; dminus: number; capacity: number }>,
): Map<LoadKey, number> {
  const load = new Map<LoadKey, number>()

  for (const dept of depts) {
    for (const order of orders) {
      const due = toIso(toDayNumber(order.stuffingDate) - dept.dminus)
      for (const placement of back(due, order.qty, dept.capacity)) {
        const key = `${dept.code}|${placement.date}`
        load.set(key, (load.get(key) ?? 0) + placement.qty)
      }
    }
  }

  return load
}
