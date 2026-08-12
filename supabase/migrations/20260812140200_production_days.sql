-- Kram — the days a department is actually asked to work.
--
-- The production screen opens on today, which is right: a supervisor entering
-- output is entering today's. But a department with nothing planned today gets
-- an empty panel, and an empty panel is indistinguishable from a broken one.
--
-- This is what it needs to say instead — here are the days there is work, pick
-- one. Useful on its own as well: it is the first answer to "when am I busy",
-- which currently requires reading the heatmap sideways.
create view public.production_days
with (security_invoker = true) as
  select d.code            as department_code,
         dl.load_date::text as work_date,
         count(*)                              as jobs,
         sum(dl.qty_planned)::float8           as qty_planned,
         count(decl.id)                        as declared
    from public.schedule_daily_load dl
    join public.schedule_runs r on r.id = dl.run_id and r.is_current
    join public.departments d on d.id = dl.department_id
    left join public.production_declarations decl
      on decl.shipment_line_id = dl.shipment_line_id
     and decl.department_id = dl.department_id
     and decl.component_id = dl.component_id
     and decl.production_date = dl.load_date
     and decl.shift_id = dl.shift_id
   group by d.code, dl.load_date;

comment on view public.production_days is
  'Days the current plan asks each department to work, with how many of those jobs have been entered.';

grant select on public.production_days to authenticated;
