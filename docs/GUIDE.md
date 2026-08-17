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

## On a phone

Every screen works on a phone: nothing scrolls sideways and every control is
sized for a thumb. Four are built for it — **Production**, **My department**,
**Manpower** and **WIP** — because that is where the work is entered and read on
the floor.

The **load heatmap** stays deliberately dense. Its cells are small because the
point of a heatmap is seeing a whole month at once; thumb-sized cells would show
a week. Scroll it sideways, or open it at a desk.

---

## Two ways to run it

**Offline** — `npm run dev`, then http://localhost:5173.

No database to install, no login, no network. Postgres runs inside the browser.
The first load takes a second or two while it starts and applies the schema;
after that it is instant, and what you enter is remembered between visits. This
is the build to demonstrate from: nothing to set up, nothing to sign into.

**Hosted** — `npm run dev:hosted`, or the deployed site.

Talks to the shared Supabase database. Everyone sees the same data, and you sign
in. Which one you get is decided by whether the Supabase details are configured,
and nothing else — the screens are identical.

### Signing in

Accounts are created by an administrator in the Supabase dashboard
(*Authentication → Users → Add user*, with *Auto Confirm User* ticked). They
then appear on the **Users** screen, where roles are assigned.

**A new account has no roles and can see nothing.** That is deliberate — you are
signed in, the system works, and there is simply nothing you have been given
access to yet. The screen says as much rather than showing empty tables.

Roles are enforced in the database on every request, not in the browser. Hiding a
screen is a convenience; being unable to read the data is the actual rule.

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

### What if

Try a change without touching the live plan.

Describe what you are trying, pick a department, a window and a capacity level,
and run it. The scenario is scheduled as its own complete version of the plan and
compared against the live one. The capacity change is applied for that run and
taken straight back out — **the masters are never edited**.

| Preset | Multiplier | Stands for |
|---|---|---|
| Department down | ×0 | A breakdown or a shutdown |
| Overtime | ×1.2 | Roughly two hours a day on top |
| Second shift | ×2 | Double the capacity |

Any multiplier can be typed directly. Leaving the department blank runs the book
unchanged, which is how you ask "what happens if the probable orders land?" —
tick or untick *Include probable orders* and compare.

What comes back:

- **Four figures** — breaches and flagged days, now against the scenario, each
  with the difference spelled out.
- **Per department** — utilisation before and after, the change, and the breach
  count on each side. This is where you see a constraint move from one department
  to another.
- **What changed** — only the tasks that actually moved or changed verdict,
  labelled *Resolved*, *New breach*, *Different reason* or *Dates moved*. This is
  the "these six stop breaching if you do this" answer.

**Make this the plan** promotes the scenario. The plan it replaces is kept, as
every run is. **Discard** throws the scenario away.

The **Runs** list at the bottom keeps every run ever made. Any of them can be
compared against the live plan, so you can go back and see what a plan looked
like before a decision was taken.

> If a scenario's window overlaps a capacity override that was already booked —
> a scheduled shutdown, say — the real one wins and the scenario applies only to
> the rest. The screen tells you when that has happened, because a partial result
> presented as a whole one would be worse than no result.

### Dashboard

The MD's screen. Ten figures, each with its target, and the ones that cannot be
computed yet say what they are waiting for instead of showing a zero — a zero
would be read as a fact.

**Planned against made** sits underneath: every department's last fortnight, what
the plan asked for beside what was declared, and the difference. A day where
something was made that nobody planned appears just as plainly as a day where
nothing was made at all.

---

### My department

Your own bench, and the two questions a supervisor asks in the order they ask
them. Pick your department at the top; everything below follows it.

Jobs are ordered by **the container each one ships in**, not by your own
deadline. The container sails when it sails.

**Holding you up** is what you are waiting for. Each card names the department
that owes you the work, the order it is for, and three quantities that mean
three different things: what they owe, what they have **made**, and what has
**reached you**. Made and reached are separate on purpose — work made but not
handed over is a conversation with the bench next door, while work not made is a
conversation about their day. Different problems, different people.

It lists only what is **late or due within the week**. Anything further out is
counted in a line underneath rather than shown, because a feeder that has not
started on work due in three months is not holding you up, and burying six real
problems under fifty imaginary ones is how a screen stops being read.

If nothing feeds your department, it says so: you start on your own and there is
never anything to wait for.

**What you owe** is everything still outstanding on the current plan — the order,
the component, how many, and by when. A job leaves the list when the quantity is
declared, on the Production screen.

---

### WIP

Where everything is, counted rather than valued.

**In progress** is every shipment line that has been started and not finished.
Open a card to see the line department by department: what each one was asked
for, what it declared, and what the next department counted in. That is the
answer to *"where is order SO-1234"* — not a percentage, but which bench it is
sitting at.

**Ready to stuff** is the lines that have been through every department on their
route. They are done as far as production is concerned.

