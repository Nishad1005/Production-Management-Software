import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, rpcRows, select } from '@/lib/backend'

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
      select<RunSummary>('run_history', {
        eq: { status: 'complete' },
        order: ['run_at desc'],
        limit: 30,
      }),
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
      rpcRows<ComparisonRow>('compare_schedule_runs', {
        p_base: base,
        p_scenario: scenario,
      }),
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
      rpcRows<ChangedTask>('compare_run_tasks', {
        p_base: base,
        p_scenario: scenario,
      }),
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
      return rpc<string>('run_what_if', {
        p_note: s.note,
        p_confidence: s.confidence,
        p_department_code: s.departmentCode,
        p_from: s.from,
        p_to: s.to,
        p_factor: s.factor,
      })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  })
}

export function usePromoteRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (runId: string) => {
      await rpc('promote_schedule_run', { p_run_id: runId })
    },
    // Promoting changes the live plan, so every screen has to reread.
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useDeleteRun() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (runId: string) => {
      await rpc('delete_schedule_run', { p_id: runId })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs'] }),
  })
}
