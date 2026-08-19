-- Kram Phase 8 — money.
--
-- Row five of the client's scope of work: "MONEY · PURCHASE · ACCOUNTS ·
-- PAYMENT SCHEDULE · CASH FLOW PLANNING · MD/ACCOUNTS".
--
-- ---------------------------------------------------------------------------
-- What this phase will and will not say.
--
-- It says what things **cost** and when money must **go out**. It says nothing
-- about what anything sells for, because no order in Kram carries a value and
-- inventing one would put a revenue figure on the MD's screen with nothing
-- behind it. Cash flow planning proper needs money in as well as out; this is
-- the half the data supports, and the screen says which half it is.
--
-- ---------------------------------------------------------------------------
-- The cost structure is U&M's own.
--
-- `docs/source/costing-sheet.xlsx` is one article costed line by line: wood,
-- plywood, metal, spring, belt, spring clips, tie paper wire, hessian, dacking,
-- non-woven, foam, fibre wadding, poly fibre, thread, leather, piping, button,
-- chain, chain puller, brass cup, packing, labour, finishing, CNF,
-- miscellaneous, other — twenty-six lines totalling ₹16,759.71. That total is
-- where the demo's article cost came from, and this is that sheet as a table.
--
-- Until now an article's cost was a single box somebody typed. It still can be:
-- a total with no breakdown behind it is a perfectly good thing to have while
-- the detail is being collected. But where lines exist they are the truth, and
-- `articles.unit_cost` is **derived from their sum** rather than typed beside
-- them — one number, one way to arrive at it, the same choice as employee
-- attendance deriving the department head count.
-- ---------------------------------------------------------------------------

create table public.cost_lines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,

  -- What kind of money it is, which is what a cash-flow question turns on:
  -- material is bought from somebody on terms, labour is paid weekly whatever
  -- happens, logistics falls due when the container moves.
  kind text not null default 'material'
    check (kind in ('material', 'labour', 'packing', 'logistics', 'overhead')),

  sort_order integer not null default 100,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
select public.attach_audit('public.cost_lines');

create table public.article_costs (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  cost_line_id uuid not null references public.cost_lines (id) on delete cascade,

  -- Zero is meaningful and common: the costing sheet carries metal, piping and
  -- button at zero for a chair that has none of them, and that is a statement
  -- rather than a gap.
  amount numeric(14, 4) not null check (amount >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),

  unique (article_id, cost_line_id)
);
select public.attach_audit('public.article_costs');

comment on table public.article_costs is
  'One article''s cost, line by line, in U&M''s own structure. Their sum is what articles.unit_cost holds.';

alter table public.cost_lines enable row level security;
alter table public.article_costs enable row level security;

create policy cost_lines_select_with_a_role on public.cost_lines
  for select to authenticated using (public.auth_has_a_role());
create policy cost_lines_write_with_a_role on public.cost_lines
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

create policy article_costs_select_with_a_role on public.article_costs
  for select to authenticated using (public.auth_has_a_role());
create policy article_costs_write_with_a_role on public.article_costs
  for all to authenticated
  using (public.auth_has_a_role()) with check (public.auth_has_a_role());

-- What a material costs and when the supplier expects to be paid. Both are
-- nullable: a material with no rate is one nobody has priced, which the views
-- keep apart from one that is free.
alter table public.materials
  add column if not exists rate_per_uom numeric(14, 4)
    check (rate_per_uom is null or rate_per_uom >= 0);

alter table public.suppliers
  add column if not exists payment_terms_days integer not null default 30
    check (payment_terms_days >= 0);

comment on column public.suppliers.payment_terms_days is
  'Days after the material is needed that the invoice falls due. Counted from need, not from order: the invoice follows the delivery.';

-- ---------------------------------------------------------------------------
-- Writing.
-- ---------------------------------------------------------------------------
create or replace function public.set_cost_line(
  p_code text,
  p_name text,
  p_kind text default 'material',
  p_sort_order integer default 100
)
returns void
language sql
as $$
  insert into public.cost_lines (code, name, kind, sort_order)
  values (p_code, p_name, coalesce(p_kind, 'material'), coalesce(p_sort_order, 100))
  on conflict (code) do update
    set name = excluded.name,
        kind = excluded.kind,
        sort_order = excluded.sort_order,
        is_active = true;
