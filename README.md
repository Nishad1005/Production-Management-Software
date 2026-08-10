# Kram — production planning & control

Backward scheduling and capacity flagging for **U&M Designs**, built by Data
Brilliance Business Solutions LLP against specification `DBBS/UM/KRAM/01` Rev B.

Kram (क्रम — *sequence*) schedules every open order backwards from its container
stuffing date, spreads the work across the production route by component, and
flags the days on which a department is asked to produce more than it can.

> It does not decide. It reports load against capacity, shortfall in hours and
> people, and the slack available in the same window. Whether to run overtime,
> add people, resequence or talk to the customer stays a production decision.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Masters, shifts, roles, RLS, working-day calendar | **Done** |
| 1 | Order book (`customers`, `orders`, `shipment_lines`) | **Schema done**; ERP import UI outstanding |
| 2 | Scheduling engine, planning outputs, acceptance check | **Done** |
| 3–10 | WIP, manpower, material, quality, machines, cost, command centre, predictive | Not started |

The React client is a shell only — the screens are the next piece of work. Every
figure below is exercised by the test suite against a real Postgres.

## Getting started

Requires Node LTS (installed here via nvm; `~/.zshrc` loads it).

```bash
npm install
cp .env.example .env.local     # fill from the Supabase project API settings
npm run dev
```

| Command | Does |
|---|---|
| `npm test` | Boots a throwaway Postgres, applies every migration, runs 53 tests |
| `npm run build` | Type-check and production build |
| `npm run lint` | oxlint |
| `npm run db:push` | Apply migrations to the linked Supabase project |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` |

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

1. **The Rev B specification is not in the repo.** It reached the build
   truncated, cutting off §20 Open items. `docs/kram-spec-rev-b.html` is still to
   be saved from the source document.
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
