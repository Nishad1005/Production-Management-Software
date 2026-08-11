# Kram — project log

The running record of what this is, what has been decided and why, what bit us,
and what is still open. **Read this first** when picking the project up after a
gap. Update it whenever a decision is made, a defect is found, or something
changes state — the value is entirely in it being current.

Companion documents: [GUIDE.md](GUIDE.md) is how to *use* the software;
[../README.md](../README.md) is how to run and build it.

---

## 1. What this is

**Kram** (क्रम — *sequence*), production planning & control for **U&M Designs**,
built by **Data Brilliance Business Solutions LLP**.

| | |
|---|---|
| Specification | `DBBS/UM/KRAM/01` Rev B, 10 Aug 2026, status *For review* |
| Repository | `github.com/Nishad1005/Production-Management-Software` |
| Client domain | Export upholstered furniture — lounge chairs, sofas |
| Shipping | Containerised, 20ft / 40ft HQ, CNF terms |
| Client ERP | Panipuri — file export only, no API, no database access |

Kram schedules every open order **backwards** from its container stuffing date,
through a configurable department route, at **component** granularity, and flags
the days a department is asked to produce more than it can — *before* the date
is committed to the customer.

It does not decide. It reports load against capacity, shortfall in hours and
people, and the slack in the same window. Whether to run overtime, add people,
resequence or talk to the customer stays a production decision resting on
material, cash and customer relationships the system cannot see.

### Source material (archived in `docs/source/`)

| File | What it gives us |
|---|---|
| `concept-deck.pptx` | 19 slides. Client objectives, MD dashboard KPIs, 5-row Scope of Work, "Immediate Followups". |
| `capacity-modules-prototype.html` | **Working vanilla-JS implementation** of backward scheduling and the OT/headcount conversion. The reference the SQL engine is diffed against. |
| `um-item-master.csv` | 3,328 rows. Real SKU coding (`UNMPL/SKU/25-26/nnn`) and category tree. |
| `costing-sheet.xlsx` | Real BOM cost structure — wood, plywood, metal, spring, foam, fabric, packing, labour, CNF. |
| `item-code-definitions.xls` | Not yet parsed. |

---

## 2. Current state

| Phase | Scope | State |
|---|---|---|
| 0 | Masters, shifts, roles, RLS, working-day calendar | **Done** |
| 1 | Order book schema | **Done**. ERP import UI **outstanding** (blocked, §6) |
| 2 | Scheduling engine, planning outputs, acceptance check | **Done** |
| 3–10 | WIP, manpower, material, quality, machines, cost, command centre, predictive | Not started |

**Client**: six screens, all reading from database views. Editable: D-minus
matrix, component rates, department yield/route/headcount, holidays, orders,
shipment lines, and pins by dragging a schedule bar.

**Runs offline.** PGlite (Postgres 18 compiled to WASM) applies every migration
unmodified in the browser, so the demo runs the real engine with no backend.
`npm run build` produces a static folder.

**Online.** Supabase project `fiqfbbnmksppbpxmhnbv` — *kram*, Mumbai
(ap-south-1), Postgres 17.6. All seventeen migrations applied.

> **Migrations are append-only from here.** Editing one now means the file and
> the live database disagree, silently, until something breaks in a way that
> makes no sense.

**Auth is in.** Email and password, sessions, a Users screen for assigning the
twelve spec roles, and role-aware navigation. Accounts are created in the
Supabase dashboard — creating one needs the service role key, which bypasses
every access rule and must never reach a browser, so it is deliberately not an
in-app action. Assigning roles, which is what actually decides what anyone sees,
is.

The first admin is bootstrapped once via `supabase/bootstrap.sql` in the SQL
editor: only an admin can grant roles, so the first one cannot be granted
through the application.

`npm run dev` is offline; `npm run dev:hosted` reads `.env.hosted.local` and
talks to Supabase. Netlify picks the env vars up from its own environment, so
the deployed build is hosted the moment they are set — and not before.

---

## 3. Stack and environment

