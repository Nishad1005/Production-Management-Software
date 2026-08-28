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
| Specification | `DBBS/UM/KRAM/01` Rev B — **no file exists**, see `docs/note-the-missing-specification.html` |
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
| 5 | Material — bill of materials, ordering dates, shortages | **Done** |
| 6 | Quality — defect causes, Pareto, counted yield against claimed | **Done** |
| 7 | Machines — the master, downtime, and capacity that follows it | **Done** |
| 8 | Money — the costing sheet as data, and money out by week | **Done** |
| 9 | Attention, the floor display, the flow map | **Done** |
| 10 | Prediction, with its evidence attached | **Done** |

**Client**: twenty screens, all reading from database views. Editable: D-minus
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
(ap-south-1), Postgres 17.6. All forty-seven migrations applied, the last on 23 Aug (§9).

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

**The documents drift, and nothing was checking them.** The log claimed fifteen
migrations when there were thirty-two, then thirty-seven when there were
forty-four; the README claimed fifty-three tests for a suite of nearly three
hundred. Every one was written by somebody who meant it. `tests/docs-are-current.test.ts`
now checks the migration count, the browser-check counts, and that every screen
in the navigation has a section in the guide — the claims that are facts about
the repository rather than prose. Proved by breaking each one on purpose. (19 Aug)


**`new Date().toISOString()` is UTC, and India is 5½ hours ahead.** Every screen
defaulting a date field to "today" returned *yesterday* between midnight and
05:30. Harmless-looking until Phase 7, where booking machine maintenance "today"
booked it for yesterday, the machine stayed available and capacity did not move.
`todayIso()` in `components/format.ts` returns the local date; use it. The
database still reads `current_date`, which is UTC on both backends, so the two
disagree for those 5½ hours — fixing that properly means giving the factory a
timezone. (18 Aug)

**Do not retype a long SQL function to add one thing to it.** Rewriting
`import_masters` by hand to add machines dropped `coalesce(headcount, 0)` and
flipped `coalesce(is_active, false)` to `true` — the first refused imports that
had always worked, the second would have switched on every shift on every
department and roughly doubled the factory, silently. Regenerate from the
previous text and insert the new block. (18 Aug)

**Wait on the thing you are about to assert, not on a neighbour of it.** A
browser check waited for a machine's row to show it was down, then read the
department summary — two different queries, and the summary was one refetch
behind. It reported seven of eight against a screen that was about to say six.
(18 Aug)


**Assertions written against rendered prose keep failing on working software.**
Six times now, in three shapes: a `\b` word boundary against `textContent`,
which runs cells together so "1" and "yes" become "1yes"; a case-sensitive match
against `innerText`, which *does* reflect `text-transform: uppercase`, so
"Articles routed" reads as ARTICLES ROUTED; and waiting for a panel that renders
only when it has data, on a database that correctly has none. Every one reported
a defect in a screen that was rendering exactly right. Anchor to `data-testid`,
attributes, or counted structure — never to a sentence. (17 Aug)

**`data-testid` on a custom component compiles and does nothing.** JSX does not
type-check hyphenated attributes, so passing one to a component that takes an
explicit prop list is silently dropped — it renders nothing and fails much later
as a click timing out on an element that never existed. `Button` takes a
`testId` prop instead, which the compiler checks. (17 Aug)


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

1. ~~**The Rev B specification is not in the repo.**~~ **Closed 17 Aug — it was
   never the client's to send.** The `DBBS/` prefix is our own numbering: the
   specification was written up here from the concept deck, inside a working
   session, and never saved to a file. There is no fuller copy to ask for. The
   concept deck *is* the requirements document and has been audited slide by
   slide (§9, 15 Aug). Recorded in `docs/note-the-missing-specification.html`
   so the ~120 section citations in the code do not send the next reader
   hunting for a document that does not exist.
2. **No real Panipuri export sample.** The import module is otherwise ready to
   build but would be built against an assumed column layout. **Longest-lead item
   on the critical path** — worth requesting now.
   **Asked for in `docs/request-panipuri-export.html` (DBBS/UM/KRAM/05)**, which
   also puts the question that decides the whole workflow: does Panipuri hold a
   stuffing date at all, or only a customer delivery date?
