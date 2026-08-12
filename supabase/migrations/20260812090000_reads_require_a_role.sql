-- Kram — reading anything requires holding a role.
--
-- Every select policy said `to authenticated using (true)`: any signed-in
-- account could read the lot. Found by signing in with an account holding no
-- roles at all and reading back the component rates, the D-minus matrix and the
-- bill of materials — the factory's capacities, lead times and product
-- structure.
--
-- The application already refuses such an account and shows it a "no roles yet"
-- screen. That was the only thing standing in the way, and a screen is not a
-- boundary: the same request through the API returned the data happily.
--
-- Orders and customers were the same policy, so the entire order book with
-- quantities, dates and customer names would have been readable too. There
-- simply were no orders yet to demonstrate it with.
--
-- The rule now: no roles, no reads. Which roles should see *what* beyond that —
-- whether maintenance has any business reading the customer order book, for
-- instance — is the client's call and is recorded as an open question rather
-- than guessed at here.

-- Named distinctly rather than overloading auth_has_any_role(app_role[]).
-- Two functions sharing a name and differing only in arity is legal and
-- confusing, and it makes `comment on function` ambiguous — which is how this
-- was caught.
create or replace function public.auth_has_a_role()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_roles ur where ur.user_id = auth.uid()
  );
$$;

comment on function public.auth_has_a_role is
  'True when the caller holds at least one role. The floor for reading anything.';

-- Rebuild every read policy that trusted mere authentication.
--
-- profiles and user_roles are deliberately excluded: an account with no roles
-- must still be able to read its own profile, or the application cannot tell it
-- why it is seeing nothing.
do $$
declare
  t text;
begin
  foreach t in array array[
    -- masters
    'departments', 'shifts', 'department_shifts', 'articles', 'components',
    'article_bom', 'article_dept_dminus', 'component_rates',
    'capacity_overrides', 'holidays', 'employees', 'working_days',
    -- order book
    'customers', 'orders', 'shipment_lines',
    -- schedule output
    'schedule_runs', 'schedule_tasks', 'schedule_daily_load',
    'schedule_daily_capacity', 'schedule_pins'
  ] loop
    execute format('drop policy if exists %I on public.%I',
                   t || '_select_authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (public.auth_has_a_role())',
      t || '_select_with_a_role', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customers could not be created at all.
--
-- The order form picks a customer from a list, and nothing anywhere could add
-- one — so on a fresh database no order could ever be entered. The offline demo
-- hid it, because its seed ships three customers.
-- ---------------------------------------------------------------------------
create or replace function public.create_customer(
  p_code text,
  p_name text,
  p_country text default null
)
returns uuid
language sql
as $$
  insert into public.customers (code, name, country)
  values (p_code, p_name, p_country)
  on conflict (code) do update
    set name = excluded.name, country = excluded.country
  returning id;
$$;

revoke execute on function public.create_customer(text, text, text) from public, anon;
grant execute on function public.create_customer(text, text, text) to authenticated;
