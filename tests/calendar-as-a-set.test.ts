// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withRollback } from './helpers/db'
import { applySeed } from './helpers/fixtures'

/**
 * The three calendar helpers the engine calls once per task, against the
 * window expressions that replace them.
 *
 * `prev_working_day`, `next_working_day` and `working_days_between` are SQL
 * functions with sub-selects in their bodies, which the planner will not
 * inline, so each call is its own statement — forty thousand tasks is eighty
 * thousand statements, each paying the row-level policy once. The engine now
 * computes the same three answers as columns of one pass over `working_days`:
 * the running maximum of working dates (the day itself if it works, else the
 * last one before), the running minimum from the other end, and the dense
 * working-day sequence, whose difference is the count between two working
 * days.
 *
 * This proves the replacement for every date in the calendar and a month
 * beyond each end, where the functions answer null because there is no
 * calendar row — the behaviour the engine depends on to fail visibly rather
 * than snap to the horizon. Zero mismatches, or the engine is not allowed to
 * use the expressions.
 */

const WD = `
  select calendar_date, is_working, working_day_seq,
         max(case when is_working then calendar_date end)
           over (order by calendar_date rows between unbounded preceding and current row)
           as prev_working,
         min(case when is_working then calendar_date end)
           over (order by calendar_date rows between current row and unbounded following)
           as next_working
    from working_days`

describe('the calendar as a set', () => {
  it('rolls back and forward exactly as the functions do, inside the calendar and beyond it', async () => {
    await withRollback(async (c) => {
      await applySeed(c) // holidays in, so there are gaps to roll across
      const { rows } = await c.query<{
        dates: string
        prev_mismatched: string
        next_mismatched: string
        outside: string
      }>(
        `with wd as (${WD}),
         span as (
           select min(calendar_date) - 30 as lo, max(calendar_date) + 30 as hi
             from working_days
         ),
         probe as (
           select d::date as d
             from span, generate_series(span.lo, span.hi, interval '1 day') d
         )
         select count(*)::text as dates,
                count(*) filter (
                  where public.prev_working_day(p.d) is distinct from wd.prev_working
                )::text as prev_mismatched,
                count(*) filter (
                  where public.next_working_day(p.d) is distinct from wd.next_working
                )::text as next_mismatched,
                count(*) filter (where wd.calendar_date is null)::text as outside
           from probe p
           left join wd on wd.calendar_date = p.d`,
      )
      expect(Number(rows[0].dates)).toBeGreaterThan(60)
      expect(Number(rows[0].outside)).toBe(60) // the month beyond each end was really probed
      expect(rows[0].prev_mismatched).toBe('0')
      expect(rows[0].next_mismatched).toBe('0')
    })
  })

  it('counts the working days between two working days as the sequence difference', async () => {
    // Every ordered pair of working days inside a sixty-day window: a few
    // hundred pairs, every holiday and Sunday in the window crossed at least
    // once.
    await withRollback(async (c) => {
      await applySeed(c)
      const { rows } = await c.query<{ pairs: string; mismatched: string }>(
        `with w as (
           select calendar_date, working_day_seq
             from working_days
            where is_working and calendar_date between '2026-10-01' and '2026-11-30'
         )
         select count(*)::text as pairs,
                count(*) filter (
                  where public.working_days_between(a.calendar_date, b.calendar_date)
                        <> b.working_day_seq - a.working_day_seq + 1
                )::text as mismatched
           from w a
           join w b on b.calendar_date >= a.calendar_date`,
      )
      expect(Number(rows[0].pairs)).toBeGreaterThan(500)
      expect(rows[0].mismatched).toBe('0')
    })
  })
})
