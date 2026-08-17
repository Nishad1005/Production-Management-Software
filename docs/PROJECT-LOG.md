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
| 3 | WIP tracking — declarations, two-sided handovers, measured yield | **Done** |
| — | MD dashboard, department boards, attendance-driven capacity | **Done** |
| 4 | Manpower — overtime and headcount arithmetic, per-person attendance | **Done** |
| 5–10 | Material, quality, machines, cost, command centre, predictive | Not started |

**Client**: fourteen screens, all reading from database views. Editable: D-minus
matrix, component rates, department yield/route/headcount, what feeds what,
holidays, orders, shipment lines, article cost, who came in — per person or as a
head count — and pins by dragging a schedule bar.

**The route is a graph, not a line.** `department_dependencies` says what must
finish before what; `route_position` only orders the display. The engine reads
ancestors for the runway check and descendants for yield, both restricted to the
departments an article actually passes through.

**Runs offline.** PGlite (Postgres 18 compiled to WASM) applies every migration
unmodified in the browser, so the demo runs the real engine with no backend.
`npm run build` produces a static folder.

**Online.** Supabase project `fiqfbbnmksppbpxmhnbv` — *kram*, Mumbai
(ap-south-1), Postgres 17.6. Thirty-two migrations applied, the last on 16 Aug (§9).

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
| A browser check breaks when a panel appears | An unanchored locator — `table` first match, `getByRole` by substring — silently retargets when the page gains an element. Anchor grids and controls by `data-testid`, and use `exact: true` on names. Twice now. |
| A Playwright check passes when the feature is broken | `getByRole(role, { name })` matches the accessible name by **substring** by default, so `name: 'Running'` also matches every `'Not running'`. Pass `exact: true` whenever one label is a substring of another. Cost a full diagnosis of a feature that was working. |
| `tsc --noEmit` passes and checks nothing | The root `tsconfig.json` is `"files": []` with project references, so plain `tsc --noEmit` type-checks **zero files** and exits 0. It hid a real error — a field named `qty_done` on a type that has `qty_good` — through several sessions of "tsc clean". Use `npm run typecheck` (`tsc -b --force`). |
| `UPDATE requires a WHERE clause` on Supabase, never locally | Supabase preloads the `safeupdate` library for the roles PostgREST connects as; native Postgres does not. Any UPDATE or DELETE whose **plan** carries no qualifier is refused — including on temp tables, and `security definer` does not help, because the library is loaded at connection time and does not care which role the function runs as. `where true` is not a fix: the planner folds a constant qualifier away and the plan arrives bare regardless. Restructure the statement. Caught by `tests/no-bare-dml.test.ts`, which reads `pg_proc` rather than the migration files, since append-only history still contains the fixed versions. |
| A model's assumption is hiding in a *second* place | The route being a line was obvious in the runway check and invisible in the yield window, which read as arithmetic rather than as a claim about the shop floor. When an assumption is found to be false, grep for every consumer before fixing the one that surfaced it. |
| A fixture that uses everything cannot see a bug about subsets | The seed's one article passes through all four departments, so yield-over-all-departments and yield-over-its-own-path give identical answers. 94 tests, none of which could tell them apart. When a test fixture uses the full set, add one that uses a subset. |
| "Make everything 44px" is wrong for a data grid | A heatmap cell is 14px wide because the point is seeing a month at once; thumb-sized cells would show a week. The rule applies to things people *operate*, not to cells they read. Mark deliberate exceptions with `data-dense-grid` so the check skips them by declaration rather than by a quietly generous selector. |
| A new element silently changes what an old locator means | Adding a cost box to the capacity sheet's row header made it the **first button in the row** — so the rate step went on typing its figure into the cost field and **kept passing**. Green, and testing the wrong thing. Anchor by `data-testid`; when adding anything to a shared container, grep for locators that index into it. Fifth instance. |
| A cleanup step that quietly does nothing | A browser step that mutates shared state has to *assert* it put things back, not assume. Otherwise the next step fails for a reason that has nothing to do with what it checks, and the hunt starts in the wrong place. |
| A hash navigation serves a stale query cache | `page.goto('#/other')` is same-document, so the app does not reload and React Query can still answer with the previous result for a moment. Wait for the expected text with `waitForFunction`; do not snapshot `innerText` immediately after navigating. |
| Two layouts in the DOM at once break every loose locator | Rendering a phone card and a desk row together means `input[type=number]` first-match, and even `text=…`, resolve to the *hidden* one — and `waitForSelector` then waits for it to become visible, forever. Scope to `:visible` and anchor by `data-testid`. Four separate steps broke this way in one afternoon. |
| The offline database never rebuilds for a returning browser | `SCHEMA_VERSION` was a constant with a comment asking whoever changed the schema to bump it. It stayed `'1'` through thirty migrations. Derive it from the SQL instead — a comment asking someone to remember is not a mechanism. Playwright cannot catch this: a fresh context per run means the version always mismatches and the database always rebuilds. |
| `indexedDB.deleteDatabase` silently does nothing | It can be **blocked** — by another tab, or a connection the previous page has not finished closing — and the request resolves either way. The old schema is then still there, the "is it built?" check finds it, and the rebuild is skipped. Clear the schema in SQL as well; that depends on nothing but the connection you hold. |
| `page.goto` does not reload the page | A URL differing only by its fragment is a same-document navigation, so the module never re-runs. `page.reload()` when the boot code is what you are testing. |
| A demo dataset that decays | Fixed dates in seed data quietly become a factory with nothing left to schedule, weeks after they were written. Seed relative to `current_date`. |
| A shipment line will not fit however far ahead you put it | Its maximum size is the tightest D-minus window it passes through multiplied by that department's rate — nothing to do with lead time. If the windows are narrow, "can we take this order" stops depending on the date, which is the one thing that screen is for. |
| A migration that reads a table finds it empty | Migrations run **before** `seed.sql`, so a backfill deriving rows from `departments` got nothing on a fresh database and silently produced a different model than the same migration does live. Backfill for the live project, and declare the same thing in the seed. |
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
   **Asked for in `docs/request-specification.html` (DBBS/UM/KRAM/03).**
