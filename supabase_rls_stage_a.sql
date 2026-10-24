-- ════════════════════════════════════════════════════════════════════════
--  Stage A — close the scheduler's tables to the public key
-- ════════════════════════════════════════════════════════════════════════
--  Run STEP 1 on its own first and read it. STEP 2 refuses to run if
--  STEP 1 found somebody who would be locked out, so running the whole
--  file by accident is survivable.
--
--  WHAT IS OPEN TODAY
--  33 tables have row security switched off, which means the anon key —
--  printed in plain text in every page mystarswim.com serves — can read
--  and write them. Among them: admin_employees, with IC numbers and bank
--  accounts; students, with children's names and their parents' contact
--  details; invoices, payments, pending_credits.
--
--  The attendance and leave side was locked as it was built. This is the
--  older half, which never was.
--
--  WHAT THIS DOES NOT TOUCH
--  Five tables the public website genuinely needs: branches, students,
--  tc_acceptances, contact_messages and promos. The intake form writes
--  three of them and the homepage reads two, all with the anon key.
--  Locking them without replacing them with narrow policies would take
--  enrolment down. They are Stage B and need one policy each.
--
--  Yes, students is in both lists. That is the awkward one: the intake
--  form inserts into it and the office reads all of it. It stays open
--  until Stage B gives it an insert-only door for anon.
--
--  TWO SEATS OF POLICY, NOT ONE
--  A blanket "any signed-in user" would include crew: every instructor
--  holds a real Supabase session from the attendance app, and that would
--  hand them invoices and students. So:
--
--    is_website_login()   the token carries a seat. Crew logins carry
--                         none — staff-auth writes user_metadata only,
--                         never app_metadata — so this is exactly "signed
--                         in to the website", and it stays true however
--                         the seats are renamed later.
--    is_system_login()    sysadmin, Centre Owner, Administrator. The six
--                         tables behind the system side: procurement, the
--                         directory, vouchers, and the crew records with
--                         the bank details in them.
--
--  PUBLIC SCHEDULE: SAFE
--  public_schedule_preview reads weekly_sessions, pools and branches,
--  and the public page reads the view. A view runs with its owner's
--  rights unless it says security_invoker, and this one does not — so
--  locking its base tables does not touch it. Checked, not assumed.
--
--  EVERYONE SIGNS OUT AND IN
--  The seat is minted into the token at sign-in. Anyone signed in right
--  now carries whatever their last sign-in gave them. Do this when
--  nobody is mid-roster, and tell them to sign out and back in.
--
--  UNDOING IT
--  The last section turns it all off again in one go. Nothing here drops
--  anything or changes a row of data; it is policies and grants only.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 — who would be locked out. Changes nothing. ═════════════════

-- A. The one that would be silent: an active login whose sign-in account
--    carries no seat. Their token would say nothing about them and every
--    screen would come back empty. Signing in once rewrites the claim.
select u.username, u.display_name, u.role,
       case
         when u.auth_user_id is null then 'no sign-in account yet — one sign-in fixes it'
         when a.id is null           then 'STALE pointer — one sign-in fixes it'
         when coalesce(a.raw_app_meta_data ->> 'ssb_role', '') = ''
                                     then '>>> NO SEAT ON THE ACCOUNT — must sign in before you run STEP 2'
         else 'ready: ' || (a.raw_app_meta_data ->> 'ssb_role')
       end as state
  from app_users u
  left join auth.users a on a.id = u.auth_user_id
 where coalesce(u.is_active, true)
 order by 4, 1;

-- B. What is about to change, and what is deliberately left open.
select c.relname as table_name,
       case when c.relrowsecurity then 'already locked'
            when c.relname in ('branches','students','tc_acceptances',
                               'contact_messages','promos')
                 then 'left open — Stage B'
            else 'locking now' end as plan
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by 2, 1;


-- ═══ STEP 2 — the lock. ═════════════════════════════════════════════════

-- 2a. What "signed in to the website" means, in one place.
create or replace function is_website_login()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;   -- no JWT at all: the anon key, or a direct SQL session
  end;
  return coalesce(btrim(v_role), '') <> '';
end $$;

comment on function is_website_login() is
  'True for a token minted by the login function, which is every website '
  'seat and only those. A crew attendance login carries no ssb_role, so '
  'this is false for an instructor on the phone.';

create or replace function is_system_login()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  -- The three current seats, and the two older names that still exist on
  -- accounts nobody has reassigned.
  return coalesce(v_role, '') in
    ('sysadmin', 'center_owner', 'administrator', 'admin', 'hr_admin');
end $$;

comment on function is_system_login() is
  'The seats that reach the system side: sysadmin, Centre Owner and '
  'Administrator, plus the retired names for the same people.';