Lines that have not been started at all are counted but not listed; there is
nothing to say about them beyond the plan, which the Schedule screen already
shows.

> **Counted, not valued.** Every figure here is what was declared against what
> the plan asked for. The rupee value of work in progress is a separate thing,
> shown on the Dashboard, and it needs a cost per article entered on the capacity
> sheet before it can say anything at all.

---

### Production

Where the day gets written down. It replaces the daily production sheet, and it
is the only screen that records what actually happened rather than what the plan
expects.

Pick your department and the date. If nothing is planned that day the screen says
so and offers the days there is work — clicking one takes you there.

**Handed to you, not yet counted in** comes first, because it is the first thing
that happens in a day. The department before you has said what it made; enter
what actually arrived. If the two disagree, enter what you have. The difference
is kept, not smoothed over — that is the whole point of counting it.

**What you were asked for** is the day's jobs, one row per order and component,
with what the plan asks for beside it. Enter **good** and **rejected**
separately: both are counts you can stand behind, and the percentage is worked
out from them. That worked-out figure is what the yield on Masters gets compared
against.

Entering output **does not move any dates**. The plan stays where it is, because
it is what everyone is working to today. Rescheduling the factory every time
someone types a number would move the ground under them.

Entering a figure again corrects it rather than adding to it, so there is no way
to double a day by entering it twice.

---

### Manpower

Who is here, and what to do about the days there are not enough of them.

**Where overtime would close the gap** takes every day a department is asked for
more than it can make and says it in hours instead of pieces: how much overtime
each person would have to work, or — where that runs past the overtime ceiling —
how many extra people the day needs. An overtime hour is worth less than a normal
one; the efficiency figure on the shift says how much less, and it is editable
like any other master. This is the arithmetic from U&M's own capacity model, and
the tests check Kram against it rather than against itself.

Days that have already gone are not listed. Overload in the past is real, but no
amount of overtime reaches it — that work is late, and it moves on the schedule.

**Who is in** is each department's day: on the books, in, out, on leave, and the
overtime actually worked. A department nobody has marked shows as unrecorded
rather than as fully present, because the two are not the same thing and only one
of them is a fact.

**Deployment** is the roster. Pick a department, and mark each person **In**,
**Out** or **On leave**; enter overtime hours against anyone who stayed. Marking
somebody changes what their department can make that day, so the plan re-runs —
the head count on the Production screen follows the same moment, because it is
the same number and not a second copy of it.

Overtime here is hours **worked**, not hours the plan would like. The panel above
says what a day would need; this says what happened.

---

### Capacity sheet

The same grid as the capacity spreadsheet — every article against every
department — writing where the engine reads it.

Pick what you are entering: **Units per day**, **Manpower**, or **D-minus**. One
number per cell, because three across a thousand cells is not something anyone
can read. Click a cell, type, press Enter.

- A **units** figure means the article passes through that department at that
  rate. A blank means it does not go there at all, which is the usual answer.
- Clearing a figure removes that step from the article's route.
- Manpower needs a units figure first — it is the crew behind that rate.
- **Units is what the department makes in a day working only that article.** Not
  what it makes on a normal mixed day. That is what lets a department's day be
  added up correctly when it is making several things at once, and entering the
  everyday figure instead makes a department look like the bottleneck when it is
  not.

If **A department is due before something that feeds it** appears, a department
has been given a deadline no later than something that must finish before it can
start. Either the D-minus is wrong or the two are not really dependent, and the
software will not guess which — but while it stands, the engine holds that work
back behind something not yet due and reports breaches that are not real. The
rule: a department's D-minus must be larger than that of everything feeding it,
larger meaning earlier. Change the D-minus here, or change what feeds it on
Masters → What feeds what.

The four figures across the top are the worklist: how many articles have a route
at all, how many pairings exist, and what is still missing. An article with no
D-minus cannot be scheduled — deliberately, because a silent zero would produce
an impossible plan that looks entirely normal.

### Masters

The figures every schedule run depends on. **Underlined values are editable** —
click one, type, press Enter. Every change re-runs the schedule immediately.

**Save masters to a file / Load from a file.** Everything on this screen —
route, shifts, staffing, D-minus, rates, BOM, holidays — written to a single
file, and read back.

Use it before you close the browser after entering anything real. This build
keeps its data in one browser, so a cleared cache takes the lot; the file is the
only copy that survives. It is also how real figures move between machines, and
how they will be loaded into the hosted system later.

Loading **merges by code** and never wipes what is already there, so a partly
filled file is safe to apply.

**Save everything to a file.** The masters file above carries the figures you
could type again from a spreadsheet. This one also carries the things you could
not: the order book, and every production declaration and handover ever entered.
What a department said it made on a Tuesday exists in one database and nowhere
else.

Keep it somewhere other than the machine you are working on. Once a week is
plenty at first, and more often once real production is being entered.