2. **No real Panipuri export sample.** The import module is otherwise ready to
   build but would be built against an assumed column layout. **Longest-lead item
   on the critical path** — worth requesting now.
   **Asked for in `docs/request-panipuri-export.html` (DBBS/UM/KRAM/05)**, which
   also puts the question that decides the whole workflow: does Panipuri hold a
   stuffing date at all, or only a customer delivery date?
3. **The route is placeholder data.** Four departments from the prototype, not
   U&M's real seven, and every rate is invented. The arithmetic is right; the
   numbers are illustrative. Needs a working session with PPC, which is also the
   moment to explain the dedicated-rate convention (§4).
   **Asked for in `docs/request-route-and-figures.html` (DBBS/UM/KRAM/04)**, with
   a blank workbook from `scripts/make-capacity-workbook.mjs` to fill in. The
   what-feeds-what table from `DBBS/UM/KRAM/02` is still owed on top.

**Decisions the client owes us:**

4. ~~**Per-employee vs aggregate attendance** (spec §8).~~ **Settled 15 Aug:**
   U&M chose per-employee, entered on the floor, with overtime recorded as
   hours *worked*. Both exist — marking individuals derives the department head
   count rather than sitting beside it, because two ways to say how many people
   were in is how a wrong number ends up looking normal.
5. **The overtime ceiling.** Five hours on top of an eight-hour net shift is long
   under the Factories Act's daily and quarterly limits, and multi-shift working
   adds its own provisions. The figure is configurable and is what the spec
   specifies. Their compliance adviser should confirm before go-live. *We flag,
   we do not advise.*

**On us:**

6. **Which roles should read what.** Reads now require *a* role; beyond that,
   every role reads everything. Whether maintenance should see the customer
   order book, or store the commercial quantities, is the client's call. Worth
   settling before U&M's own people have accounts.
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

Since 15 Aug it covers **both** of the prototype's modules: the capacity and
load arithmetic, and the person-hour conversion that turns a shortfall into
overtime hours and people.

**233 unit and integration tests** against a real native Postgres, booted per run
from an embedded binary. Covers schema shape, RLS (as the `authenticated` role —
table owners bypass RLS, so a policy test run as superuser proves nothing), the
working-day calendar, engine correctness, breaches, pins, overrides, the route
graph and the planning views.

**Scale**, at the workload spec §11 states — 324 orders, two shipment lines each,
seven departments, three components, three shifts:
`13,608 tasks · 314,928 daily-load rows · 4.6 s`.
Note the task count is lower than the spec's ~40,000 estimate; three components
across seven departments gives 21 pairs. The row count matches. Worth checking
against the real route.

**Browser** — `npm run screenshot` drives every screen plus twenty-two
interactions in headless Chromium and fails on any console error. It checks the
D-minus edit survives a reload, which is what proves it reached the database
rather than only React state. Thirty-three steps, two of them at phone width.
Several real defects came from this that the build was happy with.

Waits are named: `until('the article to become schedulable', …)` fails with that
sentence instead of `Timeout 60000ms exceeded`, which twice sent a debugging
session looking at the wrong stage.

**Access control against production** — `npm run verify:live`, after any
migration touching privileges, policies or functions. Local Postgres and Supabase
differ in their defaults in ways only probing the live project catches: anon
could call every function on it while all tests were green.

---

## 8. What is next

1. **The full Rev B specification.** Open since day one and the only source Kram
   cannot be audited against — the copy that reached the build is truncated at
   ~50k characters, losing §20 *Open items* entirely. Everything else on this
   list is a judgement made without it.
2. **The real route and D-minus values.** Still the single change that would make
   the biggest difference to how the demo lands. Blocked on a session with PPC.
   `docs/GUIDE.md` covers saving the masters to a file afterwards, so that
   session's work is not held hostage by one browser.
3. **The Panipuri export sample.** The import module is otherwise ready to build
   but would be built against an assumed column layout. U&M say it will take
   time, which is the reason to have asked already.
4. **Article costs.** One box per article on the capacity sheet, and WIP value
   turns from "—" into rupees for as much of the floor as is filled in. Nobody
   is blocked on it; it improves one KPI in proportion to how much is entered.
5. **Phase 5 — material.** The next phase in the spec's own order, and the one
   the deck's "material shortage" alerts need.
6. ~~**Articles as masters.**~~ **Done 16 Aug.** Components are still seeded
   only, but the capacity sheet creates the one component per article per
   department that the engine actually plans, so nothing is blocked on it.

### Why the MD dashboard came last

*(Kept as written; it is now built, and the reasoning is why it took until Phase
3. Eight of the nine compute. WIP value reports itself unavailable and names
what it needs, rather than estimating a rupee figure from nothing — it is the
number an MD would quote first and the only one that would have been invented.)*

### The original note

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

### 2026-08-17 — Three asks, and a sheet PPC can actually fill in

Nothing left on the list is code. The three things still open are a document
someone holds, figures someone knows, and a file that does not exist yet — and
they have been described as bullet points in §6 for a week, which is not a form
anybody can act on. They are now three notes, one per audience, in the same
house style as the route confirmation already sent:

