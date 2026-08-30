import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  exec as pgExec,
  getDatabase,
  query as pgQuery,
  resetDatabase,
} from '@/lib/database'

/**
 * Where the data lives.
 *
 * Two backends, one interface. PGlite runs Postgres in the browser for the
 * offline demo; Supabase is the hosted system real users share. Both speak to
 * the *same* views and functions, so a screen cannot behave differently
 * depending on which is behind it.
 *
 * The interface is deliberately narrow — read a view, call a function — because
 * that is all PostgREST offers. Anything wider would work offline and fail the
 * moment it went live, which is the whole failure mode this exists to prevent.
 */

export type Filters = Record<string, string | number | boolean | null | undefined>

export type SelectOptions = {
  eq?: Filters
  /** Inclusive bounds — a window of dates, mostly. PostgREST has both. */
  gte?: Filters
  lte?: Filters
  order?: string[]
  limit?: number
}

export type Backend = {
  readonly kind: 'offline' | 'hosted'
  /** Resolves when the backend can serve queries. */
  ready(): Promise<void>
  select<T>(view: string, options?: SelectOptions): Promise<T[]>
  /** Calls a function returning a single value. */
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  /**
   * Calls a set-returning function.
   *
   * Kept separate from rpc() because the two are genuinely different calls over
   * the wire protocol — `select f(...)` yields one column, `select * from f(...)`
   * yields the rows. PostgREST papers over the distinction; Postgres does not.
   */
  rpcRows<T>(fn: string, args?: Record<string, unknown>): Promise<T[]>
  /** Offline only — throws away local state and reapplies the seed. */
  reset?(): Promise<void>
}

// ---------------------------------------------------------------------------

class OfflineBackend implements Backend {
  readonly kind = 'offline' as const

  async ready() {
    await getDatabase()
  }

  async select<T>(view: string, options: SelectOptions = {}): Promise<T[]> {
    const params: unknown[] = []
    const conditions: string[] = []

    for (const [column, value] of Object.entries(options.eq ?? {})) {
      if (value === undefined) continue
      if (value === null) {
        conditions.push(`${quote(column)} is null`)
      } else {
        params.push(value)
        conditions.push(`${quote(column)} = $${params.length}`)
      }
    }
    for (const [op, filters] of [
      ['>=', options.gte],
      ['<=', options.lte],
    ] as const) {
      for (const [column, value] of Object.entries(filters ?? {})) {
        if (value === undefined || value === null) continue
        params.push(value)
        conditions.push(`${quote(column)} ${op} $${params.length}`)
      }
    }

    let sql = `select * from ${quote(view)}`
    if (conditions.length) sql += ` where ${conditions.join(' and ')}`
    if (options.order?.length) {
      sql += ` order by ${options.order.map(orderTerm).join(', ')}`
    }
    if (options.limit) sql += ` limit ${Number(options.limit)}`

    return pgQuery<T>(sql, params)
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { named, params } = callSignature(args)
    const rows = await pgQuery<{ result: T }>(
      `select ${quote(fn)}(${named}) as result`,
      params,
    )
    return rows[0]?.result as T
  }

  async rpcRows<T>(
    fn: string,
    args: Record<string, unknown> = {},
  ): Promise<T[]> {
    const { named, params } = callSignature(args)
    return pgQuery<T>(`select * from ${quote(fn)}(${named})`, params)
  }

  async reset() {
    await resetDatabase()
  }
}

// ---------------------------------------------------------------------------

class HostedBackend implements Backend {
  readonly kind = 'hosted' as const
  // Declared explicitly rather than as a constructor parameter property, which
  // erasableSyntaxOnly disallows — it is syntax that emits code rather than
  // types, so it cannot simply be stripped.
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async ready() {
    // PostgREST is there or it is not; nothing to warm up.
  }