3. **The route is real; the figures are not.** Corrected 17 Aug — the live
   project carries U&M's fourteen departments and seventy-one SKUs, and has
   since the capacity sheet was imported. What is missing is every number in the
   994 cells: not one rate is entered, and two D-minus offsets exist in total.
   (The offline demo lays the same fourteen departments over invented figures;
   `seed.sql` keeps its four-department parity fixture, which is separate from
   both and must stay that way.) Needs a working session with PPC, which is also
   the moment to explain the dedicated-rate convention (§4).
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

**316 unit and integration tests** against a real native Postgres, booted per run
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

**Browser** — `npm run screenshot` drives eighteen screens plus thirty-one
interactions in headless Chromium and fails on any console error. It checks the
D-minus edit survives a reload, which is what proves it reached the database
rather than only React state. Forty-nine steps, three of them at other viewports — two phones and a 1920×1080 wall.
Several real defects came from this that the build was happy with.

Waits are named: `until('the article to become schedulable', …)` fails with that
sentence instead of `Timeout 60000ms exceeded`, which twice sent a debugging
session looking at the wrong stage.

**The hosted client in a browser** — `npm run dev:hosted` in one terminal, then
`npm run verify:hosted-ui [email password]`. Everything the offline browser
check does, it does against PGlite: it resets demo data and checks a returning
browser rebuilds its local database, neither of which exists on Supabase. So the
application had been driven in a browser hundreds of times and never once
against the backend U&M will use. **Read only, permanently** — it runs against
the client's production database, so nothing here adds an order, declares
production or edits a master. If a write ever needs proving against Supabase it
belongs on a scratch project.

**Access control against production** — `npm run verify:live`, after any
migration touching privileges, policies or functions. Local Postgres and Supabase
differ in their defaults in ways only probing the live project catches: anon
could call every function on it while all tests were green.

---

## 8. What is next

Rewritten 20 Aug, with phases 0–10 complete. Nothing on this list is a phase:
the software is built, and what remains is data, decisions and one deployment
setting.

**Interim figures can now go into the hosted project** so U&M's people can be
given accounts and something to argue with —
`node scripts/seed-live-interim.mjs <email> <password>`, and `--purge` to take
it out again. It writes through `import_masters`, the same path PPC's completed
workbook takes, so their sheet overwrites the rates cell by cell. A banner shows
on every screen for as long as it is loaded.

**Blocked on U&M** — two request notes are written and ready to forward:

1. **PPC's figures.** The single blocker. The live project holds the real route
   — fourteen departments, seventy-one SKUs — and not one rate against any of
   the 994 cells. Every date Kram produces is arithmetic on invented numbers
   until they arrive. `DBBS/UM/KRAM/04`, with the workbook from
   `scripts/make-capacity-workbook.mjs`. The what-feeds-what table from
   `DBBS/UM/KRAM/02` is still owed on top, and everything is read through it.
2. **The Panipuri export sample** (`DBBS/UM/KRAM/05`). Does not block going
   live — orders can be entered by hand — but it is the longest-lead item.
3. **A floor plan**, new: the factory map draws the route graph because nobody
   has given us a layout of the building. A real plan can be laid under it.
4. **Bills of materials and article costs**, both of which now have screens
   waiting for them and neither of which anyone has entered.

**Ours, before U&M's own people have accounts:**

5. **Point the deployed site at Supabase.** Netlify reads `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY` from its own environment; unset, the build is
   the offline demo.
6. **The signed-in half of `verify:hosted-ui`.** The anonymous half passes; the
   fourteen screens behind the login have been driven once, by hand.
7. **The roles decision.** Today every role reads everything. `kiosk` is now the
   one role with a genuinely narrow answer — the floor display and nothing else.

**Not built, and deliberately:** email and WhatsApp alerts (in-app first, and it
is the half that has to exist before a channel is worth wiring up), barcode and
QR, which the deck marks *Ideal*.

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

Rewritten 17 Aug. The version this replaces listed creating the Supabase
project, writing a second backend, and building auth — all three done weeks ago,
and it still said fifteen migrations when there are thirty-two. It had become a
list of finished work, which is the most misleading kind of plan.

**Done, and needing nothing further:** the project and every migration, the two
backends behind one interface, auth with roles and a Users screen, Netlify
building from `main`, and the whole planning half of the software.

**Blocked on U&M** — all three now have a request note in `docs/` written to be
forwarded as it stands:

1. **PPC's figures.** The single blocker. The live project holds the real route
   — fourteen departments, seventy-one SKUs — and not one rate against any of
   the 994 cells. Until they arrive, every date Kram produces is arithmetic on
   invented numbers. `DBBS/UM/KRAM/04`, with the workbook from
   `scripts/make-capacity-workbook.mjs`.
2. **The route confirmation** still owed against `DBBS/UM/KRAM/02` — what waits
   for what. Everything else is read through it.
3. **The Panipuri sample** (`DBBS/UM/KRAM/05`). Does not block going live —
   orders can be entered by hand — but it is the longest-lead item on the list.
   (The specification came off this list on 17 Aug: there is no document to ask
   for. See `docs/note-the-missing-specification.html`.)

**Ours, before U&M's own people have accounts:**

4. **Point the deployed site at Supabase.** Netlify reads `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY` from its own environment; unset, the build is
   the offline demo and every visitor gets a private copy of invented data. That
   is the right thing for a demonstration and the wrong thing for a factory.
5. **Drive the hosted client in a browser.** `npm run screenshot` has only ever
   run against PGlite — it resets demo data and checks a returning browser
   rebuilds its local database, both offline-only behaviours. `verify:live`
   proves the API answers correctly to real requests, and the client uses the
   same views and functions, but *the application itself has never been operated
   against Supabase by anything but a person clicking*. This project has twice
   found production broken while everything local was green; this is the same
   shape of gap and it is ours to close.
6. **Accounts, and the roles decision.** Accounts are created in the Supabase
   dashboard because creating one needs the service role key. Assigning roles is
   in-app. Before that happens, §6 item 6 needs an answer: today every role
   reads everything.
7. **The guide is missing two screens.** *My department* and *WIP* have no
   section in `docs/GUIDE.md` — the two screens a HOD and a merchandiser open
   daily. Fine for a demonstration, not for handover.
8. ~~**A backup answer.**~~ **Done 17 Aug.** *Save everything to a file* on
   Masters takes the order book and the production ledger as well as the
   masters. Still worth confirming what Supabase's own backups cover on the
   project's current plan — this is a copy U&M control, not a replacement for
   the platform's.

**Not needed to go live:** Phases 5–10 — material, quality, machines, money,
predictive — and article costs, which improve one dashboard KPI in proportion to
how much is filled in.

**Planning is usable by PPC and merchandising the day items 1, 2 and 4–6 are
done.** Order acceptance, the schedule and the heatmap stand on their own; the
WIP ledger makes capacity self-correcting but is not a precondition for the
planning half being used in anger.

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

**Both checks run, and one question closed.** `verify:live` passes on both
halves against an admin account — the four new views and five new functions are
unreachable with the anon key, and a signed-in planner can still edit masters,
run the schedule and rebuild the calendar. And the workbook generator answered
what this session could not: **the live project holds U&M's real route** —
fourteen departments, seventy-one SKUs, 994 cells, no rates entered against any
of them and two D-minus offsets. The sheet that goes to PPC is the real one.

**The article names came in rough, and are staying that way for now.** Of the
seventy-one, **fifty-seven repeat their own code in the name** — `125034299`
reads as *"125034299 Boden Dining Chair- Smokey Ta"* on the capacity sheet and
on every screen. **Twenty-three (`NPD-2501`–`NPD-2523`) have no description at
all**, the name being the code again. A handful are cut mid-word: *"Smokey
Ta"*, *"Sapphir"*, *"Reese Full/Queen Headboard - B"*.

None of this is the import's doing — name lengths run to fifty-six characters,
so nothing is being clipped in the pipeline. They arrived this way in U&M's own
capacity sheet. `set_article` would correct all fifty-seven by code in one pass,
and the decision was deliberately not to: the code is what PPC match on, the
names are cosmetic, and rewriting a client's product descriptions on their live
system to tidy a screen is not our call to make unasked. Written down here so
the next person to see a doubled code reads it as a known state rather than a
bug.

Generated workbooks are gitignored at the repo root. They are client product
data, regenerable in one command, and their whole life is being mailed out and
mailed back — a repository is the wrong place for that file.

**The specification does not exist, and never did as a file.** Nishad asked
what exactly was being requested, which was the right question to ask — the
answer turned out to be nothing anyone could send. `DBBS/` is *our* document
prefix, so `DBBS/UM/KRAM/01` was always ours to hold, and it was written up in a
working session from the concept deck and never saved. The log had recorded it
for a week as truncated at 50k characters and owed by the client. Both wrong,
and repeated in three documents before anybody checked.