| Ref | File | For |
|---|---|---|
| `DBBS/UM/KRAM/03` | `docs/request-specification.html` | Whoever holds Rev B |
| `DBBS/UM/KRAM/04` | `docs/request-route-and-figures.html` | PPC |
| `DBBS/UM/KRAM/05` | `docs/request-panipuri-export.html` | Whoever runs Panipuri |

Each says what is needed, why it blocks, and what happens when it lands. The
PPC note carries the two things most likely to come back wrong in full: that
**units per day means this article and nothing else** — the everyday mixed
figure makes a department look like the bottleneck when it is not — and that
**manpower is the crew that rate was measured with**, without which attendance
changes nothing at all.

**PPC get a workbook rather than a screen.** Seventy articles across fourteen
departments is a long session at a machine they may not have, and they already
work in Excel. `scripts/make-capacity-workbook.mjs` reads whatever Kram holds
and writes the sheet in exactly the layout `import-capacity-sheet.mjs` reads
back, with the figures already entered filled in — so a second round arrives
carrying the first round's answers instead of asking again. A `D-minus` sheet
sits beside the capacity one; the importer now loads those offsets too, and
reports **how many articles would still be unschedulable after loading**, which
is the number PPC actually care about rather than a count of cells.

**Both directions of the file live in one module.** `scripts/lib/capacity-workbook.mjs`
holds the layout, and the generator and the importer share it. The failure this
prevents is the quiet kind: a generator and a parser one column apart produce a
workbook that imports without a single error and files every crew size as a
rate. Nothing raises, and the plan is simply wrong.

`tests/capacity-workbook.test.ts` round-trips the pair — nine tests, including a
blank staying blank rather than arriving as a zero, an old workbook with no
D-minus sheet still loading, and the whole journey through real Postgres into
`capacity_sheet`, where a figure written in the Stitching Units column has to
come out as Stitching's rate and not its crew size. That last one is the check
that could not be run against the live project from here, and did not need to
be: the schema is the same either way.

One thing the generator cannot answer for itself, so it says it out loud: if
the project still holds the placeholder route rather than U&M's real SKUs, the
blank sheet would ask PPC to fill in a factory that is not theirs. It warns
below ten articles rather than writing that file silently.

### 2026-08-16 — The last master that needed a developer

Articles have been seeded since Phase 0 with no way to add one without SQL. The
capacity sheet's own empty state has been saying *"add one from Masters"* for
four days, pointing at a control that did not exist.

It matters more than a missing form usually would. Everything hangs off an
article — its route, its D-minus offsets, its rates, its orders — so the one
thing nobody could do without a developer was the first thing anybody entering
real data would have to do. In the finished system articles arrive from
Panipuri, but that import is blocked on a file U&M say will take time, and the
PPC session that fills in the real route cannot wait for it.

`set_article` upserts by code, like every other master here: loading real data
is something you do more than once, and the second attempt should correct the
first rather than collide with it. Re-adding a code that was switched off brings
it back, because the alternative is a unique-violation on a row the sheet no
longer shows, which reads as a bug rather than as a decision.

**The panel leads with what is stopping each article being planned**, not with
its fields. A new article is inert until it has a route and its offsets, and
`article_master` says which of the two is missing — the same two conditions the
engine applies, rather than a third opinion about them. Silence there would read
as the software being broken.

**Switching an article off does not unplan the container already booked.** It
stops it being offered for new orders; orders already against it keep their
plan and their history. That is asserted rather than assumed — a test switches
one off, re-runs, and counts the tasks in the current run.

**The same locator bug, twice in two days.** The browser check polled
`/\byes\b/` against `textContent` and never matched, because textContent runs
the cells together — "1" and "yes" become "1yes", and the word boundary never
fires. Yesterday it was "11 in" running into "1 out". The row now carries
`data-routed`, `data-missing-dminus` and `data-can-schedule`, and the polling
reads those; the prose is asserted once, separately, because that is the half a
user actually reads. Waits are also named now: the failure says *"timed out
waiting for the article to become schedulable"* rather than reporting a bare
sixty seconds, which is what made both of these take longer than they should
have.

### 2026-08-15 — Phase 4: the shortfall said in hours and people

Started by auditing the concept deck slide by slide, because a phase that begins
by inventing scope tends to skip whatever the client already asked for. Nineteen
slides against what exists. Three findings, and the largest of them *was* Phase
4.

**The client's own prototype has a Module 2, and we had never implemented it.**
`capacity-modules-prototype.html` — "Overtime and headcount · person-hour
conversion" — turns a shortfall in pieces into overtime hours per person, then
into people when the overtime ceiling is reached. §1 of this document has
claimed since day one that Kram "reports load against capacity, **shortfall in
hours and people**". The first half was true. `engine-parity.test.ts`
reproduced Module 1 and stopped there.

Kram cannot use their formulas as written, and the reason is the same one that
shapes every planning view: their prototype gives a department one capacity in
units, and Kram's departments make several components. Units of legs cannot be
added to units of covers, so there is no single shortfall in units to put in the
numerator. Substituting their own `uph = capacity / (headcount × hours)` into
each formula cancels the capacity out, and all three reduce to the overload
fraction:

    otPer = (utilisation − 1) × hours / efficiency
    heads = ceil((utilisation − 1) × headcount)
    extra = ceil(headcount × ((utilisation − 1) − ceiling × efficiency / hours))

which is the same arithmetic in the one quantity Kram can add up. For a
department making a single component — the prototype's own case — they are
identically equal, and the parity test now proves that against the prototype's
default scenario rather than taking the derivation's word for it. Six parity
tests now, three per module.

**`employees` had existed since Phase 0 with nothing referencing it** but its own
RLS policies — the fourth built-and-tested thing found invisible, after
`capacity_overrides`, `wip_by_order` and `production_vs_plan`. The pattern is
consistent enough to be worth naming: work stops at the last green test rather
than at the screen. Two of the four were closed this session.

