-- Kram — product structure.
--
-- Spec §4: "Departments produce components, not chairs."
--
--   chairs_ready = MIN over components of ( accepted_qty / bom_qty_per_unit )
--
-- A department can be ahead and behind at the same time, and the components
-- left over are real material and real labour producing nothing shippable.

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
select public.attach_audit('public.articles');

-- ---------------------------------------------------------------------------

create table public.components (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  uom text not null default 'NOS',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
select public.attach_audit('public.components');

comment on table public.components is
  'Leg, seat frame, cut fabric panel. The unit production is actually counted in (spec §3 parameter 10).';

-- ---------------------------------------------------------------------------

create table public.article_bom (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete restrict,

  -- Four legs to a chair. Fractional quantities are legitimate for sheet goods
  -- (0.35 of a plywood sheet), hence numeric rather than integer.
  qty_per_unit numeric(12, 4) not null check (qty_per_unit > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  unique (article_id, component_id)
);
select public.attach_audit('public.article_bom');

create index article_bom_component_id_idx on public.article_bom (component_id);

comment on column public.article_bom.qty_per_unit is
  'Components per finished unit. Divisor in chairs_ready = MIN(accepted / qty_per_unit).';
