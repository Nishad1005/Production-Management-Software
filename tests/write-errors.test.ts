// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { friendlyWriteError } from '../src/lib/queryClient'

/**
 * The banner is read by people on a factory floor, and it appears at exactly
 * the moment somebody is being shown the software.
 *
 * These two messages are the ones the engine actually produces — a lock timeout
 * when two runs overlap, a statement timeout when one exceeds its ceiling. Both
 * were seen on the live project. Everything else passes through, because a
 * message nobody anticipated is the one most worth reading verbatim.
 */
describe('what the banner says', () => {
  it('explains a collision between two schedule runs', () => {
    const said = friendlyWriteError(
      'run_schedule: canceling statement due to lock timeout',
    )
    expect(said).toMatch(/schedule run that has not finished/i)
    // It must say nothing was lost. A planner who thinks a failed run left the
    // plan half-written will not press the button again.
    expect(said).toMatch(/nothing was changed/i)
    expect(said).not.toMatch(/lock timeout/i)
  })

  it('explains a run that exceeded its ceiling', () => {
    const said = friendlyWriteError(
      'run_schedule: canceling statement due to statement timeout',
    )
    expect(said).toMatch(/longer than the database allows/i)
    expect(said).toMatch(/nothing.*was changed/i)
  })

  it('leaves anything it does not recognise exactly as it came', () => {
    // The rule that keeps this from becoming a place where real errors go to be
    // softened into uselessness.
    const raw = 'new row violates row-level security policy for table "orders"'
    expect(friendlyWriteError(raw)).toBe(raw)
  })
})
