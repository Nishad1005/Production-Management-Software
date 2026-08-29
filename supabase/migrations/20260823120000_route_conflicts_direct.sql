-- Kram — route_order_conflicts, off the capacity sheet.
--
-- ---------------------------------------------------------------------------
-- Why `attention` was still cancelled after article_master was fixed.
--
-- `attention` unions eight findings, one of which is the route-order
-- contradiction. That came from here, and this read `capacity_sheet` — the one
-- view still matching a constructed component code, measured on the live
-- project at **1021 ms for 994 rows**. A second alone is tolerable; a second
-- inside a union of eight branches, under row-level security, is not, and the
-- API cancelled the lot at eight seconds.
--
-- So the alert screen — the one built to tell people what is wrong — was the
-- screen that failed.
--
-- ---------------------------------------------------------------------------
-- Rebuilt from the graph-walking version, not retyped.
--
-- The only change is `entered`, which now reads `article_dept_dminus`,
-- `articles` and `departments` on real keys. Everything else — the recursive
-- ancestor walk, the `>=` that catches a feeder due on the same day, the
-- row_number that names the binding feeder rather than every ancestor — is the
-- text of 20260812120200 unchanged.
--
-- The first attempt at this migration was written from the *original* Phase 2
-- definition and silently reverted the graph walk to a consecutive comparison.
-- Three tests caught it. Same mistake as retyping `import_masters` on 18 Aug,
-- and the same fix: take the current text and change one thing in it.
--
-- `capacity_sheet` is left alone. It is under the ceiling, read by one screen
-- rather than eight, and changing its lateral would alter what the parity
-- fixture shows.
-- ---------------------------------------------------------------------------

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
  -- Which departments actually make something for each article. Computed once
  -- as a set; this is the only thing the view ever wanted from the capacity
  -- sheet, and asking the sheet for it cost a second.
  routed_pairs as (
    select distinct b.article_id, cr.department_id
      from public.article_bom b
      join public.component_rates cr on cr.component_id = b.component_id
  ),
  entered as (
    select a.code                     as article_code,
           a.name                     as article_name,
           d.id                       as department_id,
           d.code                     as department_code,
           d.name                     as department_name,
           d.route_position,
           adm.dminus_days,
           (rp.article_id is not null) as routed
      from public.article_dept_dminus adm
      join public.articles a on a.id = adm.article_id and a.is_active
      join public.departments d on d.id = adm.department_id and d.is_active
      left join routed_pairs rp
        on rp.article_id = adm.article_id and rp.department_id = adm.department_id
     where adm.is_complete and adm.dminus_days is not null
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
  'Departments whose D-minus contradicts what feeds them: the department is due no later than something it depends on. Names the binding feeder. Reads the tables directly — going through the capacity sheet was taking the alert screen over the API timeout.';
