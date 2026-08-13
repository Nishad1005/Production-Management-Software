# Kram — working notes for Claude

**Read [docs/PROJECT-LOG.md](docs/PROJECT-LOG.md) first.** It carries the current
state, every decision and why it was made, the gotchas that cost time, and what
is blocked on whom. [docs/GUIDE.md](docs/GUIDE.md) is the user manual.

**Keep both current.** After any session that changes state, makes a decision, or
burns time on a dead end, update the log — add a dated entry to §9, and put the
dead end in §5 so nobody pays for it twice. If a screen or a control changes, the
guide changes with it. A stale document is worse than none, because it is
believed.

## The short version

Production planning for U&M Designs, against specification `DBBS/UM/KRAM/01`
Rev B. Schedules every order backwards from its container stuffing date through a
configurable department **graph**, at component granularity, and flags the days a
department is asked for more than it can make. Departments run in parallel where
nothing connects them; `route_position` only orders the display.

Phases 0–3 are done. The client runs against either backend, chosen by whether
`VITE_SUPABASE_URL` is set: PGlite in the browser for the offline demo, Supabase
for the hosted system. Both use the same views and functions.

**Supabase is live.** Every migration is applied, and auth is in.

## Conventions that matter

- **All logic in SQL.** The engine and every planning view are Postgres functions
  and views, so the same code runs in the browser and on Supabase. Do not
  reimplement arithmetic in TypeScript — there should be one implementation to be
  wrong.
- **Cast in SQL, not in TypeScript.** The driver returns `timestamptz` as a
  `Date` and `numeric` as a `string`. Every query casts `::text` / `::float8`.
- **Utilisation is additive, units are not.** A rate is what a department makes
  in a day *doing nothing else*. Aggregate the ratio, never the raw quantity.
- **Failures must be visible.** A blank D-minus blocks scheduling rather than
  defaulting to zero; a calendar lookup past the horizon returns null rather than
  snapping; a failed write raises a banner. The recurring principle is that being
  wrong in a way that looks normal on screen is the worst outcome available.
- **Migrations are append-only.** The schema has been pushed to the live
  Supabase project (`fiqfbbnmksppbpxmhnbv`), so editing an existing migration
  now means the file and the database disagree. Add a new one.
- **`seed.sql` is the parity fixture — do not change it.** The demonstration
  data is `seed_demo.sql`, applied on top in the offline build only, and it is
  what the client sees. `tests/seed-demo.test.ts` covers it.
- **Migrations run before `seed.sql`.** A backfill that derives rows from another
  table gets nothing on a fresh database. Backfill for the live project *and*
  declare the same thing in the seed, or the two diverge silently.

## Verifying

- `npm run typecheck` — **not** `tsc --noEmit`. The root tsconfig is
  `"files": []` with project references, so `tsc --noEmit` type-checks *nothing*
  and exits 0. It hid a real error for several sessions.
- `npm test` — 198 tests against a real native Postgres, booted per run.
- `npm run screenshot` — drives every screen and interaction in headless
  Chromium and fails on any console error.
- `npm run verify:live [email password]` — access control against the live
  Supabase project, as real requests.

**Run `verify:live` after any migration touching privileges, policies or
functions.** The local suite cannot catch what it catches, twice over now:
every policy was green when a probe found the entire function API callable by
anyone holding the anon key; and 108 tests were green while `run_schedule` had
never once succeeded on Supabase, because it preloads `safeupdate` and the
engine held an UPDATE with no WHERE clause. Local Postgres and Supabase differ
in their defaults, and only production says how.

- **No UPDATE or DELETE without a WHERE clause**, anywhere, including temp
  tables. `where true` does not count — the planner folds it away and the plan
  arrives bare. `tests/no-bare-dml.test.ts` reads `pg_proc` and fails on one.

**Run the browser check before claiming a UI change works.** Three defects have
been found this way that a green build was perfectly happy with, all of them
things a user would have hit immediately. `document.elementFromPoint` is the
fastest way to find out why a click or drag is not landing.

`tests/engine-parity.test.ts` diffs the SQL engine against the client's own
working prototype. If it fails, one of the two is genuinely wrong — do not adjust
the expectation to make it pass.

## Environment

Node lives at `~/.nvm/versions/node/v24.19.0/bin`. Tool shells started before
`~/.zshenv` existed do not pick it up, so prefix commands with
`export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`. No Homebrew, no
Docker — both absences are worked around deliberately (see log §3).
