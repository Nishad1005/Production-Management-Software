-- Kram — the order book.
--
-- Spec §4: "The shipment line is the scheduling unit." An order is not a single
-- dated commitment. A 1,000-chair order may leave as 400 on 1 August and 600 on
-- 20 August — two independent backward schedules from two stuffing dates. Every
-- date calculation keys on the shipment line, never the order.

create type public.order_confidence as enum ('confirmed', 'probable', 'forecast');
create type public.order_status as enum ('open', 'in_production', 'closed', 'cancelled');

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  country text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.customers');

-- ---------------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),

  -- Spec §15: the idempotency key for imports. "Re-uploading the same file
  -- updates rather than duplicating. Without it, one double-click creates
  -- hundreds of phantom orders."
  erp_order_no text not null unique,

  customer_id uuid not null references public.customers (id) on delete restrict,
  article_id uuid not null references public.articles (id) on delete restrict,

  total_qty numeric(14, 3) not null check (total_qty > 0),
  order_date date,

  confidence public.order_confidence not null default 'confirmed',
  status public.order_status not null default 'open',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.orders');

create index orders_status_confidence_idx on public.orders (status, confidence);
create index orders_article_idx on public.orders (article_id);

comment on column public.orders.confidence is
  'Confirmed / Probable / Forecast (spec §3 parameter 13). The engine filters on this.';

-- ---------------------------------------------------------------------------

create table public.shipment_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  line_no integer not null check (line_no > 0),
  qty numeric(14, 3) not null check (qty > 0),

  -- Spec §3 parameter 1: the anchor for every backward calculation.
  stuffing_date date not null,

  -- Spec §6: "Customer date — reference only, never used in maths." Kept so the
  -- planner can see the commitment they are protecting, and deliberately not
  -- wired into anything the engine reads.
  delivery_date date,

  -- Spec §6: "Lines sharing a ref stuff together."
  container_ref text,

  -- Spec §6: "Hard floor — nothing schedules before it."
  material_ready_date date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (order_id, line_no)
);
select public.attach_audit('public.shipment_lines');

create index shipment_lines_stuffing_date_idx on public.shipment_lines (stuffing_date);
create index shipment_lines_container_ref_idx on public.shipment_lines (container_ref)
  where container_ref is not null;

-- Spec §6: line quantities summing to the order total is surfaced as a warning,
-- not enforced. A hard constraint would block a merchandiser entering the first
-- of three phases, which is a normal thing to be doing.
create view public.order_qty_reconciliation as
  select o.id as order_id,
         o.erp_order_no,
         o.total_qty,
         coalesce(sum(sl.qty), 0) as scheduled_qty,
         o.total_qty - coalesce(sum(sl.qty), 0) as unallocated_qty,
         count(sl.id) as line_count
    from public.orders o
    left join public.shipment_lines sl on sl.order_id = o.id
   group by o.id, o.erp_order_no, o.total_qty;

comment on view public.order_qty_reconciliation is
  'Order total against the sum of its shipment lines. Non-zero unallocated_qty is a warning for the UI, not an error.';

-- ---------------------------------------------------------------------------
-- Access. Merchandising owns dates and commitments, so it writes here even
-- though it may not touch the masters that set capacity.
-- ---------------------------------------------------------------------------

create or replace function public.auth_can_manage_orders()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_has_any_role(
    array['admin', 'planner', 'merchandiser']::public.app_role[]
  );
$$;

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'orders', 'shipment_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.auth_can_manage_orders()) with check (public.auth_can_manage_orders())',
      t || '_write_orders', t
    );
  end loop;
end;
$$;