**Attendance is now per person, and derives the head count rather than sitting
beside it.** U&M chose the fuller scope: individuals, with overtime recorded as
hours *worked*, not hours the plan wishes for. `resolve_capacity` reads
`department_attendance` and nothing else, so `set_employee_attendance` writes
the individual row and then re-derives that number through the same
`set_attendance` the count screen uses. One input to capacity, two ways to
arrive at it. Marking somebody out moves what their department can make that
day, and the browser check proves it across two screens: mark Shabana Ansari out
on Manpower, and Today's capacity on Production reads 10 of 12 in — without
anybody typing it twice.

**Overtime is not offered on days that have gone.** The first version of the
screen listed every flagged day including last month's, each with a confident
"needs 15 more people". Days already past are real overload, but no amount of
overtime reaches them; they are a scheduling problem, and they now say so in one
line instead of twenty cards of advice nobody can take.

**`production_vs_plan` finally has a screen** — deck slide 11, built and tested
in Phase 3 and never once visible. It sits under the MD's KPIs: planned against
made, per department per day, with the full join intact so a day worked with
nothing planned reads as loudly as the reverse.

The demonstration roster is generated from each department's own establishment,
so the head count and the list of names cannot disagree. A screen that says
"9 of 10 in" beside eleven names is precisely the failure this project keeps
refusing.

Both migrations — `20260815090000_overtime_headcount.sql` and
`20260815090100_employee_attendance.sql` — are applied to the live project, and
`verify:live` now probes the four new views and three new functions: none of
them is reachable with the anon key. The signed-in half of that check still
needs somebody to run it with an account, which is the one thing this session
could not do for itself.

**A locator lesson, the sixth.** The browser check read a head count out of the
page with `/Stitching[\s\S]*?(\d+)\s+in\b/` against `textContent`, and it
matched a department six cards further down — `textContent` runs "11 in" straight
into "1 out", so `\b` never fires where `innerText`'s newline would have made
it. It now reads a `data-present` attribute. Numbers scraped out of prose keep
finding the wrong number, and the failure looks like a timeout rather than a
mismatch.

### 2026-08-12 — Phase 3: the WIP ledger

The first table in Kram that records what happened rather than what somebody
asserted. Everything before it — rates, yields, D-minus — is a claim; this is
what the factory did, and it is the only thing that can eventually contradict
them.

Two decisions, both the client's:

**Entries land on the scheduled job**, carrying their shipment line, so
actual-against-plan is a direct comparison and "where is order SO-1234" is
answerable. A department daily total would have been faster to enter and could
never have answered it — and WIP by order, OTIF and delayed orders are five of
the deck's nine dashboard KPIs.

**Handovers are two-sided.** The producing department declares; the department it
feeds counts in what arrived. The shortfall is kept rather than reconciled away,
because the count between two benches is exactly the thing people disagree about
and a ledger that cannot hold the disagreement is not a ledger.

**Who hands to whom is not derivable from components.** The capacity sheet writes
one stage component per article per department (`AARA-LC::STITCH`), so no
component is ever worked by two departments and a component-level handover finds
nothing at all. It comes from the route graph instead — restricted to the
departments that article passes through, then **transitively reduced** to nearest
neighbours. Without the reduction Ply Cutting hands over to everything downstream
of it, and a supervisor is asked to count in work from six benches that never
touched theirs.

Five views: `production_worklist` (the day's jobs with whatever has been said
about them), `wip_pending_acceptance`, `wip_by_order`, `production_vs_plan` — a
*full* join, so a day worked with nothing planned is as visible as the reverse —
and `measured_yield`, which puts the counted yield beside the one someone typed
on Masters. Nothing is corrected automatically: a master that edits itself is one
nobody can account for.

**A declaration deliberately does not re-run the schedule**, unlike every masters
edit. Rescheduling the factory because someone typed the morning's output would
move the plan under people all day, and the plan is what they are working to.

The Production screen does the two jobs in the order a supervisor does them:
count in what arrived, then write down what you made. It opens on today, which is
right — and a department with nothing planned today used to get an empty panel,
indistinguishable from a broken one. It now offers the days there *is* work,
which is also the first answer to "when am I busy".

Not built: **WIP value in rupees.** It needs a component cost master that does
not exist — `costing-sheet.xlsx` has never been loaded. Quantities are real;
money would have been invented.

### 2026-08-15 — The rest of the screens, on a phone

The last known gap. Measured all twelve at 390px before changing anything, which
was worth doing: **nothing scrolled sideways**, so the layouts were already
sound. What was wrong was smaller and everywhere — form controls at 35–38px
where a thumb needs 44.

Fixed at the source rather than screen by screen: `inputClass` and the `Button`
base now carry a mobile height and 16px text, dropping back to the desk sizes at
`sm`. Sixteen pixels specifically — below that, iOS zooms the whole page in when
a field takes focus, which is a worse bug than a small tap target because it
also moves everything else. That one change cleared five screens. Four
hand-rolled controls needed the same treatment: the what-if presets and
multiplier, the capacity sheet's measure switch, the production day chips, and
the release-pin button. Checkbox *labels* got the height rather than the
checkboxes, since the label is the target.

**The heatmap is the interesting one.** 2,674 of its cells are 18px, and making
them 44 would show a week where a month fits. Density is the feature. So it is
marked `data-dense-grid` with the reason in the attribute, and the check skips
what is inside it — a declared exception, visible in the source, rather than a
selector quietly generous enough to hide it. Its instructions said "Hover any
cell", which is nothing on a touch screen; now "Tap or hover".

