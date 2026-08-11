# Kram — how to use it

A guide to the software as it stands. Updated as screens are added; anything not
described here does not exist yet.

For what Kram is and how the build is put together, see
[PROJECT-LOG.md](PROJECT-LOG.md) and [../README.md](../README.md).

---

## What it does, and what it does not

Kram takes the order book and the factory's own figures — the route, how long
each article takes in each department, how much each department can make in a day
— and works **backwards** from every container stuffing date to tell you which
days a department is being asked for more than it can make.

It finds the problem. It does not choose the answer. Whether to run overtime, add
people, resequence, subcontract or move the date depends on material, cash and
the customer relationship, none of which the software can see. Every screen is
built to report, and to stop there.

---

## Starting it

```bash
npm run dev
```

Then open **http://localhost:5173**.

There is no database to install, no login and no network connection required.
Postgres runs inside the browser. The first load takes a second or two while it
starts and applies the schema; after that it is instant, and whatever you enter
is remembered between visits.

To hand it to someone else, `npm run build` produces a `dist/` folder that will
run from any static web host.

> **This is a draft for demonstration.** The route, the capacities and the orders
> are illustrative — the arithmetic is real, the numbers are not U&M's yet.

---

## The screens

### Command centre

Where to start, and the screen to open every morning.

**Run the schedule.** Choose which orders to include — confirmed only, confirmed
plus probable, or everything including forecast — and run it. Each run is saved
as a new immutable version, so an earlier plan can always be recovered and
compared against what actually happened; nothing is overwritten.

**The four figures** are shipment lines in the book, tasks scheduled, breaches,
and flagged days. A *breach* is work that cannot be made as planned. A *flagged
day* is a department-day asked for more than it can produce. They are different
things and both matter.

**Bottleneck utilisation** answers *which department is the constraint*. The
heatmap shows which days hurt; this shows which department is structurally the
problem across the whole horizon. Capacity above the bottleneck is decorative —
if stitching runs at 30 a day against wood's 40, the factory's real throughput is
30. This is the view that answers where the next person or the next machine
should go.

**Flag triage** sorts every flagged day by how much time is left and labels what
is still possible at that lead time:

| Lead time | Still possible |
|---|---|
| 45 days or more | Hiring |
| 15 to 45 days | Overtime, resequencing, subcontracting |
| Under 15 days | A conversation with the customer |

It is a label, not a recommendation. Its purpose is to turn a flat list of two
hundred flags into a triaged one.

---

### Load heatmap

Every department against every day, shaded by how much of the day the planned
work consumes.

| | |
|---|---|
| Pale green | Part loaded |
| Solid green | At capacity |
| Red | **Over capacity** |
| Outline | Idle — capacity available, nothing planned |
| Dashed | Closed — Sunday or a declared holiday |

**Click any cell** to see exactly which orders and components are on that day and
what share of the day each takes.

Idle days matter as much as flagged ones. Backward scheduling places work as late
as it can, so empty days often sit immediately before a breach — and a floor with
no idle days has no absorption left for the next rush order.

The horizon is usually wider than the screen; scroll sideways.

---

### Schedule

Every task as a bar, from its start date to the day it must be finished. The
vertical marker is that department's own deadline. Tasks are grouped by shipment
line, in route order.

- **Blue** — pinned by a planner
- **Green** — scheduled and feasible
- **Red** — breached, with the reason on the right

**Drag a bar to reschedule it.** You will be asked why, and the reason is
required: a pin without one is indistinguishable from a mistake six weeks later.
Once pinned, every later run works around that date and reports any breach it
causes rather than quietly putting it back.

Active pins are listed underneath with their reasons, and **Release** returns a
task to the engine.

Always filter — by department, by customer, or to breaches only. Rendering the
whole book helps nobody.

---

### Order book

Every order, with its shipment lines underneath. Click a row to expand it.

An order is not a single dated commitment. It ships in phases, and **each
shipment line is scheduled independently from its own stuffing date** — a
1,000-chair order leaving as 400 in August and 600 in September is two separate
backward schedules.

- **Add an order** creates the order and its first shipment line together.
- **Add a shipment line** adds another phase to an existing order.
- An **!** beside the line count means the lines do not add up to the order
  total. That is a warning, not an error — the first of three phases is a
  legitimate thing to have entered.

The **customer delivery date** is stored for reference and never used in any
calculation. The stuffing date is the only anchor.

---

### Accept an order

The most valuable screen in the product, and the one to show first.

Enter a proposed article, quantity and stuffing date. Kram schedules it
provisionally against everything already committed, reports which departments
break and why, and then removes it again — nothing is added to the order book.

Everything else in the system finds problems after the commitment. This finds
them before.

Quantities shown are inflated for yield: each department must make enough that
the shipped quantity survives every loss downstream of it.

---

### Masters

The figures every schedule run depends on. **Underlined values are editable** —
click one, type, press Enter. Every change re-runs the schedule immediately.

**Production route.** Departments in the order work flows through them. Yield is
the percentage that survives each step, and it compounds backwards: five
departments at 98% each cost roughly a tenth of factory capacity. Deactivating a
department never deletes it — one with history keeps it.