> It is a **copy to hold, not something the software loads back on its own**. The
> masters half merges by code and is safe to apply twice; a production entry is
> an event, and replaying events into a database that already holds some of them
> is how a factory ends up with a day it made twice. If the file is ever needed,
> rebuilding from it is a job to do once, carefully, with somebody watching.

**Production route.** Every department, and the yield — the percentage that
survives each step. The number on the left is only the order they are listed in.
Deactivating a department never deletes it; one with history keeps it.

**Articles.** What the factory makes. In the finished system these come from
Panipuri; until then, **Add an article** takes a code, a name and a category. The
code is what orders and the capacity sheet refer to, so it is worth matching
whatever Panipuri calls it — adding one that already exists corrects its name
rather than creating a second.

A new article cannot be planned until it passes through at least one department
*and* every one of those has a D-minus. The **Can be planned** column says which
of the two is missing; both are entered on the capacity sheet.

Switching an article off stops it being offered for new orders and takes it out
of the capacity sheet. Orders already placed against it keep their plan and their
history — switching off means "do not sell it again", not "forget the container
that is already booked". **Restore** brings it back.

**What feeds what.** The part the engine reads. Read a row as "this department
cannot start until…" and tick the columns it waits for. A row with nothing ticked
is an **entry point** — it waits for no one, which is what a feeder like metal
finishing or fibre processing is. Departments not connected to each other run
alongside each other, and that is how most of a furniture factory works.

This drives two things:

- A department is held back until everything feeding it is due. Wire a feeder
  into the wrong place and it produces runway breaches that are not real.
- Yield compounds along these edges, so a component is only inflated by the
  losses of the departments its material actually passes through. A wooden leg
  charged for stitching is a leg you make and never need.

Two departments cannot wait for each other — the software refuses the edge and
says so.

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

---

### Users

Administrators only, and only on the hosted system — the offline build has no
accounts in it, so there is nobody to administer.

**Accounts are created in the Supabase dashboard, not here.** Creating one needs
a key that bypasses every access rule, so it is deliberately not something the
application can do. What happens here is the part that decides what people
actually see: assigning roles.

A new account has **no roles and can see nothing** until given some. Somebody who
signs in successfully and finds an empty screen is almost always waiting on this,
and the screen they see says so.

Roles are enforced in the database on every request, not by hiding menus. Hiding
a screen is a courtesy; the rule that stops the data being read lives underneath
and applies however the request arrives.


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
| **Runway** | Fewer working days between this department's deadline and the latest of the departments feeding it than the work needs. **Overtime cannot fix this** — under batch handoff the department physically cannot start earlier. If the department it is waiting for does not really feed it, say so on Masters → What feeds what. |
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

**"What if we put stitching on a second shift?"** → *What if*. Pick the
department, *Second shift*, run it. The comparison shows whether it resolves the
breaches and where the constraint moves to. If you decide to do it for real,
*Masters* is where it gets made permanent.

**"A machine is down next week — how bad is it?"** → *What if*, pick the
department, *Department down*, set the window to the outage. The changed-task
list tells you which orders it actually touches.

**"These capacity figures are wrong."** → *Masters*, component rates. Read the
warning above about dedicated rates first.

**"Where is order SO-1234?"** → *WIP* → **In progress**, open the line. It shows
which department has it, what they were asked for and what they declared.

**"What is my department waiting for?"** → *My department*, pick yours →
**Holding you up**. It names who owes you the work and whether it has been made
but not handed over.

**"Add a product we have started making."** → *Masters* → **Articles** →
**Add an article**, then *Capacity sheet* for its rate in each department and its
D-minus. It cannot be planned until both are in.

**"Start again."** → *Command centre*, **Reset demo data**. This wipes everything
in the browser and reloads the seed. There is no undo.

---

## Current limits

Worth knowing before showing it to anyone:

- **The data is illustrative.** The department names, what feeds what and the
  article codes are U&M's own; every rate, yield, D-minus, order and employee in
  the offline build is invented, so the screens have something to say.
- **No ERP import yet.** Orders are entered by hand until we have a real Panipuri
  export file to build the mapping against.
- **No login, and access control is not active offline.** The permission model is
  built and tested, but the offline build runs as a single user with full rights.
- **Nothing is shared in the offline build.** Each browser holds its own copy,
  so two people running it see different data and a cleared cache loses
  everything. Save to a file after entering anything real — **Save everything**
  on Masters takes the order book and the production ledger too.
- **Phases 5 onwards do not exist** — no material, quality, machines or costing
  yet.
- **WIP is valued only as far as it is costed.** The ledger records quantities,
  which are always real. A rupee figure needs a cost per article, entered on the
  capacity sheet; until one is, the KPI says so rather than showing a zero, and
  where only part of the floor is costed it says how much of it the total
  covers.