The deck was then read properly rather than assumed: nineteen slides, no
speaker notes, nothing embedded, and **zero numbered sections anywhere in the
file**, so it cannot stand in for the ~120 `spec §n` citations across the
codebase. What it does carry is slide 18, *Immediate Followups for PPC
Software* — D-minus article-wise, article-wise capacity per day with average
manpower, manpower and overtime tracking. That is the capacity workbook, the
D-minus sheet and Phase 4, listed by the client themselves ten days before we
asked for any of it. Worth knowing when PPC ask why we want what we want.

`docs/request-specification.html` is gone; asking U&M for it made no sense.
`docs/note-the-missing-specification.html` replaces it as an internal note —
what happened, what the deck is and is not, how to recover what a section said
(`grep`; the citations mostly quote the sentence), and why the document is
**not** being reconstructed: one derived from the build cannot audit the build,
and it would read as a check that structurally cannot fail. The number `DBBS/UM/KRAM/03` was never free — the demonstration
script has held it since 12 Aug, and the deleted request note was the
duplicate.

The lesson is the familiar one in a new place. Every claim about §19 and §20
traced back to a single line written once and then quoted forward by everything
that followed, including three documents I wrote yesterday. The log is the
project's memory and that is exactly what makes an unverified line in it
expensive.

### 2026-08-23 — Interim figures, and the banner that stops them passing

The live project held U&M's route and nothing else — not one rate in any of the
994 cells, no orders, no production — which made it impossible to hand anybody
an account and ask what they thought. Interim data fixes that and creates
exactly the risk this software has been built against: an invented number that
looks normal.

**The live project is not production yet**, which is what makes this safe. It
holds no real transactional data, so there is nothing to contaminate — provided
what goes in can come out cleanly before U&M start entering anything real.

Three things make it come out cleanly, and two already existed.

**The masters overwrite themselves.** Rates and D-minus go in through
`import_masters` — the same function the Load-from-a-file button uses and the
same path PPC's completed workbook will take — upserting by code. Their sheet
replaces these cell by cell with nothing left behind, so there is no cleanup
step for them because none is needed. One call rather than two thousand round
trips, and a path that is already tested rather than one written for a script.

**The orders carry a prefix.** `PROV-`, and `purge_provisional()` deletes
exactly those; shipment lines, tasks and the whole production ledger cascade
from the order. It refuses when nothing is marked rather than deleting on a
guess — an order that happens to start with the prefix is not a licence.

**And it says so.** The offline build has said "Offline draft" on every screen
since Phase 1 and tags its rates ESTIMATED, because a figure nobody entered must
never look like one somebody did. The hosted system had no equivalent, and it is
the one people believe — real accounts, their own SKUs. `provisional_load` is
one row; while it exists the shell shows a banner across the top naming what
went in and how it comes out.

The demonstration seed marks itself the same way, which is both true — every
figure in it is invented — and the only way the banner gets browser coverage.

**The figures are crude on purpose.** One rate and one D-minus per department
across all seventy-one SKUs. A dining chair and an ottoman do not take the same
time at stitching, and anybody who knows the factory will say so within a minute
— which is the reaction wanted. A subtler set of invented numbers would be
likelier to be believed.

**Production stops short of the forecast threshold, deliberately.** Enough for
WIP, the department boards and quality to have something in them; fewer than ten
observations, so the forecast keeps saying *too few to say*. A measured rate
computed from invented output is the one number this software must never show.

### 2026-08-20 — Ready to show, once the script caught up

Asked whether everything was pushed for a client demonstration. The code was:
clean tree, `main` synced, forty-six migrations local and forty-six live.

Two things were worth checking rather than asserting. **`npm run build`** — the
command Netlify runs, and one this session had never run once in ten phases;
it succeeds, 18 MB, and the Postgres binary is most of it. Then the browser
suite against **`vite preview`** rather than the dev server: all forty-eight
steps pass against the actual built bundle, which is a stronger claim than any
made before and is what a client will load.

**The demonstration script was eight days and eight screens out of date.**
Written 12 Aug, it covered WIP, Production, the capacity sheet, Masters and the
dashboard, and mentioned none of Attention, Manpower, Material, Quality, Money,
Forecast, the factory map, My department or the floor display. Walking a client
through it would have shown a third of the software and skipped the parts
answering their own follow-up list.

