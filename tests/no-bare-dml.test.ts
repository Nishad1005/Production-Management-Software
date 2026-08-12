// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withClient } from './helpers/db'

/**
 * Supabase preloads `safeupdate` for the roles PostgREST connects as, and it
 * refuses any UPDATE or DELETE whose plan carries no qualifier. Native Postgres
 * does not load it, so this cannot be caught by running the code — every other
 * test in this suite passed against an engine that had never once succeeded in
 * production.
 *
 * So it is checked by reading. Deliberately against pg_proc rather than the
 * migration files: migrations are append-only and three of them still contain
 * the bare statements they were later fixed by. What matters is the definition
 * that is actually installed, and a superseded one is not in the catalogue.
 *
 * `where true` does not count and would not help — the planner folds a constant
 * qualifier away and the plan reaches the library bare regardless.
 */

/** Statements that begin a DML write, with the position they start at. */
function bareWrites(body: string): string[] {
  // Comments can contain anything, including the word "where".
  const sql = body.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')

  const found: string[] = []
  // `update <table> [alias] set` and `delete from <table>`.
  //
  // SET is required rather than optional, which is what tells a statement from
  // `create trigger ... before update on %s` — attach_audit builds one of those
  // as a string, and a looser pattern reports it every time.
  //
  // The negative lookbehind skips `on conflict do update set`: an upsert clause
  // rather than a statement, and not something the library inspects.
  const starts =
    /(?<!\bdo\s)\bupdate\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?[a-z_]\w*)?\s+set\b|\bdelete\s+from\s+[\w."]+/gi

  for (const match of sql.matchAll(starts)) {
    const from = match.index
    const end = sql.indexOf(';', from)
    const statement = sql.slice(from, end === -1 ? undefined : end)
    if (!/\bwhere\b/i.test(statement)) {
      found.push(statement.replace(/\s+/g, ' ').trim().slice(0, 90))
    }
  }
  return found
}

describe('no UPDATE or DELETE without a WHERE clause', () => {
  it('holds for every function installed in public', async () => {
    const { rows } = await withClient((c) =>
      c.query<{ proname: string; prosrc: string }>(
        `select p.proname, p.prosrc
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
          order by p.proname`,
      ),
    )

    expect(rows.length).toBeGreaterThan(0)

    const offenders = rows.flatMap((fn) =>
      bareWrites(fn.prosrc).map((s) => `${fn.proname}: ${s}`),
    )

    // Named rather than counted, so a failure says which statement and where.
    expect(offenders).toEqual([])
  })

  it('recognises the two statements this test was written for', () => {
    // The engine's, which meant run_schedule had never run on Supabase.
    expect(bareWrites(`update _final set breach = 'x';`)).toHaveLength(1)
    // The calendar's, which meant no holiday could be added.
    expect(bareWrites(`delete from public.working_days;`)).toHaveLength(1)
  })

  it('does not flag a qualified write, or an upsert', () => {
    expect(bareWrites(`update t set a = 1 where id = 2;`)).toEqual([])
    expect(bareWrites(`delete from t where id = 2;`)).toEqual([])
    expect(
      bareWrites(`insert into t values (1) on conflict (id) do update set a = 1;`),
    ).toEqual([])
  })

  it('is not fooled by the word where appearing in a comment', () => {
    expect(
      bareWrites(`update t set a = 1; -- where it used to have a clause`),
    ).toHaveLength(1)
  })

  it('does not flag a trigger definition, which is not a statement', () => {
    // attach_audit builds exactly this as a string. The first version of this
    // test reported it, and a check that cries wolf is a check people turn off.
    expect(
      bareWrites(
        `execute format('create trigger %I before update on %s
           for each row execute function public.set_updated_at()', v_name, p_table);`,
      ),
    ).toEqual([])
  })

  it('still catches an aliased update, which the real fix needed', () => {
    expect(bareWrites(`update public.working_days w set seq = 1;`)).toHaveLength(1)
    expect(
      bareWrites(`update public.working_days w set seq = n.rn from n where w.d = n.d;`),
    ).toEqual([])
  })
})