React 19 · TypeScript 6 · Vite 8 · Tailwind 4 · TanStack Query · react-router 8
· PGlite 0.5.4 (browser) · embedded-postgres 18.4 (tests) · Playwright (browser
verification) · Supabase CLI 2.113.

**The machine had none of the usual toolchain.** No Node, no Homebrew, no
Docker. Node v24.19.0 was installed via nvm (user-local, no sudo). `~/.zshrc`
loads nvm for interactive shells; `~/.zshenv` puts node on `PATH` for
non-interactive ones.

Docker's absence drove two decisions that turned out well on their own merits:
tests use a downloaded native Postgres binary rather than a container, and the
demo uses PGlite rather than a local Supabase stack.

`xlsx` is installed **from SheetJS's own CDN**, not npm. npm's `xlsx` is frozen
at 0.18.5 with two open CVEs; patched builds are only distributed by SheetJS
directly.

---

## 4. Decisions, and why

The *why* is the part worth keeping. Anything here that looks like an arbitrary
choice usually isn't.

**All logic lives in SQL.** The engine and every planning view are Postgres
functions and views. The same SQL runs in PGlite in the browser and on Supabase.
Nothing is reimplemented in TypeScript, so there is only one implementation of
the arithmetic to be wrong.

**The working-day calendar is pre-numbered.** `working_days` gives every working
day a dense sequence number, so "roll back N working days" is an indexed integer
subtraction rather than a walk. With ~40,000 tasks this is the difference
between seconds and minutes.

**Cumulative capacity instead of iteration.** With `cum(d)` the capacity up to
and including day `d`, the days a task occupies are exactly those `d <= due`
where `cum(d) > cum(due) - qty_required`, and the quantity on each is
`least(cap(d), qty_required - (cum(due) - cum(d)))`. That fills every day to
capacity and leaves the remainder on the earliest, with no loop anywhere.

**Calendar lookups return null outside the horizon.** `prev_working_day` used to
snap a too-late date to the last working day in the calendar. A date that snaps
is years wrong and looks entirely normal. Found by a test; now returns null so
it fails visibly.

**Utilisation is additive; units are not.** `component_rates.units_per_day` is
what a department makes in a day *doing nothing else*. Legs and covers cannot be
added — different things — but the fractions of a day they consume can. Every
view aggregates the ratio; over 1.0 is the flag.
→ **This is the convention PPC must enter real rates against.** Entering per-day
figures instead of dedicated ones makes a department demand three days of work
every day and look like the bottleneck when it isn't. It bit the seed data
first; a test caught it.

**`schedule_tasks` has no shift column** — a deviation from spec §11's table.
Days-needed is computed against capacity summed across active shifts, so a
per-shift task would have no meaningful duration of its own. The shift split
lives on `schedule_daily_load`, where it is real. *Flag this at spec review.*

**Runs are immutable.** Each run writes a new `schedule_runs` row and never
mutates an old one, so any past plan can be recovered and compared against what
happened. A partial unique index enforces exactly one `is_current`.

**Pins are honoured and reported, never undone.** A planner who drags a task has
made a decision the engine cannot see the reasons for. The reason is mandatory —
a pin without one is indistinguishable from a mistake six weeks later. Releasing
sets `is_active = false`; it never deletes.

**A blank D-minus blocks scheduling.** `article_dept_dminus.is_complete` is false
until a value is entered, and adding a department auto-seeds blank rows by
trigger. A silent zero would produce an impossible schedule that looks entirely
normal.

**Overlapping capacity overrides are refused** by a GiST exclusion constraint at
the same specificity. Two overlapping overrides would leave the engine silently
picking one. A department-wide and a component-specific override *may* overlap —
different specificity — and `resolve_capacity()` prefers the more specific.

**Order quantity reconciliation is a view, not a constraint.** Shipment lines
summing to the order total is surfaced as a warning; a hard trigger would block a
merchandiser entering the first of three phases, which is normal.

**RLS from the start, not retrofitted.** All twelve spec roles declared. Policy
helpers are `SECURITY DEFINER` with a pinned `search_path`, so a policy on one
table can consult `user_roles` without recursing through its own policy.

