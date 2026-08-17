import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, select } from '@/lib/backend'

/**
 * Phase 4 — manpower.
 *
 * Two halves. The department arithmetic turns a shortfall in pieces into
 * overtime hours and people, and is a transcription of Module 2 of the client's
 * own prototype — proved against it in tests/engine-parity.test.ts rather than
 * asserted. The per-person half records who was actually there, and derives the
 * head count that capacity reads.
 */

export type OvertimeRow = {
  department_code: string
  department_name: string
  route_position: number
  load_date: string
  days_out: number
  utilisation: number
  over_fraction: number
  people: number
  hours: number
  ot_ceiling: number
  efficiency_pct: number
  ot_hours_per_person: number
  people_instead: number
  extra_people: number
  covered_by_overtime: boolean
}

export function useOvertimeAndHeadcount(runId: string | undefined) {
  return useQuery({
    enabled: Boolean(runId),
    queryKey: ['overtime', runId],
    queryFn: () =>
      select<OvertimeRow>('overtime_and_headcount', {
        eq: { run_id: runId },
        order: ['load_date', 'route_position'],
      }),
  })
}

export type ManpowerDay = {
  department_code: string
  department_name: string
  route_position: number
  shift_code: string
  sanctioned: number
  attendance_date: string | null
  present: number
  absent: number
  on_leave: number
  ot_hours: number
  people_on_ot: number
  unrecorded: number
}

export function useManpowerDay(date: string) {
  return useQuery({
    queryKey: ['manpower-day', date],
    queryFn: () =>
      select<ManpowerDay>('department_manpower_day', {
        eq: { attendance_date: date },
        order: ['route_position'],
      }),
  })
}

export type EmployeeDay = {
  emp_code: string
  name: string
  department_code: string
  department_name: string
  route_position: number
  shift_code: string
  skill_level: string
  attendance_date: string | null
  status: string
  ot_hours: number
  note: string | null
}

/**
 * Everyone in a department, with whatever has been said about the day —
 * including the people nobody has marked, who are the ones worth chasing.
 */
export function useEmployeeDay(departmentCode: string | null, date: string) {
  return useQuery({
    queryKey: ['employee-day', departmentCode, date],
    enabled: Boolean(departmentCode),
    queryFn: async () => {
      const rows = await select<EmployeeDay>('employee_day', {
        eq: { department_code: departmentCode! },
        order: ['emp_code'],
      })
      // employee_day carries a row per recorded date plus one null row for the
      // unmarked. Fold to one row per person for the day being looked at.
      const byPerson = new Map<string, EmployeeDay>()
      for (const r of rows) {
        const existing = byPerson.get(r.emp_code)
        if (r.attendance_date === date) byPerson.set(r.emp_code, r)
        else if (!existing) byPerson.set(r.emp_code, { ...r, status: 'unrecorded', ot_hours: 0 })
      }
      return [...byPerson.values()].sort((a, b) => a.emp_code.localeCompare(b.emp_code))
    },
  })
}

/**
 * Marking somebody re-derives the department head count, and the head count is
 * what resolve_capacity reads — so this moves the plan and re-runs it.
 */
export function useSetEmployeeAttendance() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      empCode: string
      date: string
      status: 'present' | 'absent' | 'leave'
      otHours?: number
      note?: string | null
    }) => {
      await rpc('set_employee_attendance', {
        p_emp_code: input.empCode,
        p_date: input.date,
        p_status: input.status,
        p_ot_hours: input.otHours ?? 0,
        p_note: input.note ?? null,
      })
      await rpc('run_schedule', { p_note: 'Recomputed after an attendance change' })
    },
    onSuccess: () => client.invalidateQueries(),
  })
}
