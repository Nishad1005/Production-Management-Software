-- Kram — shared helpers used by every later migration.
--
-- Spec §5: "Every table carries id, created_at, updated_at and created_by."
-- The columns are declared explicitly on each table so the schema reads
-- honestly; only the trigger wiring, which is error-prone to repeat, is
-- factored out here.

-- Needed for the overlap-prevention exclusion constraint on capacity_overrides,
-- which mixes equality (uuid) with range overlap (daterange) in one index.
create extension if not exists btree_gist;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at is
  'Trigger function keeping updated_at honest. Attached via attach_audit().';

-- Attaches the updated_at trigger to a table. Call once per table, right after
-- its create statement.
create or replace function public.attach_audit(p_table regclass)
returns void
language plpgsql
as $$
declare
  v_name text := 'set_updated_at_' || replace(p_table::text, 'public.', '');
begin
  execute format(
    'create trigger %I before update on %s for each row execute function public.set_updated_at()',
    v_name, p_table
  );
end;
$$;

comment on function public.attach_audit is
  'Attaches the updated_at trigger to a table. Call once, after create table.';
