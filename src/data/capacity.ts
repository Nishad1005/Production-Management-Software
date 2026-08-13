import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, select } from '@/lib/backend'

/**
 * U&M's capacity sheet: one row per article, two figures per department, plus
 * the D-minus offset that lives beside them in practice even though their
 * spreadsheet keeps it elsewhere.
 */

export type CapacityCell = {
  article_code: string
  article_name: string
  department_code: string
  department_name: string
  route_position: number
  units_per_day: number | null
  manpower: number | null
  dminus_days: number | null
  dminus_complete: boolean
  unit_cost: number | null
}

export function useCapacitySheet() {
  return useQuery({
    queryKey: ['capacity-sheet'],
    queryFn: () =>
      select<CapacityCell>('capacity_sheet', {
        order: ['article_code', 'route_position'],
      }),
  })
}

function useSheetWrite<TInput>(fn: (input: TInput) => Promise<void>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      await fn(input)
      // A capacity figure changes what the engine can do, so the plan follows.
      await rpc('run_schedule', { p_note: 'Recomputed after a capacity change' })
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

/**
 * Null units removes the pairing: the article does not pass through that
 * department. Across a 70 × 14 grid that is the common answer, and it has to be
 * sayable rather than merely left blank and ambiguous.
 */
export function useSetCapacityCell() {
  return useSheetWrite<{
    articleCode: string
    departmentCode: string
    units: number | null
    manpower?: number | null
  }>(async ({ articleCode, departmentCode, units, manpower }) => {
    await rpc('set_capacity_cell', {
      p_article_code: articleCode,
      p_department_code: departmentCode,
      p_units: units,
      p_manpower: manpower ?? null,
    })
  })
}

export function useSetCellDminus() {
  return useSheetWrite<{
    articleCode: string
    departmentCode: string
    days: number | null
  }>(async ({ articleCode, departmentCode, days }) => {
    await rpc('set_dminus', {
      p_article_code: articleCode,
      p_department_code: departmentCode,
      p_days: days,
    })
  })
}

/**
 * A cost moves no dates, so unlike a rate or a D-minus this deliberately does
 * not re-run the schedule — it only changes what one figure on the dashboard
 * says. Rescheduling the factory because somebody typed a price would be a
 * surprising amount of work for no change in the plan.
 */
export function useSetArticleCost() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({
      articleCode,
      cost,
    }: {
      articleCode: string
      cost: number | null
    }) => {
      await rpc('set_article_cost', {
        p_article_code: articleCode,
        p_cost: cost,
      })
    },
    onSuccess: () => client.invalidateQueries(),
  })
}

export type RouteConflict = {
  article_code: string
  article_name: string
  earlier_department_code: string
  earlier_department_name: string
  earlier_position: number
  earlier_dminus: number
  later_department_code: string
  later_department_name: string
  later_position: number
  later_dminus: number
  affects_scheduling: boolean
}

/**
 * Departments whose D-minus contradicts the route order — the later one has to
 * finish first. The engine compares each department against whichever sits at
 * the previous position, so this is what produces runway breaches that are not
 * real.
 */
export function useRouteConflicts() {
  return useQuery({
    queryKey: ['route-conflicts'],
    queryFn: () =>
      select<RouteConflict>('route_order_conflicts', {
        order: ['article_code', 'later_position'],
      }),
  })
}