A new browser step walks all twelve screens at phone width and fails on any
control under 44px or any page that scrolls sideways. Verified it can fail by
reverting `inputClass` and watching it name six offenders across three screens.

Screens that would actually be used on a phone read well now: **Accept an
order** — stacked fields and a full-width Check, which is a merchandiser taking
a customer call — and Production, My department and WIP, which were already
done.

### 2026-08-13 — A box, not a request for a spreadsheet

U&M: *"the page 33 summary will change as per article so i dont understand what
you want."* Fair. I had asked them to flatten seventy-one costing workbooks into
a twenty-five column sheet — for a feature they had already asked to defer. Two
mistakes: pressing on something set aside, and describing the maximum as if it
were the minimum.

The minimum was always **one number per article**. The category split only says
*where along the route* the value sits; for a headline figure, total cost × how
far through the route the work has got is enough, as long as the screen says
that is what it is.

So there is no ask any more. `articles.unit_cost` and an editable cell on the
capacity sheet, beside the D-minus and the rates where PPC already works. Never
required — blank means nobody has said, which is deliberately not zero, because
zero is a claim and the dashboard would believe it.

`wip_value` computes from whatever has been filled in, and **carries its
coverage**: "covering 1 of 3 lines in progress", or "all 1 lines in progress". A
rupee total that silently omits part of the floor is worse than none, and this
is the figure an MD quotes first. Unlike a rate or a D-minus, entering a cost
does not re-run the schedule — it moves no dates.

**Three checking failures came out of one small feature**, all in §5:

The cost box became the first button in the capacity sheet's row header, so the
*rate* step started typing its figure into the cost field — and went on passing.
A green check testing the wrong thing. Fifth time an unanchored locator has
moved under a new element.

The cleanup at the end of the new step silently did nothing, and the failure
surfaced two steps later as an unrelated assertion. Cleanups have to assert.

And the dashboard step read `innerText` straight after a hash navigation, which
is same-document — so React Query was still serving the previous answer. Waiting
for the text rather than snapshotting it fixed a race that would have been
blamed on the database.

### 2026-08-13 — WIP without a rupee, and a typecheck that checked nothing

U&M: *"What if we don't use cost as of now, since the main thing we want to do is
WIP — will that interfere with the things we have built?"*

**No, and it was worth checking rather than saying.** There is no cost, price,
value or amount column anywhere in the schema, and `₹` appears in exactly two
places: one row of `kpi_targets` and the branch in `Dashboard.tsx` that formats
it. Every figure built — declarations, two-sided handovers, remaining, measured
yield, the department board, eight of the nine KPIs — is a count.

**What the check turned up was worse than the question.** `wip_by_order` and
`measured_yield` were built in Phase 3, tested, given hooks in `src/data/wip.ts`
— and nothing rendered them. `production_vs_plan` never reached the data layer
at all. The one thing the client says they most want was computed, correct and
invisible for a fortnight.

So: a **WIP screen**. One card per shipment line, ordered by container, with the
route as a strip of segments — green complete, amber running, grey untouched —
and the departments underneath on expand. `wip_lines` folds the per-department
rows into per-line progress, weighting each department equally rather than by
quantity: a department making four legs a chair would otherwise dominate one
making a single cover, and neither is more finished than the other.

**`wip_units` added to the dashboard** — units on lines started somewhere and
finished nowhere. "Three containers, 550 chairs, part made." Needs nothing but
the ledger, and is now the tenth KPI.

**`wip_value` kept, and kept unavailable.** Deleting it would quietly drop
something the client asked for. Left in, it names the outstanding ask every time
the MD opens the screen — and its message is now specific, because their costing
sheet has been read properly: it is a per-product calculator whose **page 33 is
exactly the per-article category breakdown needed** (wood, plywood, foam,
fabric, packing, labour → ₹16,759.71 total). The ask is that summary block, one
row per article. Not 71 workbooks.

**And `tsc --noEmit` has been checking nothing.** The root tsconfig is
`"files": []` with project references, so it type-checks zero files and exits 0.
It passed on `r.qty_done` against a type that has `qty_good` — which reached the
screen as every quantity rendering as an em dash. Proven by putting the bug back
and watching `tsc -b` catch it and `tsc --noEmit` not. There is an `npm run
typecheck` now, and §5 has the row.

Third time this shape has appeared in three days: safeupdate, the schema version
constant, and now this. All three were checks that could not observe the thing
they appeared to cover.

### 2026-08-13 — What the client said, and production on a phone

The demonstration happened. Answers to the six questions, in their words:

1. **The capacity sheet is right.** Nothing missing.
2. **"Day rate is variable, can we give an option to put it in by the end
   user."** So a single dedicated rate per article and department is not a
   figure they can give us. It moves.
3. **"On a phone on the floor as it happens, as that will give us live data."**
   Production entry is mobile, on the floor, in real time — not a computer at
   the end of a shift.
4. **"We need receiving for double verification."** Two-sided handovers
   confirmed, which is what is already built.
5. **Dashboards per department.** Specified since, in their words: "what are the
   pending remaining for that day, work order or according to their shipping
   date, and from which department a component has to come so as to I can start
   my work." Three questions — what is left, in what order, and what am I
   waiting for. Built as **My department**: `department_queue` and
   `department_inbound`.

   The third is the one nothing could answer before, and it is the mirror of the
   acceptance queue — that says what has arrived, this says what has not, and
   names who owes it. Read off `article_handover`, so it follows the same edges
   the engine does rather than a second opinion about the route.

   Ordered by the **container**, not by the department's own deadline: a
   D-minus is derived and moves, a container sails when it sails.

   First version showed all sixteen outstanding feeders and was a wall — every
   future job reads "not started", which is not a problem, it is just not due
   yet. It now leads with what is actually late (`days_to_their_due <= 7`) and
   reduces the rest to a line of text. Two cards to chase instead of sixteen to
   read.
