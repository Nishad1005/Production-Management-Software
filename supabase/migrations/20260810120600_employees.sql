-- Kram — the employee master.
--
-- Spec §2 lists this as one of Rev B's two structural corrections: "Skill mix
-- and leave tracking need individuals, not head counts."
--
-- Attendance, leave and overtime are Phase 4. The master lands here in Phase 0
-- because department_shifts.sanctioned_headcount is the establishment figure
-- and employees is what it will eventually be reconciled against.
--
-- Open with HR before Phase 4 (spec §8): per-employee attendance is what skill
-- mix and "four skilled carpenters on leave tomorrow" require, but it is more
-- entry than aggregate head counts. If HR's sheet is aggregate only, this table
-- still holds the establishment; skill mix simply is not deliverable.

create type public.skill_level as enum ('skilled', 'semi_skilled', 'unskilled');
create type public.employment_type as enum ('permanent', 'contract');

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  emp_code text not null unique,
  name text not null,

  department_id uuid references public.departments (id) on delete set null,
  default_shift_id uuid references public.shifts (id) on delete set null,

  skill_level public.skill_level not null default 'semi_skilled',
  employment_type public.employment_type not null default 'permanent',

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
select public.attach_audit('public.employees');

create index employees_department_shift_idx
  on public.employees (department_id, default_shift_id) where is_active;

comment on column public.employees.skill_level is
  'Feeds the skill-mix weighting on effective capacity (spec §13). Weights default to parity until measured.';
