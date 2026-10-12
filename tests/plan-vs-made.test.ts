import { describe, expect, it } from 'vitest'
import { gridFromRows, stateOfDay, workingDaysBack } from '../src/lib/plan-vs-made'

/**
 * The shaping behind the Dashboard's planned-against-made picture. The view
 * does the arithmetic; this only arranges it, and the arrangement has rules
 * worth holding: Sundays are not columns, a day with output and no plan is
 * its own state, and seventy per cent is the line between amber and red.
 */
const row = (code: string, date: string, planned: number, made: number, rejected = 0) => ({
  department_code: code,
  department_name: code === 'STITCH' ? 'Stitching' : 'Cutting',
  route_position: code === 'STITCH' ? 100 : 90,
  work_date: date,
  qty_planned: planned,
  qty_good: made,
  qty_rejected: rejected,
})

describe('workingDaysBack', () => {
  it('skips Sundays and ends on the day asked for', () => {
    // 2026-10-12 is a Monday; six days back lands on the Tuesday before,
    // because Sunday the 11th is not a working day.
    expect(workingDaysBack('2026-10-12', 6)).toEqual([
      '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12',
    ])
  })
  it('skips a Sunday given as the end as well', () => {
    expect(workingDaysBack('2026-10-11', 1)).toEqual(['2026-10-10'])
  })
})

describe('stateOfDay', () => {
  it('names the five ways a day can go', () => {
    expect(stateOfDay(0, 0)).toBe('none')
    expect(stateOfDay(0, 12)).toBe('unplanned')
    expect(stateOfDay(100, 100)).toBe('met')
    expect(stateOfDay(100, 104)).toBe('met')
    expect(stateOfDay(100, 70)).toBe('behind')
    expect(stateOfDay(100, 69)).toBe('short')
  })
})

describe('gridFromRows', () => {
  const days = workingDaysBack('2026-10-12', 3) // 9, 10, 12 Oct

  it('lays departments down the side in route order and days across', () => {
    const grid = gridFromRows(
      [row('STITCH', '2026-10-09', 38, 30), row('CUT', '2026-10-12', 120, 120)],
      days,
    )
    expect(grid.departments.map((d) => d.code)).toEqual(['CUT', 'STITCH'])
    expect(grid.cells.get('STITCH')!.map((c) => c.state)).toEqual(['behind', 'none', 'none'])
    expect(grid.cells.get('CUT')!.map((c) => c.state)).toEqual(['none', 'none', 'met'])
    expect(grid.cells.get('STITCH')![0].ratio).toBeCloseTo(30 / 38)
  })

  it('leaves out days outside the window and keeps a day with output and no plan', () => {
    const grid = gridFromRows(
      [row('CUT', '2026-09-01', 50, 50), row('CUT', '2026-10-10', 0, 14, 2)],
      days,
    )
    expect(grid.departments).toHaveLength(1)
    const cut = grid.cells.get('CUT')!
    expect(cut[1]).toMatchObject({ planned: 0, made: 14, rejected: 2, ratio: null, state: 'unplanned' })
  })

  it('sums two rows for the same department and day rather than keeping the last', () => {
    const grid = gridFromRows(
      [row('CUT', '2026-10-12', 60, 30), row('CUT', '2026-10-12', 60, 30)],
      days,
    )
    expect(grid.cells.get('CUT')![2]).toMatchObject({ planned: 120, made: 60, state: 'short' })
  })
})