Rewritten around what the software now does rather than around the order it was
built in: open on **Attention** so it tells them what is wrong, follow one order
through the factory, then show where the numbers come from and end on the empty
hosted capacity sheet — which makes the ask concrete and is the truth.
Forty-five minutes, with a `core` marking for a twenty-minute version.

Three things it now says that it could not before: the cost breakdown is
**their** costing sheet line for line and is the one screen where the figures
are genuinely theirs; Kram knows costs and not prices, said in the same breath
so nobody leaves thinking it does cash flow both ways; and the Forecast screen
refusing to state a figure is the feature, not an unfinished corner.

A numbering error corrected while there: `DBBS/UM/KRAM/03` was recorded on
17 Aug as freed by deleting the specification request. It was never free — the
demonstration script has held it since 12 Aug, and the request note was the
duplicate.

### 2026-08-20 — Phases 9 and 10: attention, a wall, a map, and a forecast that refuses

The last two phases, and the point at which the phase list runs out. Worth
saying plainly: the numbering came from the specification's §19, and that
document was established on 17 Aug never to have existed as a file. So what
these two phases *are* came from the concept deck, which does exist.

**The deck had an objective nobody had built.** Slide 2 lists five; the fifth is
"create alerts for timely response without getting into crisis points". Nothing
in Kram did it — every finding the software made required somebody to open the
right screen and look, which is fine on the day they think to look. The
`attention` view unions eight findings other views already reach and **computes
nothing of its own**; recomputing any of them would be a second implementation
to be wrong, and the two would disagree on screen with neither obviously at
fault.

**No dismiss button, deliberately.** An alert somebody can silence while it is
still true becomes wallpaper. The list stays readable by being short and
ordered, and every row links to the screen that makes it go away — the
difference between an alert and a complaint. If it proves unreadable in use,
that is evidence for building acknowledgement, not a reason to have built it
now.

**The `kiosk` role finally has a screen.** One of the twelve roles, described in
the code as "read-only department display", with nothing routed to it since
Phase 0 — the fifth built-and-tested thing to turn out invisible. `/display`
sits *outside* the Shell, because a masthead, a nav bar and a reference block
are four hundred pixels nobody standing ten feet from a wall can read. It
refreshes itself and remembers its department, so a screen that loses power
comes back showing the same thing.

**The factory map draws the route, not the building.** Nobody has given us a
floor plan, and a map is the one picture nobody checks against reality — a
guessed layout would be believed on sight. It draws what Kram knows: departments
by dependency depth, columns that genuinely run in parallel, coloured by their
worst day. Labelled on the screen as a flow map. A real plan is now an open item.

**Phase 10 was built through a disagreement, recorded here because it matters.**
I recommended measuring before modelling: the live project holds zero
declarations, and a model trained on nothing is a confident wrong one rather
than a cautious one. Nishad chose to build the models. They are built, with one
condition: **nothing states a figure without stating what it is based on**.
Under ten observations every view reports `too few to say` and shows the count.
The threshold lives in `forecast_threshold()` so it can be argued with in one
place. Risk is reported in bands, never a percentage — a percentage would be
read as a probability and would be a number invented to look like one.

The browser check asserts the refusal, which is the thing most likely to be
quietly removed later: four rates decline to guess on four declarations, and a
`measured` confidence on that data fails the step.

**A bug the browser found that the tests could not.** Two attention findings
came back with the same React key — one declaration owed to two departments
where the route forks. The uniqueness assertion existed and passed, because the
parity fixture is a single line and cannot fork. The test now runs against the
demo factory, and was proved to catch it by putting the bug back.

### 2026-08-19 — Asked whether the docs were current, and they were not

Everything was committed, pushed, and all forty-four migrations were on the live
project. The documentation was another matter.

The log said **thirty-seven** migrations. The README said the suite runs
**fifty-three** tests, against a real figure of two hundred and ninety. The
browser-check sentence said twenty-two interactions when it drives twenty-seven.
The guide, at least, covered all seventeen screens — which it did because it was
checked by hand twice, and that is precisely the problem.

Every one of those numbers was written by somebody who meant it at the time, and
each went stale the next time a phase landed. §5 has recorded since the schema
version incident that a comment asking somebody to remember is not a mechanism.
The counts in the documents were exactly that, and they had drifted the way
`SCHEMA_VERSION` did.