  /**
   * PostgREST will not return more than a thousand rows, and says nothing when
   * it stops.
   *
   * The load heatmap asks for fourteen departments across a 174-day horizon —
   * 2,436 cells — and was handed the first thousand with no error, no header
   * anybody read, and a legend confidently reporting one over-capacity day
   * against the command centre's six. Roughly six departments of the fourteen
   * simply were not on the screen, and the screen looked entirely normal.
   *
   * No offline run could have caught it: PGlite has no such ceiling, so the
   * same code returns everything in the browser build. That is the second
   * structural blindness of this kind after row-level security, and the same
   * lesson — the hosted backend has to be exercised as itself.
   *
   * So: pages until a short page arrives. Callers that expect more than a
   * page should pass an `order`, because each page is a separate request and
   * therefore a separate snapshot; without one, Postgres is free to return
   * rows in a different sequence for page two and a row can be missed or
   * repeated at the seam.
   */
  async select<T>(view: string, options: SelectOptions = {}): Promise<T[]> {
    const PAGE = 1000
    // A page count nothing legitimate reaches, so a runaway pages loudly
    // rather than hanging the tab.
    const MAX_PAGES = 100

    const query = () => {
      let builder = this.client.from(view).select('*')

      for (const [column, value] of Object.entries(options.eq ?? {})) {
        if (value === undefined) continue
        builder = value === null ? builder.is(column, null) : builder.eq(column, value)
      }
      for (const [column, value] of Object.entries(options.gte ?? {})) {
        if (value === undefined || value === null) continue
        builder = builder.gte(column, value)
      }
      for (const [column, value] of Object.entries(options.lte ?? {})) {
        if (value === undefined || value === null) continue
        builder = builder.lte(column, value)
      }
      for (const term of options.order ?? []) {
        const [column, direction] = term.split(/\s+/)
        builder = builder.order(column, { ascending: direction !== 'desc' })
      }
      return builder
    }

    // A caller asking for a page or less gets one request, as before.
    if (options.limit && options.limit <= PAGE) {
      const { data, error } = await query().limit(options.limit)
      if (error) throw new Error(`${view}: ${error.message}`)
      return (data ?? []) as T[]
    }

    const rows: T[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE
      const { data, error } = await query().range(from, from + PAGE - 1)
      if (error) throw new Error(`${view}: ${error.message}`)
      rows.push(...((data ?? []) as T[]))

      if (!data || data.length < PAGE) return rows
      if (options.limit && rows.length >= options.limit) {
        return rows.slice(0, options.limit)
      }
    }

    throw new Error(
      `${view}: still returning rows after ${MAX_PAGES * PAGE} of them — ` +
        'refusing to keep paging. Narrow the query.',
    )
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args)
    if (error) throw new Error(`${fn}: ${error.message}`)
    return data as T
  }

  async rpcRows<T>(
    fn: string,
    args: Record<string, unknown> = {},
  ): Promise<T[]> {
    const { data, error } = await this.client.rpc(fn, args)
    if (error) throw new Error(`${fn}: ${error.message}`)
    return (data ?? []) as T[]
  }
}

// ---------------------------------------------------------------------------

/**
 * Named arguments, so the call matches Supabase's and Postgres can infer each
 * parameter's type from the function signature rather than needing a cast at
 * every call site.
 */
function callSignature(args: Record<string, unknown>) {
  const entries = Object.entries(args)
  return {
    named: entries.map(([name], i) => `${quote(name)} => $${i + 1}`).join(', '),
    params: entries.map(([, value]) => toParam(value)),
  }
}

/**
 * PostgREST takes a JSON array and casts it to whatever the parameter's type
 * is. The wire protocol will not: a JS string array arrives as text[], and
 * there is no implicit cast from text[] to an enum array, so the call fails.
 * Sending an array literal instead lets Postgres parse it as the declared type.
 */
function toParam(value: unknown) {
  if (!Array.isArray(value)) return value
  return `{${value.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')}}`
}

function quote(identifier: string) {
  // View and function names come from this codebase, never from user input,
  // but quoting costs nothing and keeps that true if it ever changes.
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function orderTerm(term: string) {
  const [column, direction] = term.split(/\s+/)
  return `${quote(column)}${direction?.toLowerCase() === 'desc' ? ' desc' : ''}`
}

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Hosted when the project details are present, offline otherwise. One
 * environment variable is the whole switch, so the offline demo keeps working
 * with no build flags and no dead code paths.
 */
export const isHosted = Boolean(url && anonKey)

export const supabaseClient: SupabaseClient | null = isHosted
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null

export const backend: Backend = supabaseClient
  ? new HostedBackend(supabaseClient)
  : new OfflineBackend()

/** Shorthands, so call sites read the same as they always did. */
export const select = backend.select.bind(backend)
export const rpc = backend.rpc.bind(backend)
export const rpcRows = backend.rpcRows.bind(backend)

/** Offline convenience for the seed path, which is PGlite-only. */
export async function execOffline(sql: string) {
  if (backend.kind !== 'offline') {
    throw new Error('Raw SQL is only available in the offline build')
  }
  await pgExec(sql)
}
