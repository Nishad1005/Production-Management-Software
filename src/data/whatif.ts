import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { query } from '@/lib/database'

/**
 * Scenarios and run comparison.
 *
 * Deliberately not using the `useWrite` helper from mutations.ts: that re-runs
 * the live schedule after every write, which is exactly what a what-if must not
 * do. Running a scenario writes a *non-current* run and leaves the plan alone.
 */

export type RunSummary = {
  id: string
  run_at: string
  note: string | null
  is_current: boolean
  task_count: number
  breach_count: number
  duration_ms: number | null
  what_if_department: string | null
  what_if_factor: number | null
  what_if_from: string | null
  what_if_to: string | null
  what_if_applied: number | null
  what_if_intended: number | null
}

export function useRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: () =>
      query<RunSummary>(
        `select id, run_at::text, note, is_current, task_count, breach_count,
                duration_ms, what_if_department, what_if_factor::float8,
                what_if_from::text, what_if_to::text,
                what_if_applied, what_if_intended
           from run_history
          where status = 'complete'
          order by run_at desc
          limit 30`,
      ),
  })
}

export type ComparisonRow = {
  department_code: string
  route_position: number
  base_utilisation: number | null
  scenario_utilisation: number | null
  utilisation_delta: number
  base_flagged_days: number
  scenario_flagged_days: number
  base_breaches: number
  scenario_breaches: number
}

export function useComparison(base?: string, scenario?: string) {
  return useQuery({
    enabled: Boolean(base && scenario && base !== scenario),
    queryKey: ['comparison', base, scenario],
    queryFn: () =>
      query<ComparisonRow>(
        `select department_code, route_position,
                base_utilisation::float8, scenario_utilisation::float8,
                utilisation_delta::float8,
                base_flagged_days, scenario_flagged_days,
                base_breaches, scenario_breaches
           from compare_schedule_runs($1, $2)`,
        [base, scenario],
      ),
  })
}

export type ChangedTask = {
  change: 'resolved' | 'new_breach' | 'changed_reason' | 'moved'
  erp_order_no: string
  line_no: number
  department_code: string
  component_code: string
  base_start: string | null
  scenario_start: string | null
  base_breach: string | null
  scenario_breach: string | null
}

export function useChangedTasks(base?: string, scenario?: string) {
  return useQuery({
    enabled: Boolean(base && scenario && base !== scenario),
    queryKey: ['changed-tasks', base, scenario],
    queryFn: () =>
      query<ChangedTask>(
        `select change, erp_order_no, line_no::int, department_code,
                component_code, base_start::text, scenario_start::text,
                base_breach, scenario_breach
           from compare_run_tasks($1, $2)`,
        [base, scenario],
      ),
  })
}

export type Scenario = {
  note: string
  confidence: string[]
  departmentCode: string | null
  from: string | null
  to: string | null
  factor: number | null
}

export function useRunWhatIf() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (s: Scenario) => {
      const rows = await query<{ id: string }>(
        `select run_what_if($1, $2::order_confidence[], $3, $4::date, $5::date, $6::numeric) as id`,
        [
          s.note,
          `{${s.confidence.join(',')}}`,
          s.departmentCode,
          s.from,
          s.to,
          s.factor,
        ],
      )
      return rows[0].id
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  })
}

export function usePromoteRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (runId: string) => {
      await query(`select promote_schedule_run($1)`, [runId])
    },
    // Promoting changes the live plan, so every screen has to reread.
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useDeleteRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (runId: string) => {
      await query(`select delete_schedule_run($1)`, [runId])
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  })
}
