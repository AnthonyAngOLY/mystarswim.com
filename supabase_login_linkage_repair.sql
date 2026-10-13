-- ════════════════════════════════════════════════════════════════════════
--  Repair sign-in linkage, and stop calling it "never signed in"
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--
--  WHAT WAS FOUND
--  Rahimah showed as never having signed in, although she plainly has.
--  Checking every login turned up three different states:
--
--    healthy      linkage recorded, Auth account exists
--    no account   signed in before the Auth layer shipped, so there is
--                 no Auth account and no linkage yet
--    STALE        linkage recorded, Auth account gone
--
--  The first two need nothing: somebody in the second group signs in
--  once and the login function creates the account and records the
--  linkage on the spot.
--
--  The third cannot heal itself. With auth_user_id set, login takes the
--  "already linked" branch, tries to sign in as a user that is not
--  there, then tries to update it — and fails both times. Clearing the
--  dead pointer puts them back on the first-login path, which either
--  creates the account or finds an existing one by email and realigns.
--
--  HOW A POINTER GOES STALE
--  Most likely a crew login was provisioned under the same username and
--  later removed, and staff-auth's remove calls deleteUser — which
--  deletes the Auth account the scheduler login was also pointing at.
--  Office links are now guarded against exactly this; the damage
--  predates the guard.
--
--  A NOTE ON last_login_at
--  It is stamped when the password is accepted, BEFORE the Auth session
--  is minted. So it records "the password was right", not "they got in".
--  A recent stamp on a broken account is a failed attempt, not proof of
--  a working login.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. What is about to be repaired ─────────────────────────────────────
select u.username,
       u.last_login_at,
       case
         when u.auth_user_id is null then 'no account yet — signing in once fixes it'
         when a.id is null           then 'STALE — pointer to a deleted account'
         else 'healthy'
       end as state
  from app_users u
  left join auth.users a on a.id = u.auth_user_id
 order by 3 desc, 1;

-- ── 2. Clear the dead pointers ──────────────────────────────────────────
-- Only where the account it names is genuinely gone. Their next sign-in
-- rebuilds it; nothing else about the login is touched, and the password
-- still lives in app_users as it always did.
update app_users u
   set auth_user_id = null
 where u.auth_user_id is not null
   and not exists (select 1 from auth.users a where a.id = u.auth_user_id);

-- ── 3. Say what is actually true in the picker ──────────────────────────
-- has_signed_in was a claim about the person inferred from a column that
-- is really about our own bookkeeping — and it was wrong for anybody who
-- signed in before the Auth layer existed. What the link actually needs
-- is an Auth account, so the flag now says that, and last_login_at comes
-- along so the screen can tell "never been here" from "been here, but
-- not since the upgrade".
drop function if exists office_logins_for_linking();
create or replace function office_logins_for_linking()
returns table (username text, display_name text, role text,
               ready_to_link boolean, last_login_at timestamptz, linked_to text)
language sql security definer set search_path = public stable
as $$
  select u.username::text,
         coalesce(nullif(btrim(u.display_name), ''), u.username)::text,
         u.role::text,
         u.auth_user_id is not null,
         u.last_login_at,
         (select e.full_name from admin_employees e
           where e.auth_user_id = u.auth_user_id limit 1)::text
    from app_users u
   where attendance_is_admin()
     and coalesce(u.is_active, true)
   order by u.username;
$$;

revoke all on function office_logins_for_linking() from public, anon;
grant execute on function office_logins_for_linking() to authenticated;

-- ── What you should see ─────────────────────────────────────────────────
-- No STALE rows left. Anyone reading "no account yet" simply needs to
-- sign in once, which they can do without any help from you.
select u.username,
       case
         when u.auth_user_id is null then 'no account yet — signing in once fixes it'
         when a.id is null           then 'STALE — still broken, tell Claude'
         else 'healthy'
       end as state
  from app_users u
  left join auth.users a on a.id = u.auth_user_id
 order by 2 desc, 1;