6. Deferred.

**Point 2, built.** All three of their reasons, and the order they resolve in is
the design: a figure someone typed for the day beats one worked out from a
headcount, which beats the standing rate. `department_attendance` records who
came in; `resolve_capacity()` scales the rate by present ÷ the crew that rate was
measured with. A rate with no crew size against it is left alone — there is no
ratio to apply, and assuming the sanctioned headcount would move every number on
screen silently. Which finally gives the capacity sheet's "missing manpower"
count a job: it is now the thing standing between attendance and having any
effect, and the production screen says so rather than offering a field that does
nothing.

U&M asked for anyone with a role to be able to enter it. That is a wide door and
it is theirs to choose; what makes it defensible is that every row carries its
author and an override will not accept a blank reason.

**Point 2 is nearly built already.** `capacity_overrides` has been in the schema
since Phase 0 — per department, per shift, per date range, with a mandatory
reason and an exclusion constraint refusing overlapping entries; and
`resolve_capacity()` already prefers it over the standing rate. It has never
been exposed in the UI. "Let the end user put the day rate in" is a screen, not
a schema change. Waiting on what exactly varies before building it.

**Point 3 is this session's work.** The UX skill the client asked for
(`ui-ux-pro-max`, MIT, installed under `.claude/skills/`) gives the rules —
44×44 targets, 8px spacing, `inputmode`, cards instead of wide tables. Measuring
Kram against them at 390px was the useful part:

- The masthead, description, reference block and a nav wrapping to three rows
  filled the first **780px**. The first job card began at y≈1180.
- The Rejected field and the Save button sat **off the right-hand edge**,
  reachable only by a sideways scroll with nothing to indicate it existed.
- Every touch target was under 44px — nav links at 32, inputs at 38.

Now: the chrome collapses to a name and one scrolling nav line on a phone, each
job is a card with two thumb-sized numeric fields and a full-width action, and
the first card starts at **y=272**. Every control measures ≥44px and the page
does not scroll sideways. A browser step at 390×844 asserts all three, so it
cannot quietly come back.

Rendering both layouts also broke four existing steps at once, all the same way
— see §5. Worth noting the shape: the fix for one screen size is what exposed
how loosely the checks for the other were written.

### 2026-08-12 — The offline database never rebuilt for anyone who had been here before

Found while setting up the demonstration: the capacity sheet came up empty on
localhost — *0 articles, 0 departments*. Not a mis-step in the script. The
browser was holding a database built weeks earlier.

`SCHEMA_VERSION` in `src/lib/database.ts` was a constant, with a comment asking
whoever changed the schema to bump it. `git log -S` says it had not moved since
the day the offline build was written — **thirty migrations and a complete
rewrite of the demonstration data ago**, including several changes I made to the
very seed it exists to protect, that same afternoon. A first-ever visitor got
everything; anyone returning kept what they had, permanently.

**No browser check could see it.** Playwright opens a fresh context per run, so
localStorage is empty, the comparison always mismatches, and the database is
always rebuilt. Twenty green steps over a build that was stale for every
returning user. The third time this shape has appeared — after `safeupdate` and
the masters file that carried departments but no edges — and the pattern is now
explicit: *ask what the check structurally cannot observe.*

It is derived from the SQL now (`src/lib/schema-version.ts`), so it changes when
and only when the schema or seed does. Removing the human step is the fix;
restating it in a comment is what failed.

Two more defects surfaced while writing a check that could actually fail:

**`indexedDB.deleteDatabase` can be blocked and still resolve.** Another tab, or
a connection the previous page has not finished closing, and the deletion never
happens — the request reports nothing. The old schema is then found by the
"already built?" query and the rebuild is skipped, so a browser that has decided
its database is out of date keeps it anyway. The teardown now also clears the
schema in SQL, which depends on nothing outside the connection.

**`page.goto` to a different fragment does not reload the page.** Same-document
navigation, so the module never re-runs — the check passed against boot code
that had not executed. `page.reload()` where the boot is the subject.

The new step was verified by pinning the version back to a constant and watching
it go red. A check that has never failed has not been tested.

### 2026-08-12 — A demonstration, and the factory it runs on

The client has seen none of this. The deliverable is a scenario to walk through
(`docs/demo-script.html`) plus the data that makes it land.

**The demo ran on a factory that was not theirs.** `seed_demo.sql` built a good
order book — three customers, orders clustered so the constraint appears, one
order shipping in two phases — on the four placeholder departments. U&M has
fourteen, and the first ten minutes would have gone on explaining why the screen
said "Wood". Rewritten onto their fourteen, the dependency structure PPC
confirmed, and six of their real article codes, with routes that differ per
article: a dining chair has no metalwork, an ottoman is fully upholstered so
nothing in it is sanded or lacquered. `seed.sql` is untouched — it is the parity
fixture.

Three things that only surfaced by building it:

**Parking the placeholders was not enough.** Two of seed.sql's codes — STITCH and
ASSY — are U&M's own, so those rows are reused rather than replaced and their
edges survive. One is `ASSY depends on STITCH`, which left Assembly waiting for
Stitching and showed up as a real finding on the capacity sheet.

**Dates are now relative to `current_date`.** Fixed dates would have quietly
become a factory with nothing left to schedule some weeks after they were
written — a demo that decays without anyone noticing until it is on screen.

**A shipment line can never be larger than its tightest D-minus window.** With
the first profile, 220 units was refused at every date, because Stitching had six
working days between its feeders' D-30 and its own D-24: 228 units, ever. So the
answer to "can we take this order" did not depend on the date at all, which is
precisely what that screen exists to show. Windows widened until contention
decides instead — 600 units is now refused at six weeks and accepted at nine.

