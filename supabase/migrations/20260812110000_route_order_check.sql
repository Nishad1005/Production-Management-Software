-- Kram — catch a route order that contradicts its own D-minus figures.
--
-- The route is a single line: the engine treats the department at the previous
-- route position as the one that must finish first, and warns when a department
-- would start before that. Which makes one rule load-bearing —
--
--   a department that must finish earlier belongs earlier in the route
--
-- — and makes its violation invisible. If Metal Finishing is D-40 and sits after
-- Wood Finishing at D-30, the engine will insist Metal Finishing waits for work
-- that is not due for another ten days, and raise runway breaches that are not
-- real. The dates stay right; the warnings stop meaning anything, which is worse
-- on a screen whose entire job is warnings.
--
-- Nothing here corrects anything. Two figures a person entered disagree, and
-- which of them is wrong is not the software's call.

-- capacity_sheet decided "routed" by looking for a stage component, named
-- <article>::<department>. That is only how the sheet writes rates — an article
-- broken into real components (a leg, a stitched cover) is routed through a
-- department without any stage component existing, and read as unrouted.
--
-- The engine's test is broader and is the one that matters: does *any* component
-- of this article have a rate in this department. Added as a trailing column so
-- the replace is compatible.
create or replace view public.capacity_sheet
with (security_invoker = true) as
  select a.code as article_code,
         a.name as article_name,
         d.code as department_code,
         d.name as department_name,
         d.route_position,
         rate.units_per_day::float8 as units_per_day,
         rate.manpower,
         adm.dminus_days,
         coalesce(adm.is_complete, false) as dminus_complete,
         exists (
           select 1
             from public.article_bom b
             join public.component_rates cr on cr.component_id = b.component_id
            where b.article_id = a.id and cr.department_id = d.id
         ) as is_routed
    from public.articles a
    cross join public.departments d
    left join public.article_dept_dminus adm
      on adm.article_id = a.id and adm.department_id = d.id
    left join lateral (
      select cr.units_per_day, cr.manpower
        from public.component_rates cr
        join public.components c on c.id = cr.component_id
       where cr.department_id = d.id
         and c.code = a.code || '::' || d.code
       limit 1
    ) rate on true
   where a.is_active and d.is_active;

create view public.route_order_conflicts
with (security_invoker = true) as
  with entered as (
    select article_code,
           article_name,
           department_code,
           department_name,
           route_position,
           dminus_days,
           is_routed as routed
      from public.capacity_sheet
     where dminus_complete and dminus_days is not null
  ),
  sequenced as (
    select *,
           lag(department_code) over w as prev_department_code,
           lag(department_name) over w as prev_department_name,
           lag(route_position) over w as prev_route_position,
           lag(dminus_days) over w as prev_dminus_days,
           lag(routed) over w as prev_routed
      from entered
    window w as (partition by article_code order by route_position)
  )
  select article_code,
         article_name,
         prev_department_code as earlier_department_code,
         prev_department_name as earlier_department_name,
         prev_route_position as earlier_position,
         prev_dminus_days as earlier_dminus,
         department_code as later_department_code,
         department_name as later_department_name,
         route_position as later_position,
         dminus_days as later_dminus,
         -- A contradiction between two departments the article does not both
         -- pass through is still wrong, but it causes no breach today. Worth
         -- telling apart, so a real problem is not buried among tidy-ups.
         (routed and prev_routed) as affects_scheduling
    from sequenced
   where prev_dminus_days is not null
     and dminus_days > prev_dminus_days;

grant select on public.route_order_conflicts to authenticated;

comment on view public.route_order_conflicts is
  'Consecutive departments whose D-minus contradicts the route order — the later one must finish first. Compared consecutively because that is what the runway check does.';
