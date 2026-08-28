-- Kram — saying so, when the figures are ours rather than U&M's.
--
-- The live project holds U&M's real route and, until now, nothing else: no
-- rates in any of the 994 cells, no orders, no production. That makes it
-- unusable for anything except looking at empty screens, and U&M cannot be
-- given accounts and asked what they think of a system with nothing in it.
--
-- So interim figures go in. Which creates exactly the risk this software has
-- been built to avoid: a number that is invented and looks normal. The offline
-- build has said "Offline draft" on every screen since Phase 1 and tags its
-- rates ESTIMATED for the same reason. The hosted system now needs its own
-- version of that, because it is the one people will believe.
--
-- ---------------------------------------------------------------------------
-- One row, and a banner while it exists.
--
-- The loader writes it, the purge removes it, and the application shows a
-- standing notice for as long as it is there. Deliberately not a boolean in a
-- settings table nobody reads — a row that has to be deleted is a row somebody
-- has to decide to delete.
-- ---------------------------------------------------------------------------

create table public.provisional_load (
  id uuid primary key default gen_random_uuid(),

  loaded_at timestamptz not null default now(),
  loaded_by uuid references auth.users (id) default auth.uid(),

  -- What went in, in words, so the banner can say it and so whoever removes it
  -- knows what they are removing.
  what text not null check (length(btrim(what)) > 0),

  -- The prefix every order this load created carries, so the purge can find
  -- them without guessing.
  order_prefix text not null default 'PROV-',

  note text,

  updated_at timestamptz not null default now()
);
select public.attach_audit('public.provisional_load');

comment on table public.provisional_load is
  'Present while the database holds figures DBBS entered rather than U&M confirmed. The application shows a banner for as long as a row exists.';

alter table public.provisional_load enable row level security;

-- Readable by anyone with a role, because everyone needs to know what they are
-- looking at. Writable the same way: it is a note, not a permission.
create policy provisional_load_select_with_a_role on public.provisional_load
  for select to authenticated using (public.auth_has_a_role());
create policy provisional_load_write_with_a_role on public.provisional_load
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create view public.provisional_state
with (security_invoker = true) as
  select exists (select 1 from public.provisional_load) as is_provisional,
         (select what from public.provisional_load
           order by loaded_at desc limit 1) as what,
         (select loaded_at::text from public.provisional_load
           order by loaded_at desc limit 1) as loaded_at,
         (select order_prefix from public.provisional_load
           order by loaded_at desc limit 1) as order_prefix,
         (select count(*) from public.orders o
           where o.erp_order_no like
             coalesce((select order_prefix from public.provisional_load
                        order by loaded_at desc limit 1), 'PROV-') || '%')::integer
           as provisional_orders;

grant select on public.provisional_state to authenticated;

create or replace function public.mark_provisional(
  p_what text,
  p_order_prefix text default 'PROV-',
  p_note text default null
)
returns void
language plpgsql
as $$
begin
  -- One standing notice rather than a history of loads: the question the banner
  -- answers is "is what I am looking at confirmed", which has one answer.
  delete from public.provisional_load where id is not null;
  insert into public.provisional_load (what, order_prefix, note)
  values (p_what, coalesce(p_order_prefix, 'PROV-'), p_note);
end;
$$;

revoke execute on function public.mark_provisional(text, text, text) from public, anon;
grant execute on function public.mark_provisional(text, text, text) to authenticated;

/**
 * Removes the interim order book and the production recorded against it.
 *
 * Masters are deliberately left alone: rates and D-minus upsert by code, so
 * PPC's sheet overwrites them cell by cell with nothing left behind. Orders do
 * not — they accumulate — which is the whole reason they carry a prefix.
 *
 * Returns how many orders went, so the caller can report it rather than
 * announcing success into the dark.
 */
create or replace function public.purge_provisional()
returns integer
language plpgsql
as $$
declare
  v_prefix text;
  v_gone integer;
begin
  select order_prefix into v_prefix
    from public.provisional_load order by loaded_at desc limit 1;

  if v_prefix is null then
    raise exception 'nothing is marked provisional, so there is nothing to purge';
  end if;

  -- Shipment lines, tasks and the whole production ledger cascade from the
  -- order, so this is the only delete needed.
  with removed as (
    delete from public.orders
     where erp_order_no like v_prefix || '%'
    returning 1
  )
  select count(*) into v_gone from removed;

  delete from public.provisional_load where id is not null;

  return v_gone;
end;
$$;

revoke execute on function public.purge_provisional() from public, anon;
grant execute on function public.purge_provisional() to authenticated;
