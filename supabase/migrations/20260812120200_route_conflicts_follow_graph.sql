-- Kram — point the D-minus guard at the edges the engine actually walks.
--
-- route_order_conflicts compared each department against whichever sat at the
-- previous route position, and said so in its own comment: "compared
-- consecutively because that is what the runway check does". That was true when
-- it was written and stopped being true one migration ago. Left alone it would
-- report pairs the engine never compares and stay silent about ones it does —
-- a warning screen drifting away from the thing it warns about, which is worse
-- than no warning at all.
--
-- The rule it enforces changes shape with the model. It used to be "a department
-- that must finish earlier belongs earlier in the route". It is now:
--
--   a department's D-minus must be larger than that of everything feeding it
--
-- larger meaning earlier, since D-minus counts backwards from the stuffing date.
--
-- Two details are chosen to match the engine rather than to be tidy:
--
--   Ancestors are transitive, not immediate. _upstream takes max(due_date) over
--   every ancestor, and a department whose D-minus is blank contributes null,
--   which max ignores — so the comparison silently falls through to the one
--   behind it. Walking transitively reproduces that instead of going quiet
--   exactly where a half-filled sheet needs the help.
--
--   Equal D-minus is now flagged, where the old view wanted strictly greater.
--   Two departments due the same day mean the second starts before the first has
--   finished, and the engine raises a runway breach for it. A guard that stays
--   quiet about a breach the engine will raise is the drift this migration is
--   about, in miniature.

create or replace view public.route_order_conflicts
with (security_invoker = true) as
  with recursive up (node, ancestor) as (
    select dd.department_id, dd.depends_on_department_id
      from public.department_dependencies dd
    union
    select u.node, dd.depends_on_department_id
      from up u
      join public.department_dependencies dd on dd.department_id = u.ancestor
  ),
  entered as (
    select cs.article_code,
           cs.article_name,
           d.id as department_id,
           cs.department_code,
           cs.department_name,
           cs.route_position,
           cs.dminus_days,
           cs.is_routed as routed
      from public.capacity_sheet cs
      join public.departments d on d.code = cs.department_code
     where cs.dminus_complete and cs.dminus_days is not null
  ),
  contradicting as (
    select e.article_code,
           e.article_name,
           e.department_code,
           e.department_name,
           e.route_position,
           e.dminus_days,
           e.routed,
           feeder.department_code as feeder_code,
           feeder.department_name as feeder_name,
           feeder.route_position  as feeder_position,
           feeder.dminus_days     as feeder_dminus,
           feeder.routed          as feeder_routed,
           -- Smallest D-minus is the latest due date, which is the ancestor the
           -- runway check will actually hold this department behind. Report that
           -- one: it is the binding constraint, and listing every ancestor that
           -- happens to contradict would bury it.
           row_number() over (
             partition by e.article_code, e.department_code
             order by feeder.dminus_days
           ) as rn
      from entered e
      join up on up.node = e.department_id
      join entered feeder
        on feeder.article_code = e.article_code
       and feeder.department_id = up.ancestor
     where e.dminus_days >= feeder.dminus_days
  )
  select article_code,
         article_name,
         feeder_code     as earlier_department_code,
         feeder_name     as earlier_department_name,
         feeder_position as earlier_position,
         feeder_dminus   as earlier_dminus,
         department_code as later_department_code,
         department_name as later_department_name,
         route_position  as later_position,
         dminus_days     as later_dminus,
         -- A contradiction between two departments the article does not both
         -- pass through is still wrong, but it causes no breach today. Worth
         -- telling apart, so a real problem is not buried among tidy-ups.
         (routed and feeder_routed) as affects_scheduling
    from contradicting
   where rn = 1;

comment on view public.route_order_conflicts is
  'Departments whose D-minus contradicts what feeds them: the department is due no later than something it depends on. Names the binding feeder, which is the one the runway check will hold it behind.';