`tests/docs-are-current.test.ts` checks the three claims that are facts about
the repository rather than judgements: the migration count matches the files,
the browser-check counts match the script, and every screen in the navigation
has a section in the guide. It reads the numbers as words, because the documents
are written in words. Both failure modes were reproduced on purpose before being
trusted — a check that has never failed is not yet a check.

What it deliberately does not cover: the test count, which cannot check itself,
and prose, which no machine can verify. Those still need reading.

### 2026-08-19 — Phase 8: money, and the half it refuses to guess

Row five of the scope of work — payment schedule and cash flow planning. It
delivers the first and half of the second, and says which half out loud.

**Kram knows costs and not prices.** No order in Kram carries a value, so there
is no money coming in to plan against. The screen could have shown a cash-flow
chart with an invented revenue line and nobody would have queried it; that
would have been the most believable wrong number in the system. It says "this
is money out only" in the panel, not in a footnote.

**The cost structure is U&M's own, finally read rather than shelved.**
`costing-sheet.xlsx` has sat in `docs/source/` since day one. It is one article
costed in twenty-six lines — wood, plywood, metal, spring, belt, spring clips,
tie paper wire, hessian, dacking, non-woven, foam, fibre wadding, poly fibre,
thread, leather, piping, button, chain, chain puller, brass cup, packing,
labour, finishing, CNF, miscellaneous, other — totalling ₹16,759.71, which is
where the demo's article cost came from in the first place. That sheet is now a
table, and the demo carries it line for line.

**One number, one source.** An article's cost was a box somebody typed; it still
can be, and a bare total is a perfectly good thing to have while the detail is
collected. But where lines exist, `articles.unit_cost` is **derived from their
sum** — written back by the function that edits a line, because the capacity
sheet and the MD's WIP value already read that column and two ways to arrive at
a cost is how the two end up disagreeing on screen. Removing the last line
returns it to null rather than zero: zero is a claim that the chair is free.

**Money out counts what it cannot price.** A material with no rate is carried
with a null amount rather than dropped, and every weekly total reports how many
lines it could not cost. The alternative produces a smaller, tidier, wrong
number with nothing on screen to say so.

**Where the seed had to be moved.** Costing the article that is *in production*
made WIP value computable — and quietly deleted the best thing the MD's
dashboard does, which is refuse to invent a rupee figure and name the screen
where the cost goes. Two browser steps failed and were right to. The costing
sheet now sits on the Betsy chair, and the counter stool on the floor stays
uncosted until somebody enters one.

### 2026-08-18 — Phase 7: machines, and three ways to get it wrong quietly

Row four of the scope of work. A machine changes a day the way attendance does —
by scaling the standing rate — and the denominator is the one thing nobody has
to type: how many machines the department has. Four machines, one under
maintenance, three quarters of a day. Attendance and machines **multiply**, so
half the crew on half the machines is a quarter of a day; taking the worse of
the two would understate it and either alone would overstate it.

**A department with no machines recorded is left exactly as it was.** This is the
fourth time the project has had to keep "nobody has said" apart from "zero", and
the first time it cost nothing: `machine_availability` returns null rather than
1, so every caller has to decide what to do about not knowing. Had it returned
zero, the day this migration landed every department in the factory would have
gone to nothing.

`resolve_capacity` is the function every date in the system rests on, so the
test that matters most is the one proving what this does *not* do — and the
parity suite against the client's own prototype passed unchanged.

Machines travel in the masters file; downtime does not. The list is typed once
by somebody who walked the floor, which is exactly what that file is for.
Downtime is an event that happened in one database, and belongs in the backup
beside the production ledger rather than in a file merged on top of a live
system.

**Three defects, all mine, all quiet.**

*Rewriting a long function by hand.* `import_masters` needed one insert added
and got retyped instead, which dropped `coalesce(headcount, 0)` and flipped
`coalesce(is_active, false)` to `true`. The first refused an import that had
always worked. The second would have switched on every shift on every department
and roughly doubled the factory's capacity without a word. Regenerated from the
previous text with only the machines block inserted, and both are now tests.

*UTC.* `new Date().toISOString()` is five and a half hours behind India, so
every "today" default was yesterday until half past five in the morning. It had
been harmless on Production and Manpower; on Machines it meant booking
maintenance for today booked it for yesterday and nothing moved. `todayIso()`
now returns the local date. The database still reads `current_date`, which is
UTC on both backends — that divergence is recorded in §5 rather than pretended
away.