$$;

revoke execute on function public.set_cost_line(text, text, text, integer)
  from public, anon;
grant execute on function public.set_cost_line(text, text, text, integer)
  to authenticated;

/**
 * One line of one article's cost, and the total it implies.
 *
 * The total is written back to articles.unit_cost rather than left to be summed
 * by whoever asks. Everything downstream — WIP value on the MD's dashboard, the
 * capacity sheet's cost box — already reads that column, and two ways to arrive
 * at an article's cost is exactly how the two end up disagreeing on screen.
 */
create or replace function public.set_article_cost_line(
  p_article_code text,
  p_cost_line_code text,
  p_amount numeric default null
)
returns void
language plpgsql
as $$
declare
  v_article uuid;
  v_line uuid;
  v_total numeric;
  v_lines integer;
begin
  select id into v_article from public.articles where code = p_article_code;
  if v_article is null then
    raise exception 'unknown article %', p_article_code;
  end if;

  select id into v_line from public.cost_lines where code = p_cost_line_code;
  if v_line is null then
    raise exception 'unknown cost line %', p_cost_line_code;
  end if;

  if p_amount is null then
    delete from public.article_costs
     where article_id = v_article and cost_line_id = v_line;
  else
    insert into public.article_costs (article_id, cost_line_id, amount)
    values (v_article, v_line, p_amount)
    on conflict (article_id, cost_line_id) do update set amount = excluded.amount;
  end if;

  select count(*), coalesce(sum(amount), 0) into v_lines, v_total
    from public.article_costs where article_id = v_article;

  -- Removing the last line puts the article back to having no cost at all,
  -- rather than to a total of zero. Zero would be a claim that it is free, and
  -- the dashboard would believe it.
  update public.articles
     set unit_cost = case when v_lines = 0 then null else v_total end
   where id = v_article;
end;
$$;

revoke execute on function public.set_article_cost_line(text, text, numeric)
  from public, anon;
grant execute on function public.set_article_cost_line(text, text, numeric)
  to authenticated;

create or replace function public.set_material_rate(
  p_material_code text,
  p_rate numeric default null
)
returns void
language plpgsql
as $$
declare
  v_material uuid;
begin
  select id into v_material from public.materials where code = p_material_code;
  if v_material is null then
    raise exception 'unknown material %', p_material_code;
  end if;
  update public.materials set rate_per_uom = p_rate where id = v_material;
end;
$$;

revoke execute on function public.set_material_rate(text, numeric) from public, anon;
grant execute on function public.set_material_rate(text, numeric) to authenticated;

create or replace function public.set_supplier_terms(
  p_supplier_code text,
  p_payment_terms_days integer
)
returns void
language plpgsql
as $$
begin
  update public.suppliers
     set payment_terms_days = p_payment_terms_days
   where code = p_supplier_code;
  if not found then raise exception 'unknown supplier %', p_supplier_code; end if;
end;
$$;