**Department-level costing only** (spec §10, when Phase 8 arrives). Per-order
labour costing needs every worker to log which order they touched — a discipline
shop floors reliably fail to sustain, and the point at which systems like this
get abandoned.

---

## 5. Gotchas — things that cost time

Keep adding to this. Each one was a real dead end.

| Symptom | Cause and fix |
|---|---|
| `extension "btree_gist" is not available` in PGlite | It ships as a contrib import: `import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'` and pass via `extensions`. |
| `.slice is not a function` on a date | The driver returns `timestamptz` as a **Date**, `numeric` as a **string**. Cast in SQL: `::text`, `::float8`. |
| `could not determine data type of parameter $3` | A parameter used only in `$3 is not null` has nothing to infer from. Cast it: `$3::integer`. |
| A save silently does nothing | react-query swallows mutation errors. Fixed globally with a `MutationCache` `onError` and a banner — never rely on a call site remembering. |
| Gantt bar refuses to drag | The 1px deadline marker sat on top of it. All decorations are now `pointer-events-none`. Took three wrong guesses; `document.elementFromPoint` gave the answer in one. |
| Dragging selects the row text | Use `select-none` on the row. **Not** `preventDefault` on pointerdown — that also suppresses the `pointermove` stream the drag depends on. |
| Tests deadlock | Files ran in parallel against one database, contending on the same master rows. `fileParallelism: false`. |
| Anon can call your functions on Supabase | Postgres grants `EXECUTE` to `PUBLIC` on every new function, *and* Supabase's default privileges grant it to `anon` explicitly. Revoking from `PUBLIC` alone leaves the explicit grant standing. Revoke from both. Tell the two apart by the error: "permission denied for **function**" means blocked at the door, "for **table**" means it ran until it hit RLS. |
| A Playwright check passes when the feature is broken | `getByRole(role, { name })` matches the accessible name by **substring** by default, so `name: 'Running'` also matches every `'Not running'`. Pass `exact: true` whenever one label is a substring of another. Cost a full diagnosis of a feature that was working. |
| `command not found: node` in a tool shell | The shell was started before `~/.zshenv` existed and does not reload it. Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`. |
| npm warns about uncovered install scripts | npm 11 gates them. `npm approve-scripts <pkg>`, then reinstall. Needed for `esbuild`, `fsevents`, `@embedded-postgres/darwin-arm64`. |

---

## 6. Open items and blockers

**Blocked on the client or on U&M:**

1. **The Rev B specification is not in the repo.** It reached the build truncated
   at ~50k characters, cutting off the tail of §19 and **all of §20 Open items**.
   Saving a truncated copy would ship an incomplete reference document, so
   nothing was saved. → Save the source document to
   `docs/kram-spec-rev-b.html` and reconcile §20 against this log.
2. **No real Panipuri export sample.** The import module is otherwise ready to
   build but would be built against an assumed column layout. **Longest-lead item
   on the critical path** — worth requesting now.
3. **The route is placeholder data.** Four departments from the prototype, not
   U&M's real seven, and every rate is invented. The arithmetic is right; the
   numbers are illustrative. Needs a working session with PPC, which is also the
   moment to explain the dedicated-rate convention (§4).

**Decisions the client owes us:**

4. **Per-employee vs aggregate attendance** (spec §8). Per-employee is what skill
   mix and leave management require, and is more entry. Must be settled with HR
   before Phase 4; `employees` already exists so it shapes what we seed.
5. **The overtime ceiling.** Five hours on top of an eight-hour net shift is long
   under the Factories Act's daily and quarterly limits, and multi-shift working
   adds its own provisions. The figure is configurable and is what the spec
   specifies. Their compliance adviser should confirm before go-live. *We flag,
   we do not advise.*

**On us:**

6. **Supabase project** — not created, nothing pushed. Deferred deliberately.
7. **Predictive features cannot come first** (spec §17). Cycle-time, lead-time and
   rejection models need roughly six months of accumulated actuals that do not
   exist. Worth putting to the client in writing now rather than at Phase 10.

---

## 7. Verification

Nothing here is trusted because it compiled.

**Parity against the prototype — the load-bearing check.**
`tests/engine-parity.test.ts` transcribes the algorithm from
`docs/source/capacity-modules-prototype.html`, which already works and which the
client has seen, then diffs the SQL engine against it cell by cell across the
prototype's own default scenario and five more. Zero divergence. Any difference
is a real defect in one implementation or the other.

**53 unit and integration tests** against a real native Postgres, booted per run
from an embedded binary. Covers schema shape, RLS (as the `authenticated` role —
table owners bypass RLS, so a policy test run as superuser proves nothing), the
working-day calendar, engine correctness, breaches, pins, overrides and the
planning views.

**Scale**, at the workload spec §11 states — 324 orders, two shipment lines each,
seven departments, three components, three shifts:
`13,608 tasks · 314,928 daily-load rows · 4.6 s`.
Note the task count is lower than the spec's ~40,000 estimate; three components
across seven departments gives 21 pairs. The row count matches. Worth checking
against the real route.

**Browser** — `npm run screenshot` drives all six screens plus four interactions
in headless Chromium and fails on any console error. It checks the D-minus edit
survives a reload, which is what proves it reached the database rather than only
React state. Three real defects came from this that the build was happy with.

---

## 8. What is next

1. **The real route and D-minus values.** Still the single change that would make
   the biggest difference to how the demo lands. Blocked on a session with PPC —
   and `docs/GUIDE.md` now covers saving the masters to a file afterwards, so
   that session's work is not held hostage by one browser.
2. **Supabase**, per the decision below: after the demo, before Phase 3.
3. **Phase 3 — WIP tracking.** The highest-value build from the concept deck.
   It replaces the daily-production Google Sheet (slide 18), unlocks six of the
   nine MD dashboard KPIs, and makes capacity self-correcting rather than
   asserted. Inherently multi-user, so it needs Supabase first.
4. **Articles and components as masters.** Currently seeded only; there is no way
   to add a new article without SQL. Lower priority than it sounds, since both
   arrive from Panipuri in the real system.

### Why the MD dashboard is not next

Slides 5–6 are the client's headline ask, and it is the wrong thing to build
now. Of its nine KPIs only three — orders running, delayed orders, containers by
stuffing date — can be computed from data that exists. OTIF, daily production,
WIP value, production efficiency, rejections and material shortages all need
actuals that arrive with Phases 3–6.

Shipping it with six invented figures would undermine every real number beside
them. It follows Phase 3.

### Deployment and Supabase timing

**Netlify, verified.** PGlite never touches `SharedArrayBuffer` or
`crossOriginIsolated`, so no COOP/COEP headers are needed — the usual blocker for
WASM databases does not apply. Largest asset is 10.1 MB against a 100 MB limit,
and `HashRouter` means no redirect rules. `netlify.toml` pins Node, sets the WASM
MIME type explicitly and caches fingerprinted assets forever.

Each first-time visitor downloads ~5 MB, because the database ships to the
browser. Acceptable for a demo; it disappears when Supabase takes over.

**Supabase: after the demo, before Phase 3.** The hard boundary is the WIP
ledger — one department declares output and the next accepts it, which cannot
work in a database living in one browser tab. Until then, offline is an
advantage: no accounts, no cost, and a build that runs from a folder.

### What going live actually needs

The schema, engine and API surface are ready — every read is a view and every
write a function, so nothing needs rewriting. What remains:

1. **The project.** Create it, `supabase link`, `npm run db:push`. All fifteen
   migrations apply unchanged; they have never been edited after being applied
   anywhere, so there is no drift to reconcile.
2. **A transport swap.** `src/lib/database.ts` currently sends SQL to PGlite.
   Add a Supabase implementation that calls `.from(view).select()` and
   `.rpc(fn)`, chosen by an environment variable. Both use the same views and
   functions, so the offline demo keeps working — useful for showing people
   without handing out logins.
3. **Auth.** A login screen, and admin screens for users and roles. RLS is
   written and tested but has never been exercised through the app, because the
   offline build runs as the owner.
4. **Real masters**, loaded from an export file (see `docs/GUIDE.md`).
5. **Netlify environment variables** for the project URL and anon key. The
   service role key never goes near the client.

Only steps 2 and 3 are real work. **Planning is usable by PPC and merchandising
the day that is done** — order acceptance, the schedule and the heatmap stand on
their own. WIP tracking makes capacity self-correcting, but it is not a
precondition for the planning half being used in anger.

---

## 9. Log

Newest first. One entry per working session — what changed, and anything a
future reader would not infer from the diff.

### 2026-08-11 — Auth, and masters as a portable file
Sign-in, sessions, a Users screen for the twelve roles, and role-aware
navigation. Accounts are created in the Supabase dashboard — creating one needs
the service role key, and an in-app button for it would mean an edge function
holding that key permanently for a task done a handful of times. Assigning
roles, which is what actually decides what anyone sees, is in the application.

`list_users` is SECURITY DEFINER because it reads `auth.users`, which the
authenticated role cannot see and should not. The admin check is inside the
function, and is the only thing between a signed-in user and everyone's email
address.

Masters export/import is no longer offline-only: export reads the master views,
import goes through `import_masters(jsonb)`. The file stays keyed by code rather
than internal id, which is what lets PPC's figures be entered in the offline
build and loaded into the hosted one.

### 2026-08-11 — Supabase is live, and anon could call everything
All seventeen migrations applied to `fiqfbbnmksppbpxmhnbv` (Mumbai, Postgres
17.6). They went on unchanged — the schema written against PGlite 18 and tested
against embedded Postgres 18 needed nothing altered for 17.6.

**Then the first probe found a real hole.** Calling `set_dminus` with nothing but
the anon key — which ships in the browser bundle by design — succeeded. RLS made
the write a no-op, so no data was exposed, but `run_schedule` and
`check_order_acceptance` do real work before RLS has anything to say: an
anonymous caller could have made the database schedule the whole order book,
repeatedly, for free.

Two migrations to close it, because the first was not enough. Revoking `EXECUTE`
from `PUBLIC` left Supabase's own explicit grant to `anon` in place. The error
message is what gave it away — "permission denied for *table* schedule_runs"
rather than "for *function* run_schedule" means the function was entered and ran
until it hit RLS. It now reads "for function", which is blocked at the door.

The test suite gained an anon lockout test, and `scripts/db/grants.sql` now
mirrors Supabase's grants so the revoke has something to bite on — otherwise the
test would pass against a database that never had the privilege.

Worth stating plainly: **this was found by probing the live project, not by a
test.** The whole suite was green throughout. Local Postgres and Supabase differ
in exactly the way that matters here — one ships with permissive defaults that
the other does not.

### 2026-08-11 — One interface, two backends
`src/lib/backend.ts` puts PGlite and Supabase behind the same narrow interface —
read a view, call a function — chosen by whether `VITE_SUPABASE_URL` is set. The
offline demo survives, which matters: it is the thing that can be shown with no
logins and no network, and it is what the browser suite drives.

Two defects the browser found that the type checker was happy with:

**The backends disagreed on types.** `numeric` arrives as a string over the wire
protocol and as a JSON number from PostgREST; `date` as a Date object or a
string. The client had been casting in each query; now the *views* cast, once,
so a screen cannot behave differently depending on where it runs. Every older
view had to be brought in line — the first browser run failed on
`peak_utilisation.toFixed is not a function`.

**Set-returning functions are a different call.** `select f(...)` yields one
column; `select * from f(...)` yields rows. PostgREST hides the distinction and
Postgres does not, so `rpc` and `rpcRows` are separate methods rather than one
that guesses.

### 2026-08-11 — The API surface: views to read, functions to write
Groundwork for Supabase, and the one thing genuinely blocking it.

The client had been sending ad-hoc SQL strings. That works against PGlite,
which executes anything, and **cannot work against Supabase at all** —
PostgREST exposes tables, views and functions, never arbitrary SQL. Ten reads
and fifteen writes would have had to be rewritten during the migration, which is
the worst moment to be rewriting queries.

So they were moved now, while both ends are still under test:
`schedule_kpis`, `run_history`, `heatmap_cell`, `load_detail`, `order_book`,
`department_master`, `shift_master`, `department_shift_grid`,
`component_rate_master`, `dminus_matrix`, `bom_master`, `pin_list`; and every
write became a function — `set_dminus`, `set_department_shift`, `create_order`,
`create_pin` and the rest.

Two things fell out of it beyond portability. The rules now sit next to the data
rather than in a client that will eventually be replaced — the D-minus
completeness rule and the rate-copying on shift activation are database
behaviour now, and are tested as such. And `tests/api.test.ts` carries a guard
that fails if raw DML reappears in `src/data`, because such a line would work
perfectly in the offline build and break the moment the backend moves.

Behaviour is unchanged: 72 tests and all fourteen browser steps green, before
and after.

### 2026-08-11 — What-if, masters export/import, Netlify
Scenarios as a first-class screen: a capacity multiplier over a window for one
department, run as a non-current version of the plan and compared against the
live one. The deck's three examples — machine downtime, overtime, a second
shift — are the same lever at 0, 1.2 and 2.0, so the form asks for the lever
rather than pretending they are separate features.

`run_what_if` applies temporary capacity overrides, runs the engine and takes
them straight back out, inside an exception handler so a failed run cannot leave
one behind masquerading as a capacity change nobody remembers making. Where a
*real* override already occupies the window, the scenario does not overwrite it —
the run records how much of the change actually applied, and the screen says so
rather than presenting a partial result as a whole one.

Masters export/import writes every master to a JSON file keyed by code rather
than internal id, so a file from one database applies to another. Two reasons:
it stops a cleared browser cache destroying a PPC data-entry session, and it is
how real data will seed Supabase.

**Closed a verification gap that had been open the whole project**: every browser
check until now ran against the Vite dev server, never the production bundle
Netlify would actually serve. Both are now checked. They agree — but that was an
assumption, not a fact, until it was tested.

Also fixed a spelling bug the screenshot caught and the test did not: the
comparison read "8 more breachs", because the plural was being derived by adding
an "s". Plurals are now passed in explicitly.

### 2026-08-11 — Shifts as a master
Shifts panel (net production hours, overtime ceiling, switch on/off) and a
department × shift grid with per-shift sanctioned headcount. Headcount editing
moved off the route table, where it had been quietly wrong: it wrote to *every*
active shift for a department at once, which is meaningless the moment a second
shift runs.

Switching a shift on for a department copies that department's component rates
and establishment across as a starting point. Without the rates the pairing
would show as running while adding no capacity whatsoever — the failure mode the
grid's "No rates" flag now catches. The copied figures are flagged estimated and
are wrong whenever the headcount differs; the panel says so.

Two engine tests pin the behaviour: capacity sums across active shifts (four days
of stitching becomes two), and a globally-active shift a department does not work
contributes nothing.

### 2026-08-11 — Editable draft
Masters editing (D-minus, rates, yield, route order, headcount, holidays), order
and shipment-line entry, and drag-to-pin on the schedule. Every write re-runs the
schedule. Three browser-only defects found and fixed (§5). Global write-error
banner added after discovering a failed save looked identical to a successful
one.

### 2026-08-11 — Offline-first client
Established that PGlite runs every migration unmodified, then built six screens
on it. Demo seed written to produce a scenario with something to say: overlapping
stuffing dates that push stitching over capacity, a late material date, a pin,
and quiet weeks either side so the idle report means something. Playwright
verification harness added.

### 2026-08-10 — Foundation and engine
Phase 0 schema with RLS, Phase 1 order-book schema, Phase 2 engine and planning
views. Parity harness against the prototype. Pushed to GitHub. Three defects
caught by tests before they shipped: the calendar horizon snap, a revoke being
undone by test grants, and npm's vulnerable `xlsx`.