*Waiting on the wrong element.* A browser check waited for a machine's row to
flip and then read the department summary, which is a different query and was
one refetch behind. Seventh locator lesson in this file, and the first that was
about timing rather than text.

### 2026-08-17 — Phase 6: quality, and the bar nobody wants to see

Deck slide 17. The quantities were already there — `qty_good` and `qty_rejected`
have been two counts somebody can stand behind since Phase 3, and
`measured_yield` has put the counted figure beside the claimed one for as long.
What the ledger could not say is **why**.

That distinction carried the whole phase. Four rejected at stitching is a
number; four rejected because the fabric ran short of pattern is a purchase
conversation, and four because a needle was blunt is a maintenance one. So
defect types carry a **category chosen for who can fix it** — workmanship,
material, machine, design, handling — and nothing in this phase re-counts a
single piece.

**Attribution is deliberately allowed to be partial**, and the balance is a bar.
A supervisor who can account for six of ten rejects should not be made to invent
four, which is exactly what a hard requirement buys. `defect_pareto` carries
"Not attributed to a cause" as a line of its own rather than leaving it out of
the denominator, where every other cause would show a larger share and the
screen would look tidier and lie. The demo seeds it unexplained on purpose: a
demonstration where everything is accounted for hides the panel worth looking
at.

**What is refused is arithmetic, not judgement.** Attributing twelve causes to
ten rejects cannot be true, and it fails with both figures named —
`trim_scale` on the way out, because `numeric(14,3)` renders as "12.000 of only
10.000", which is accurate and reads like a machine complaining.

**A department that has declared nothing is absent from the table.** Zero
rejections and no reporting look identical on a screen and are opposite
findings — the same rule as an unmarked attendance day and an uncounted shelf.
Third time this exact distinction has decided a design, and it is now the
project's most reused idea.

### 2026-08-17 — Phase 5: material, and one number it refuses to invent

Second row of the client's own scope of work, and the phase that lights up
"Material Shortages" on the MD's dashboard with something better than a proxy.

**The whole phase rests on not calculating anything twice.** The engine already
knows what each department must make on each day, yield-inflated so the shipped
quantity survives every loss downstream. A material requirement is that number
times a figure from the bill of materials — so the compounding that took Phase 2
to get right is *inherited*. If wood must make 104 chairs' worth for 100 to
ship, the oak is for 104, and nobody has to remember why.

**Material is consumed by a department, not by an article.** Leather is needed
when cutting starts, ply when ply cutting starts. So the bill of materials
carries a department, and that is what turns a quantity into a date — the need
date is that department's own start, and the order date is that less the
supplier's lead time in **calendar** days, because a supplier does not observe
our factory holidays. This is exactly what slide 18 asks PPC for: *"material
ordering date to the supplier"*.

**Three stock states, kept apart.** Covered, short, and **nobody has counted
it**. The third is the one that matters: a material whose shelf has never been
counted is not a material there is none of, and reporting it as a shortage would
bury the real ones under a list of shelves nobody has got round to. Same
principle as a blank D-minus and an unmarked attendance day, and the same reason.

**A modelling bug the fixture caught and production would not have.** The first
version joined materials straight to `schedule_tasks`, which is per component —
and the parity fixture has wood making three components of one chair, so every
requirement came out tripled. The live capacity-sheet convention writes exactly
one component per article per department, so this would have looked perfect on
U&M's data and ordered three times the oak the day an article had two
components. It now aggregates to one row per department per shipment line,
recovering "how many chairs' worth" by dividing the task quantity by its own
bill-of-materials figure. Where two components in one department disagree the
larger is taken: buying too much is recoverable, being short is not.

**The materials themselves are real.** `costing-sheet.xlsx` was finally read
rather than shelved — wood, plywood, metal, spring, foam, fibre, fabric,
leather, packing are U&M's own cost lines, and its total of ₹16,759.71 is where
the demo's article cost came from. Suppliers, lead times, quantities per chair
and every stock figure are invented, and the seed says so.

**A test that passed alone and failed in the suite.** `limit 1` with no
`order by` returns whichever row the plan happens to produce, so an assertion
comparing against "the WOOD component" compared against a different one
depending on what else was running. Replaced with an aggregate. Worth
remembering: in a suite that runs files in parallel, an unordered limit is a
coin toss.