revoke execute on function public.set_supplier_terms(text, integer) from public, anon;
grant execute on function public.set_supplier_terms(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading — the cost sheet.
-- ---------------------------------------------------------------------------
create view public.article_cost_breakdown
with (security_invoker = true) as
  select a.code                as article_code,
         a.name                as article_name,
         cl.code               as cost_line_code,
         cl.name               as cost_line_name,
         cl.kind,
         cl.sort_order,
         ac.amount::float8,
         round(
           100 * ac.amount / nullif(sum(ac.amount) over (partition by a.id), 0), 2
         )::float8 as share_pct
    from public.article_costs ac
    join public.articles a on a.id = ac.article_id
    join public.cost_lines cl on cl.id = ac.cost_line_id;

grant select on public.article_cost_breakdown to authenticated;

create view public.article_cost_summary
with (security_invoker = true) as
  select a.code                     as article_code,
         a.name                     as article_name,
         a.unit_cost::float8,
         count(ac.id)::integer      as lines,
         -- Where the cost is a typed total with nothing behind it, say so. A
         -- breakdown and a bare figure are both usable and are not the same
         -- thing, and the difference decides whether anybody can argue with it.
         (count(ac.id) > 0)         as has_breakdown,
         coalesce(sum(ac.amount) filter (where cl.kind = 'material'), 0)::float8
                                    as material_cost,
         coalesce(sum(ac.amount) filter (where cl.kind = 'labour'), 0)::float8
                                    as labour_cost,
         coalesce(sum(ac.amount) filter (where cl.kind in ('packing', 'logistics')), 0)::float8
                                    as packing_and_freight,
         coalesce(sum(ac.amount) filter (where cl.kind = 'overhead'), 0)::float8
                                    as overhead
    from public.articles a
    left join public.article_costs ac on ac.article_id = a.id
    left join public.cost_lines cl on cl.id = ac.cost_line_id
   where a.is_active
   group by a.id, a.code, a.name, a.unit_cost;

grant select on public.article_cost_summary to authenticated;

-- ---------------------------------------------------------------------------
-- Reading — money out.
--
-- Every material the current plan needs, priced, with the day the invoice falls
-- due: the day the material is needed plus the supplier's terms. Counted from
-- need rather than from order, because the invoice follows the delivery.
--
-- A material with no rate is carried with a null amount rather than dropped.
-- Leaving it out would produce a smaller, tidier and wrong total; carrying it
-- lets the screen say how much of the schedule it is actually describing.
-- ---------------------------------------------------------------------------
create view public.purchase_commitments
with (security_invoker = true) as
  select r.run_id,
         r.material_code,
         r.material_name,
         r.category,
         r.uom,
         r.supplier_code,
         r.supplier_name,
         r.erp_order_no,
         r.article_code,
         r.department_code,
         r.needed_on,
         r.order_by,
         r.qty_required,
         m.rate_per_uom::float8,
         (r.qty_required * m.rate_per_uom)::float8 as amount,
         coalesce(sup.payment_terms_days, 30) as payment_terms_days,
         (r.needed_on::date + coalesce(sup.payment_terms_days, 30))::text as payable_on,
         (m.rate_per_uom is not null) as priced
    from public.material_requirements r
    join public.materials m on m.code = r.material_code
    left join public.suppliers sup on sup.code = r.supplier_code;

comment on view public.purchase_commitments is
  'What the plan commits the factory to buying, priced where a rate exists. Unpriced materials are carried with a null amount rather than dropped from the total.';

grant select on public.purchase_commitments to authenticated;

-- Week by week, because a cash-flow question is asked in weeks and a daily list
-- of four hundred rows answers nothing.
create view public.cash_out_weekly
with (security_invoker = true) as
  select date_trunc('week', payable_on::date)::date::text as week_starting,
         sum(amount) filter (where priced)::float8        as amount,
         count(*) filter (where priced)::integer          as priced_lines,
         count(*) filter (where not priced)::integer      as unpriced_lines,
         count(distinct supplier_code)::integer           as suppliers,
         min(payable_on)                                  as first_due,
         (date_trunc('week', payable_on::date)::date < current_date) as overdue
    from public.purchase_commitments
   group by date_trunc('week', payable_on::date);

comment on view public.cash_out_weekly is
  'Money out by week. Unpriced lines are counted, not costed — a total that silently omits them would read as complete.';

grant select on public.cash_out_weekly to authenticated;

-- What each supplier is owed across the plan, which is the other way the same
-- question gets asked.
create view public.supplier_commitments
with (security_invoker = true) as
  select coalesce(supplier_code, '—')       as supplier_code,
         coalesce(supplier_name, 'No supplier recorded') as supplier_name,
         max(payment_terms_days)            as payment_terms_days,
         sum(amount) filter (where priced)::float8 as amount,
         count(*)::integer                  as lines,
         count(*) filter (where not priced)::integer as unpriced_lines,
         min(payable_on)                    as first_due,
         count(distinct material_code)::integer as materials
    from public.purchase_commitments
   group by supplier_code, supplier_name;

grant select on public.supplier_commitments to authenticated;
