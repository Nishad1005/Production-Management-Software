import { describe, expect, it } from 'vitest'
import { stateOf, stateOfAll, waiting } from '../src/lib/query-state'

/**
 * The four states a panel can be in, and their precedence. The one that
 * matters is `refreshing`: a query with an answer and a fetch in flight is
 * not `ready`, because a check that reads it now reads the old answer.
 */
const q = (isPending: boolean, isError: boolean, isFetching: boolean) => ({
  isPending,
  isError,
  isFetching,
})

describe('stateOf', () => {
  it('is loading while there is no answer, even though a fetch is in flight', () => {
    expect(stateOf(q(true, false, true))).toBe('loading')
  })
  it('is failed when the query failed', () => {
    expect(stateOf(q(false, true, false))).toBe('failed')
  })
  it('is refreshing when it has an answer and is fetching a newer one', () => {
    expect(stateOf(q(false, false, true))).toBe('refreshing')
  })
  it('is ready only when the answer is in and nothing is in flight', () => {
    expect(stateOf(q(false, false, false))).toBe('ready')
  })
})

describe('stateOfAll', () => {
  it('fails if any query failed, before anything else', () => {
    expect(stateOfAll(q(true, false, true), q(false, true, false))).toBe('failed')
  })
  it('loads while any query has no answer', () => {
    expect(stateOfAll(q(false, false, false), q(true, false, true))).toBe('loading')
  })
  it('refreshes while any query is re-reading', () => {
    expect(stateOfAll(q(false, false, false), q(false, false, true))).toBe('refreshing')
  })
  it('is ready when all are in and still', () => {
    expect(stateOfAll(q(false, false, false), q(false, false, false))).toBe('ready')
    expect(stateOfAll()).toBe('ready')
  })
})

describe('waiting', () => {
  it('is true for loading and failed, when the panel has nothing to show', () => {
    expect(waiting('loading')).toBe(true)
    expect(waiting('failed')).toBe(true)
  })
  it('is false for ready and refreshing, when the panel shows what it has', () => {
    expect(waiting('ready')).toBe(false)
    expect(waiting('refreshing')).toBe(false)
  })
})
