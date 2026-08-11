-- Kram — bootstrapping the first administrator.
--
-- Run this once, in the Supabase dashboard's SQL editor, after creating your
-- account under Authentication → Users.
--
-- It exists because of a deliberate chicken-and-egg: only an admin can grant
-- roles, so the first admin cannot be granted through the application. The SQL
-- editor runs as the database owner and bypasses row-level security, which is
-- exactly the privilege needed once, and never again — every subsequent role is
-- assigned from the Users screen.

-- ---------------------------------------------------------------------------
-- 1. Change this to the email you signed up with, then run the whole file.
-- ---------------------------------------------------------------------------
\set admin_email 'nalawadenishad@gmail.com'

-- The SQL editor does not support \set, so if you are pasting this in, replace
-- the address below by hand instead.

insert into public.user_roles (user_id, role)
select u.id, r.role
  from auth.users u
  cross join (values ('admin'::public.app_role), ('planner'::public.app_role))
    as r (role)
 where u.email = 'nalawadenishad@gmail.com'
on conflict (user_id, role) do nothing;

-- Admin grants role management and the Users screen; planner grants the
-- masters, the order book and the scheduling engine. Add the rest from the
-- application once you are in.

-- ---------------------------------------------------------------------------
-- 2. Confirm it worked. Should list your address with both roles.
-- ---------------------------------------------------------------------------
select u.email,
       array_agg(ur.role order by ur.role) as roles
  from auth.users u
  left join public.user_roles ur on ur.user_id = u.id
 group by u.email;