**Shifts.** Each shift's clock hours, its **net production hours** — time
actually available for work, excluding breaks, setup and cleanup — and its
overtime ceiling per person. The capacity maths uses the net figure, never the
clock span. A shift running overnight is normal and shows as such.

Switching a shift off here switches it off everywhere.

> The overtime ceiling defaults to five hours on top of an eight-hour net shift,
> which is what the specification states. It is a long day under the Factories
> Act's daily and quarterly limits, and multi-shift working adds its own
> provisions. The figure is configurable; confirm it with a compliance adviser
> before go-live.

**Who works which shift.** The grid that decides capacity. Switch a shift on for
a department and its capacity is added to that department's day — a department
running two shifts has roughly double the capacity of one running a single
shift. Beneath each is the sanctioned headcount for that department on that
shift.

Switching a shift on copies that department's existing rates and headcount across
as a starting point. **They will be wrong if the second shift is staffed
differently** — a shift with half the people does not make what the first one
makes, so correct the rates below. A pairing switched on with no rates at all is
flagged in red, because it would appear to be running while adding nothing.

**D-minus matrix.** How many days before the stuffing date each department must
be finished, per article per department, because each article takes a different
time through each step. Clearing a cell puts it back to blank and stops that
article scheduling. That is deliberate: a silent zero would produce an impossible
schedule that looks entirely normal on screen.

**Component rates.** How much a department makes in a day.

> **The single most important thing to get right.** A rate is what the department
> makes **doing nothing else all day**. If wood can make 480 legs in a day when
> it makes only legs, the rate is 480 — even if in practice it makes 160 legs and
> some seat frames. That is what lets Kram add up a department's day correctly
> when it is making several things at once. Entering the everyday figure instead
> makes a department appear to need three days of work every day.

**Holidays.** Declaring one closes that day and renumbers the working calendar,
so every schedule shifts to accommodate it. Sundays are already closed and are
not listed.

**Bill of materials.** Components per finished unit. Read-only — it comes from
Panipuri.

---

## Reading the numbers

### Utilisation

A department's day is 1.00. A department making 80 legs against a 480/day rate
has used a sixth of its day; making legs, seat frames and back frames at once,
the fractions add up. **Anything over 1.00 is more than a day's work in a day.**

Quantities in units cannot be added across components — legs and covers are not
the same thing — but the time they take can, which is why every total on screen
is a ratio rather than a count.

### Breach reasons

| Reason | Meaning |
|---|---|
| **Material** | The work would have to start before material is available. Arithmetically valid, physically impossible. |
| **Runway** | Fewer working days between this department's deadline and the one before it than the work needs. **Overtime cannot fix this** — under batch handoff the department physically cannot start earlier. |
| **Pin** | A manual pin has pushed the work past its due date. Reported, not corrected. |
| **D-minus missing** | The article × department offset has never been entered, so it cannot be scheduled. |
| **No capacity** | No rate for this component in this department. |
| **Out of horizon** | The window falls outside the working-day calendar. |

### Order confidence

**Confirmed**, **probable** or **forecast**. The command centre chooses which to
include in a run, so you can see the plan with and without work that is not yet
firm.

---

## Common tasks

**"Can we take this order?"** → *Accept an order*. Enter it, read the verdict. If
it breaks, the breach reason tells you whether it is a capacity problem
(overtime, people) or a runway problem (only a date change will help).

**"Where should the next hire go?"** → *Command centre*, bottleneck utilisation.
Highest average utilisation is the constraint. Adding people anywhere else buys
nothing.

**"Why is stitching red on the 17th?"** → *Load heatmap*, click the cell. It
lists every order and component on that day.

**"We need to start this order early."** → *Schedule*, filter to it, drag the
bar, give a reason. Every later run honours it.

**"The factory is closed for Diwali."** → *Masters*, add the holidays. The
calendar renumbers and every schedule shifts.

**"What if we put stitching on a second shift?"** → *Masters*. Switch the shift
on under *Shifts*, then switch it on for that department in *Who works which
shift*. Correct the copied rates for the second shift's staffing, then look at
the bottleneck table — the constraint often moves somewhere else entirely.

**"These capacity figures are wrong."** → *Masters*, component rates. Read the
warning above about dedicated rates first.

**"Start again."** → *Command centre*, **Reset demo data**. This wipes everything
in the browser and reloads the seed. There is no undo.

---

## Current limits

Worth knowing before showing it to anyone:

- **The data is illustrative.** Four departments from the prototype, not U&M's
  real seven, and invented rates.
- **No ERP import yet.** Orders are entered by hand until we have a real Panipuri
  export file to build the mapping against.
- **No login, and access control is not active offline.** The permission model is
  built and tested, but the offline build runs as a single user with full rights.
- **Nothing is shared.** Each browser holds its own copy. Two people running it
  see their own data.
- **Phases 3 onwards do not exist** — no WIP tracking, manpower, material,
  quality, machines or costing yet.