### 2026-08-17 — What nobody can type again

The last item on the go-live list that was ours. Masters have had a file since
Phase 1 and the schema is thirty-three migrations in git, so both are already
copied. **What a department declared it made on a Tuesday is in one Supabase
project and nowhere else** — and until today it could not leave the database at
all, because every view either aggregates the ledger or slices it by day. That
is the only data in Kram with no other source.

`supabase db dump` was the obvious route and is not available: it runs pg_dump
in a container, and this machine has no Docker (§3, deliberately). A script
would have been the next thought and is the wrong shape anyway — a backup only a
developer can run is a backup that does not happen. It is a button on Masters,
beside the masters file, where somebody already goes to save their afternoon's
work.

Five new views exist so the rows can leave: `declaration_list`,
`acceptance_list`, `attendance_list`, `department_attendance_list`,
`capacity_override_list`, plus `order_list` and one additive column on
`shipment_line_list`. All keyed by **natural keys** — order number, department
code, dates — never internal ids, which is the masters file's convention applied
to the order book. A uuid is meaningless the moment the database it came from is
gone, and that is the only situation this file is ever opened in.

Three decisions worth keeping:

**The acceptance goes in beside the declaration.** 90 declared, 84 counted in.
A copy carrying only what was declared would quietly settle an argument the
ledger exists to hold open.

**Attendance includes people who have since left.** `employee_day` filters to
active employees, which is right for a screen and wrong for a copy — somebody
who left in March still worked in February.

**There is no import for the transactional half, on purpose.** Masters upsert by
natural key and are safe to apply twice; a production declaration is an event,
and replaying events into a database that may already hold some of them is how a
factory ends up with a day it made twice. The UI says so in those words rather
than implying a restore button exists.

**A new gotcha, and a good one.** The browser step clicked
`[data-testid="backup-everything"]` and timed out on an element that was never
rendered: `Button` takes an explicit prop list and does not forward unknown
attributes, and **JSX does not type-check hyphenated attributes**, so
`data-testid` on a component compiles perfectly, renders nothing, and fails much
later as a click timeout. `Button` now takes a `testId` prop the compiler can
see. Worth remembering for every other component in `ui.tsx`.

### 2026-08-17 — The hosted client, in a browser, at last

`screenshot.mjs` has driven every screen hundreds of times and never once
against Supabase. It cannot: it resets demo data and checks that a returning
browser rebuilds its local database, and both of those are PGlite. `verify:live`
proves the API answers real requests correctly, which is a different claim from
the client rendering what comes back. Between them sat the session, the
PostgREST query layer, RLS filtering reads, and every screen's behaviour on a
nearly-empty database — the state U&M actually have today.

`scripts/verify-hosted-ui.mjs` closes it, and is **read only by construction**.
It runs against the client's production database, so nothing in it adds an
order, declares production or marks attendance. That constraint is written at
the top of the file rather than left to whoever edits it next: a check that
quietly seasons a live order book with `SO/26-27/0999` is worse than no check.

Two steps run without an account and both pass. The build is confirmed to be the
hosted one — reaching a login screen at all proves it, since the offline build
never shows one, and without that assertion the whole run could pass against
PGlite and mean nothing. And a wrong password is refused in the application's own
words.

Both of those steps failed first, and **both times the check was wrong rather
than the software**. The first looked for Supabase's "Invalid login
credentials"; the app deliberately rewrites that to "That email address and
password do not match", because a shop floor does not need the difference
between a wrong password and an unknown address and telling them would confirm
which addresses exist. The check now asserts the friendly wording *and* that the
raw string does not leak. The second tripped over a console error that was the
expected 400 from the auth endpoint — rejecting a login is a 400, and the
browser logs every non-2xx as an error, so the check was reporting the security
behaviour it was testing as a defect. `step()` now takes a narrow per-step
`allow` regex rather than a global mute.

Everything behind the login is still unverified; it needs an account.

**The guide covers all fourteen screens.** *My department*, *WIP* and *Users*
had no section at all — the first two being what a supervisor and a merchandiser
open daily, and the third being how anybody else gets an account in the first
place. Written from the code rather than from memory, which is how the phone
note turned out to be stale too: four screens are built mobile-first now, not
three, since Manpower joined them.

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