**The masters file was losing the route graph.** `import_masters` and its export
predate `department_dependencies` and nobody went back, so the file carried
departments and not one edge between them. Applying it to a fresh database
rebuilt a factory where nothing feeds anything: no runway checks, and yield
collapsing to each department's own. `docs/GUIDE.md` tells people to save that
file after a session with PPC. The round-trip browser check passed throughout,
because it changes one number and asserts that number came back — which says
nothing about the fields it never looks at. Now carried, replaced rather than
merged (an edge's *absence* is an assertion, and a merge could never remove one),
and checked both in `tests/api.test.ts` and in the browser.

`tests/seed-demo.test.ts` is new and covers the demonstration data itself: it is
the only thing between a broken demo and finding out in front of the client.

### 2026-08-12 — The engine had never once run on Supabase

Found by the user, from a red line on the Masters screen: `run_schedule: UPDATE
requires a WHERE clause`. Supabase preloads the `safeupdate` library for the
roles PostgREST connects as, and refuses any UPDATE or DELETE whose plan carries
no qualifier. The engine's breach classification was `update _final set breach =
…` with no WHERE.

**`run_history` held zero rows.** Not "the graph broke it" — `run_schedule` had
failed on every call since the schema was first pushed, weeks ago. The central
function of the product had never once succeeded in production, and every screen
that reads a plan had been reading an empty table.

`rebuild_working_days` fails identically on `delete from public.working_days;`,
so adding or removing a holiday had never worked either. The calendar exists only
because migrations run as the table owner, whose session does not preload the
library. `security definer` does not help — the library loads at connection time
and does not care which role the body runs as.

**Nothing local could catch it.** Native Postgres does not load `safeupdate`, so
108 tests and 17 browser steps were green against a build that could not run at
all on Supabase. Exactly the shape of the anon-execute finding: local Postgres
and Supabase differ in their defaults, and only production tells you how.

Both fixes are structural, not a qualifier added to satisfy a check — `where
true` would not have worked, because the planner folds a constant qualifier away
and the plan reaches the library bare regardless. The breach classification moved
into the select that builds `_final` (one more CTE, since `available` is derived
there and so was not addressable until the table existed). The calendar's delete
is now scoped to the horizon being rebuilt, which is what its own comment already
claimed it did.

**Two checks added, because the bug was invisible rather than subtle.**
`tests/no-bare-dml.test.ts` reads function bodies from `pg_proc` — not the
migration files, which are append-only and still contain the bare statements
they were later fixed by — and fails on any UPDATE or DELETE without a WHERE.
And `verify:live` now *calls* `run_schedule` and `rebuild_working_days` rather
than only reading views. Reading a view proves the door is open; only calling the
function proves anything is behind it. Its first successful run: 49 ms, zero
tasks, because there are still no orders or rates on the live project.

### 2026-08-12 — The route is a graph, and yield was wrong because it wasn't

PPC confirmed the department order **and** that most operations run alongside
each other. That was the condition set the session before for building a route
graph rather than guessing at one, so it got built.

**The defect was bigger than the parallelism.** `route_position` carried two
jobs: the order departments are listed in, and the claim that each follows the
one before it. Two things rested on the second, and one of them was not the
runway check.

`_dept` computed cumulative yield with a window over **every active department**
and joined it to tasks without reference to the article. So a component was
charged the losses of every department further down the list — including ones
its material never enters. Visible in the four-department demo: a wooden leg is
made in Wood and goes into the chair at Assembly, never touching Fabric Cutting
or Stitching, and was inflated by all four yields. **433.7 legs a hundred chairs
where 412.3 was right — 5%.** Live, at fourteen departments and 98% each, the
head of the route inflates 33% where a six-department path warrants 13%:
quantities out by ~17%, carried into days-needed, utilisation and the bottleneck
ranking. The factory would have read as a third busier than it is.

That is one defect, not two. Yield compounds over "everything after this one",
and *after* is exactly what a line gets wrong.

**What was built.** `department_dependencies` — one row per edge, a trigger
refusing cycles, and a `route_dependency_grid` view behind a "What feeds what"
panel on Masters. The engine closes the graph once into `_reach` and reads both
directions off it: ancestors for the runway check (`max(due_date)`, so a
department with none waits for nothing), descendants for yield, **both
intersected with the departments the article actually passes through**.

**The safety property that made it landable.** The migration seeds the edges
linearly from `route_position`, which is arithmetically identical to what it
replaced for any article passing through every department — so the parity
harness and all 94 existing tests stayed green on the migration alone, with no
expectation edited. Numbers move only when someone declares parallelism. The
seed keeps its single line for the same reason: the prototype parity reproduces
is a single-line model, and a truer four-department graph would break the most
valuable test in the project to make a demo tidier.

**The guard had to move with it.** `route_order_conflicts` compared departments
consecutively by position and said so in its own comment — "because that is what
the runway check does". One migration later that was false, and it would have
reported pairs the engine never compares. It now walks transitive ancestors
(matching `max(due_date)`, which skips a blank D-minus and falls through to the
one behind it) and flags **equal** D-minus, which the old view let past even
though the engine raises a runway breach for it. A guard quieter than the thing
it guards is worse than none.

`scripts/apply-route-graph.mjs` holds the proposed structure — four entry points,
three streams converging at stitching, stapling and fitting. Our reading again,
not U&M's, and editable on Masters.

### 2026-08-12 — Route order: a note for PPC, and a guard
The 14-department route was loaded in an order **we inferred**, not one U&M gave.
Two things followed from that.

**A one-page note for PPC** — `docs/route-order-for-confirmation.html`, published
as a link to forward. The order with reasoning, the two questions that matter (is
this the sequence, and does anything run in parallel), and how to change it.
Written for a production manager: no schema, no jargon, and honest that the order
is a reading of the trade rather than anything they said.

**A guard**, `route_order_conflicts`, surfaced on the capacity sheet. The route is
a single line and the engine compares each department against whichever sits at
the previous position — so "must finish earlier ⇒ sits earlier" is load-bearing
and, until now, unenforced. Violate it and the engine holds work behind
something not yet due, raising runway breaches that are not real, on a screen
whose entire job is raising breaches.

Stated accurately, because I had overstated it: **`route_position` sets no
dates.** Due dates come from D-minus, start dates from capacity. Order affects
the runway comparison and yield compounding — so a wrong order gives wrong
*warnings*, not wrong dates.

The guard found a flaw in `capacity_sheet` while being tested: it decided
"routed" by looking for a stage component named `<article>::<department>`, which
is only how the sheet writes rates. An article broken into real components — a
leg, a stitched cover — is routed through a department with no stage component
at all, and read as unrouted. It now uses the engine's own test: does any
component of this article have a rate there.

A browser check failed for the same reason twice in this project now: **a
locator that took the first match moved when the page changed.** The warning
panel renders above the grid and brings its own table, so "first table" quietly
became the warning. The grid carries a test id now.

### 2026-08-12 — The real route, and the capacity sheet as a screen
`Capacity Sheet Final.xlsx` arrived: **14 departments**, not the seven the
specification estimated, and **70 real SKUs**. Every capacity figure blank — it
is the template PPC is meant to fill in.

Loaded into the live project. The placeholder route is retired (WOOD and FABCUT
deactivated; ASSY and STITCH kept, because they are the same departments under
the same codes). 71 articles, 994 article × department cells.

**The route order is proposed, not given.** The spreadsheet's column order is a
grouping — sanding before ply cutting, assembly second — which is not how
upholstered furniture is made. The order applied follows the trade: frame,
finishes, soft parts, upholstery, fitting, despatch. `route_position` decides
every date in the system, so this is the first thing for PPC to check, and it is
editable on Masters without touching code.

**Modelling.** The sheet is article × department; the specification is component
× department. The schema serves both, because nothing requires a component to be
a leg: a capacity cell creates a component standing for that department's work on
that article. If wood is later broken into four legs and a seat frame, those
components sit alongside and the engine treats them identically. `manpower` was
added to `component_rates` — the establishment on `department_shifts` is a
different thing from the crew size behind a particular rate.

Three things this surfaced, each the same shape as the customer gap before it:

- **`create_article` did not exist.** Same cause: the offline seed ships one
  article, so nothing ever needed to make another.
- **`create_department` did not upsert**, so loading a route twice failed on the
  second run. Loading real data is inherently repeated — the sheet comes back
  corrected — so it updates by code now.
- **Route positions are unique and the placeholders occupied the numbers the real
  route wanted.** Each RPC is its own transaction, so the constraint's deferral
  cannot help across calls; the importer parks everything existing in a spare
  range first.

The screen shows one measure at a time — units, manpower or D-minus. Three
numbers in each of 994 cells is not a grid anyone can read.

A green `0` under "Missing D-minus" was reading as *nothing missing* when the
truth was *nothing entered*: it counts what is absent from routed cells, and
there were no routed cells. It shows an em dash until something is routed.

### 2026-08-12 — A role-less account could read the whole factory
Signing in with an account holding **no roles at all** and reading it back:
component rates, the D-minus matrix, the bill of materials. Capacities, lead
times and product structure, to anyone with an account.

Every select policy said `to authenticated using (true)`. The application
refuses such an account and shows it a "no roles yet" screen — but a screen is
not a boundary, and the same request through the API answered happily. Orders
and customers carried the identical policy, so the whole order book with
quantities, dates and customer names would have gone the same way; there simply
were no orders yet to demonstrate it with.

Reads now require holding at least one role (`auth_has_a_role()`). Profiles are
deliberately exempt: an account with no roles must still read its own, or the
application cannot tell it why it is seeing nothing.

**Which roles should see what beyond that is a client question** — whether
maintenance has any business reading the customer order book, for instance. Not
guessed at here; recorded as open in §6.

The same probe found a second thing: **customers could not be created at all**.
The order form picks from a list and nothing anywhere could add to it, so on a
fresh database no order could ever be entered. The offline seed ships three
customers, which hid it completely — the feature worked in every test and in
every demo, and could not work for a real first user.

Both were invisible to a suite that seeds its own data. Worth remembering when
the next module gets a seed.

### 2026-08-12 — Access control checked against the live project
`npm run verify:live` checks access control over real requests against the real
project, because the local suite provably cannot catch what matters here — every
policy was green when a probe found the whole function API callable by anyone
holding the anon key.

Anonymous: ten for ten. Every view unreadable, every function uncallable, all
blocked at the door rather than inside.

Signed in as an admin + planner account: reads the masters, sees only its own
profile, can list users, can edit masters. Confirms the seed applied — four
departments — and that the Users screen works, since the roles were granted
through it.

**Then a restricted account found two more.** See the 12 August entry.

**Previously untested: a restricted account.** The escalation check is meaningless
for an account that is already an admin, and the script now says so rather than
reporting a pass. Spec §16's promise — that an HOD cannot reach another
department's data regardless of how the request is made — has not been exercised
live. The policies are unit-tested per role locally; what is unverified is
whether PostgREST and the grants agree with them.

A first version of that check reported ESCALATED against a working system,
because it did not look at the roles the account started with. A check that
cannot tell a feature from a hole gets ignored, which is worse than not having
it.

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
