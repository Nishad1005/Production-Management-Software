# Kram — production planning & control

[![Netlify Status](https://api.netlify.com/api/v1/badges/3fdc2989-0412-4fd3-8f3d-8997f0150a94/deploy-status)](https://app.netlify.com/projects/kraam/deploys)

Backward scheduling and capacity flagging for **U&M Designs**, built by Data
Brilliance Business Solutions LLP against specification `DBBS/UM/KRAM/01` Rev B.

Kram (क्रम — *sequence*) schedules every open order backwards from its container
stuffing date, spreads the work across the production route by component, and
flags the days on which a department is asked to produce more than it can.

> It does not decide. It reports load against capacity, shortfall in hours and
> people, and the slack available in the same window. Whether to run overtime,
> add people, resequence or talk to the customer stays a production decision.

## It runs with no backend at all

The whole application runs offline in the browser. PGlite is Postgres 18
compiled to WebAssembly, so the migrations, the scheduling engine and the
planning views are the *same SQL* that will run on Supabase — nothing is
reimplemented in JavaScript for the demo. On first load it applies the schema,
seeds a demonstration order book and runs the scheduler; state persists in
IndexedDB.

```bash
npm install
npm run dev          # http://localhost:5173 — no database, no accounts, no network
```

`npm run build` produces a `dist/` folder that runs from any static host. There
is no server to stand up and nothing to sign into, which is what makes it
practical to hand to someone and let them click.

The one thing offline does **not** exercise is row-level security: everything
runs as the owner, so policies exist but are never enforced. That is what
`tests/rls.test.ts` is for, against a native Postgres.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Masters, shifts, roles, RLS, working-day calendar | **Done** |
| 1 | Order book (`customers`, `orders`, `shipment_lines`) | **Schema done**; ERP import UI outstanding |
| 2 | Scheduling engine, planning outputs, acceptance check | **Done** |
| 3–10 | WIP, manpower, material, quality, machines, cost, command centre, predictive | Not started |

Screens: command centre, load heatmap, schedule, order book, order acceptance
check, masters.

Editable: the D-minus matrix, component rates, department yield, route order and
headcount, holidays, orders and shipment lines. Tasks are rescheduled by
dragging a bar on the schedule, which asks for a reason and writes a pin that
every later run honours. Any change re-runs the schedule, so its effect is
visible immediately rather than waiting for someone to remember to recompute.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | The app, offline, on port 5173 |
| `npm test` | Boots a throwaway native Postgres, applies every migration, runs the full suite |
| `npm run screenshot` | Drives every screen in headless Chromium and captures it |
| `npm run build` | Type-check and production build |
| `npm run lint` | oxlint |
| `npm run db:push` | Apply migrations to the linked Supabase project |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` |

Going online later is a change of transport, not of logic: the SQL is already
written and tested, and `supabase link && npm run db:push` applies it unchanged.

## How the tests work

There is no Docker on this machine, so the suite downloads a real Postgres
binary (`embedded-postgres`) and boots a cluster on port 54329 for the run. It
applies a small [auth shim](scripts/db/auth-shim.sql) standing in for Supabase's
platform schema, then every migration in order. Tests run inside transactions
that are always rolled back.

Policy tests switch to the `authenticated` role via `becomeUser()`. This matters:
table owners bypass RLS, so a policy test run as the superuser passes whatever
the policy actually says.

## The engine

`run_schedule()` is a pure function of the masters and the order book. It writes
a new `schedule_runs` row and never mutates an existing one, so any past plan can
be recovered and compared against what happened.

Two decisions keep it set-based, and so measured in seconds rather than minutes:

**A pre-numbered working-day calendar.** `working_days` gives every working day a
dense sequence number, so "roll back N working days" is an indexed subtraction
rather than a walk. `prev_working_day()` returns null outside the calendar
horizon rather than snapping to the last known day — a date that quietly snaps is
years wrong and looks entirely normal.

**Cumulative capacity.** With `cum(d)` the capacity available up to and including
day `d`, the days a task occupies are exactly those `d <= due` where
`cum(d) > cum(due) - qty_required`, and the quantity landing on each is
`least(cap(d), qty_required - (cum(due) - cum(d)))`. That fills every day to
capacity and leaves the remainder on the earliest, with no iteration anywhere.

Measured at the spec's stated workload — 324 orders, two shipment lines each,
seven departments, three components, three shifts:

```
13,608 tasks · 314,928 daily-load rows · 4.6 s
```

### Utilisation is additive, units are not

`component_rates.units_per_day` is what a department makes in a day at sanctioned
headcount **if it does nothing else**. So legs and covers cannot be added up —
they are different things — but the *fractions of a day* they consume can. Every
planning view aggregates the ratio. Utilisation above 1.0 is the flag.

This is the convention PPC must enter real rates against, and getting it wrong is
quiet: entering per-day figures instead of dedicated ones makes a department ask
for three days of work every day and look like the bottleneck when it isn't.

### Verification

The strongest check is parity against
[the capacity-flagging prototype](docs/source/capacity-modules-prototype.html),
which already works and which the client has seen. `tests/engine-parity.test.ts`
transcribes its algorithm and diffs the SQL engine against it cell by cell across
the prototype's own default scenario and five more. Any divergence is a real
defect in one implementation or the other.

## Layout

```
docs/source/     concept deck, prototype, item master, costing sheet
supabase/
  migrations/    schema, one concern per file
  seed.sql       placeholder route — the client replaces it
scripts/db/      embedded-Postgres harness, auth shim, grants
src/             React client (shell)
tests/           schema, RLS, calendar, engine, parity, scale, planning views
```

## Open items

All ten phases are built. What remains is data and decisions, not code — §8 of
the project log has the current list. Two items have a request note against them
in `docs/`, written to be forwarded as it stands —
`request-route-and-figures.html` and `request-panipuri-export.html`.

1. ~~**The Rev B specification is not in the repo.**~~ Closed 17 Aug: no such
   file was ever written. See `docs/note-the-missing-specification.html`.
2. **No real Panipuri export sample**, so the ERP import module is building
   against an assumed column layout. Longest-lead dependency on the critical
   path.
3. **The route is placeholder data** — four departments from the prototype, not
   U&M's real seven. Because departments are a configurable master this is not
   blocking, but D-minus per article × department is manual entry and needs a
   session with PPC.
4. **Five hours' overtime on an eight-hour net shift** is long under the
   Factories Act's daily and quarterly limits, and multi-shift working adds its
   own provisions. The ceiling is configurable and the figure is what the spec
   specifies; the client's compliance adviser should confirm it before go-live.
5. **Per-employee vs aggregate attendance** must be settled with HR before
   Phase 4.
6. **Predictive features cannot come first.** Cycle-time, lead-time and rejection
   models need roughly six months of accumulated actuals that do not exist yet.