revoke all on function is_website_login() from public, anon;
revoke all on function is_system_login()  from public, anon;
grant execute on function is_website_login() to authenticated;
grant execute on function is_system_login()  to authenticated;

-- 2b. Refuse to go on if anybody would be shut out silently.
do $$
declare v_who text;
begin
  select string_agg(u.username, ', ' order by u.username) into v_who
    from app_users u
    join auth.users a on a.id = u.auth_user_id
   where coalesce(u.is_active, true)
     and coalesce(a.raw_app_meta_data ->> 'ssb_role', '') = '';

  if v_who is not null then
    raise exception
      'Stopping: % would be locked out. Their sign-in account carries no '
      'seat, so their token says nothing and every screen would come back '
      'empty. Have each of them sign out and sign in once — that rewrites '
      'the claim — then run this file again.', v_who;
  end if;
end $$;

-- 2c. The lock itself.
--
-- One policy per table, for all four verbs. This is not least privilege
-- within the office — a scheduler can still write an invoice, as they
-- can today. It is the line between the office and the open internet,
-- which is the line that is currently missing.
do $$
declare
  t text;
  -- The system side: procurement, the directory, vouchers, and the crew
  -- records. Bank accounts and IC numbers live in the last of these.
  v_system text[] := array[
    'admin_categories','admin_companies','admin_contacts',
    'admin_employees','admin_payees','admin_payment_vouchers'
  ];
  -- The scheduling side: lessons, students' enrolments, money. Every
  -- website seat reaches these, as every website seat does today.
  v_office text[] := array[
    'billing_terms','calendar_remarks','code_redemptions','credit_purchases',
    'family_group_members','family_groups','invoice_lines','invoice_settings',
    'invoices','operating_hours','packages','payments','pending_credits',
    'pools','products','programme_categories','programme_sessions',
    'replacement_pending','scheduler_codes','scheduler_durations',
    'scheduler_instructors','scheduler_lesson_types','session_instructors',
    'student_credit_balances','student_enrollments','weekly_session_students',
    'weekly_sessions'
  ];
  v_n int := 0;
begin
  foreach t in array v_system || v_office loop
    -- A table this database does not have is skipped, not an error: the
    -- list is written from one live schema and schemas drift.
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'skipped %, which is not in this database', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_office', t);

    if t = any(v_system) then
      execute format(
        'create policy %I on public.%I for all to authenticated '
        'using (is_system_login()) with check (is_system_login())',
        t || '_office', t);
    else
      execute format(
        'create policy %I on public.%I for all to authenticated '
        'using (is_website_login()) with check (is_website_login())',
        t || '_office', t);
    end if;

    execute format('revoke all on public.%I from anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
    v_n := v_n + 1;
  end loop;
  raise notice 'Locked % tables.', v_n;
end $$;


-- ═══ STEP 3 — confirm ═══════════════════════════════════════════════════

-- Nothing should read "OPEN" except the five Stage B tables.
select c.relname as table_name,
       case when c.relrowsecurity then 'locked' else '>>> OPEN' end as rls,
       coalesce((select p.polname::text from pg_policy p
                  where p.polrelid = c.oid and p.polname = c.relname || '_office'),
                '—') as policy
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relrowsecurity, c.relname;

-- The public schedule still answers. If this returns rows, the homepage
-- and schedule page are fine.
select count(*) as public_schedule_rows from public_schedule_preview;


-- ════════════════════════════════════════════════════════════════════════
--  ROLLBACK — uncomment the whole block and run it to undo Stage A.
--  It removes the policies and switches row security back off. It does
--  not delete anything and does not touch a row of data.
-- ════════════════════════════════════════════════════════════════════════
-- do $$
-- declare t text;
-- begin
--   foreach t in array array[
--     'admin_categories','admin_companies','admin_contacts','admin_employees',
--     'admin_payees','admin_payment_vouchers','billing_terms','calendar_remarks',
--     'code_redemptions','credit_purchases','family_group_members','family_groups',
--     'invoice_lines','invoice_settings','invoices','operating_hours','packages',
--     'payments','pending_credits','pools','products','programme_categories',
--     'programme_sessions','replacement_pending','scheduler_codes',
--     'scheduler_durations','scheduler_instructors','scheduler_lesson_types',
--     'session_instructors','student_credit_balances','student_enrollments',
--     'weekly_session_students','weekly_sessions'
--   ] loop
--     if to_regclass(format('public.%I', t)) is null then continue; end if;
--     execute format('drop policy if exists %I on public.%I', t || '_office', t);
--     execute format('alter table public.%I disable row level security', t);
--   end loop;
-- end $$;
