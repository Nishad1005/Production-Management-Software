-- Kram — a department with no shift is invisible, and nothing said so.
--
-- ---------------------------------------------------------------------------
-- Found on the live project, 30 Aug, while checking the demo would hold up.
--
-- The command centre showed twelve shipment lines and a completed schedule run
-- carrying **24 tasks**. Twelve lines through fourteen departments should be
-- 168. Every task was in ASSY or STITCH; the other twelve departments produced
-- nothing at all — no task, no capacity, no load, no breach, no flagged day.
--
-- The engine builds its route from `_pair`, which inner-joins
-- `department_shifts`. A department with no shift row has no pair, so no
-- component, so no task. That is defensible on its own — a department nobody
-- works in does not produce anything — but **nothing anywhere said it was
-- happening**. The run reported success. The Gantt drew bars. `article_master`
-- reported `can_schedule = true` for all seventy-one articles, because it
-- checks the D-minus matrix and the D-minus matrix was complete.
--
-- A plan covering two departments out of fourteen looked exactly like a plan.
-- That is the failure this project names first in its own conventions: being
-- wrong in a way that looks normal on screen.
--
-- ---------------------------------------------------------------------------
-- Why the shifts were missing: a setter that only ever set.
--
-- `set_headcount` was an UPDATE with no INSERT. Against a department that has
-- no row in `department_shifts` it matched nothing, changed nothing, and
-- returned successfully. The interim loader called it fourteen times, was told
-- fourteen times that it had worked, and created two rows — ASSY and STITCH,
-- which already had shifts because they happen to share a code with the
-- four-department parity seed.
--
-- Two fixes, because either alone leaves the hole open. The function now does
-- what its name says, and the condition it used to create silently is now a
-- finding on the Attention screen.
-- ---------------------------------------------------------------------------

create or replace function public.set_headcount(
  p_department_code text,
  p_shift_code text,
  p_headcount integer
)
returns void
language sql
as $fn$
  insert into public.department_shifts (department_id, shift_id, sanctioned_headcount)
  select d.id, s.id, p_headcount
    from public.departments d, public.shifts s
   where d.code = p_department_code and s.code = p_shift_code
  on conflict (department_id, shift_id) do update
    set sanctioned_headcount = excluded.sanctioned_headcount;
$fn$;

comment on function public.set_headcount is
  'Establishment for a department on a shift. Creates the pairing if it does not exist: it was an UPDATE only, and on a department with no shift row it silently did nothing while reporting success.';

-- ---------------------------------------------------------------------------
-- The finding.
--
-- Critical, and not by analogy with the others. Every other entry on the
-- Attention screen describes something the plan can see and shows you. This one
-- describes work the plan cannot see at all, which makes every figure on every
-- other screen an understatement — capacity, load, breaches and flagged days
-- alike. It is the one finding that says the rest of the numbers are wrong.
-- ---------------------------------------------------------------------------
create view public.attention_department_unstaffed
with (security_invoker = true) as
  select 'department-unstaffed'          as kind,
         'critical'                      as severity,
         d.name || ' is on the route but has nobody on any shift' as title,
         count(distinct cr.component_id)::text ||
           ' components have a rate here and none of them are being scheduled · '
           || 'every load and breach figure is short by this department''s work'
                                         as detail,
         '/masters'                      as route,
         'department-unstaffed:' || d.code as key,
         0                               as days_out
    from public.departments d
    join public.component_rates cr on cr.department_id = d.id
   where d.is_active
     and not exists (
       select 1
         from public.department_shifts ds
         join public.shifts s on s.id = ds.shift_id and s.is_active
        where ds.department_id = d.id
          and ds.is_active
     )
   group by d.id, d.code, d.name;

comment on view public.attention_department_unstaffed is
  'Active departments that hold rates but have no active shift. The engine joins department_shifts to build its route, so these are dropped from every plan without a word.';

grant select on public.attention_department_unstaffed to authenticated;

create or replace view public.attention
with (security_invoker = true) as
  select kind, severity, title, detail, route, key, days_out
    from public.attention_breach
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_overloaded
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_material_late
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_material_short
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_route_conflict
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_machine_down
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_article_unplannable
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_handover
  union all
  select kind, severity, title, detail, route, key, days_out
    from public.attention_department_unstaffed;
