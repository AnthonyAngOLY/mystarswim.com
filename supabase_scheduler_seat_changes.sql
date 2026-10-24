-- ════════════════════════════════════════════════════════════════════════
--  Scheduling passes to Clara and Zoe. Tony goes back to instructing.
-- ════════════════════════════════════════════════════════════════════════
--  Run STEP 1 and read it. Then the rest, which is safe to re-run.
--
--  WHAT THIS DOES
--    Zoe   schedule_admin → scheduler. The same seat under the name it
--          has now; the old one still works but reads as something that
--          no longer exists.
--    Tony  his website login is switched off, and the seat claim is
--          taken off his sign-in account so a token minted before today
--          cannot carry it either.
--    Clara untouched. Centre Owner already reaches the scheduling side.
--
--  WHY SWITCHED OFF AND NOT DELETED
--  Disabling keeps the row, so last_login_at and the name stay readable
--  and the record of who held the seat survives. The login function only
--  ever selects is_active = true, so he is refused just as firmly. If you
--  would rather it were gone, the delete is at the bottom, commented.
--
--  TONY'S INSTRUCTING SIDE IS SEPARATE, AND NOT SET UP BY THIS FILE
--  His attendance login is its own credential — an ss… staff ID, made on
--  the Crew screen with + Create login, starting on star1234. Nothing in
--  this file creates it and nothing here affects it. That is the whole
--  point of the two being separate: taking away the scheduling seat does
--  not touch his ability to clock in.
--
--  THEY MUST SIGN OUT AND IN AGAIN
--  A seat is minted into the token at sign-in. Zoe's new one reaches her
--  the next time she signs in, not before.
--
--  THE NAMES ARE SPELT OUT IN STEP 2 AND CHECKED IN STEP 5
--  The first version of this file looked for a login called "zoe". Hers
--  is "zoelim", so the update matched nothing and said nothing — the row
--  count was zero and zero rows is not an error. STEP 5 now names every
--  login this file meant to change and says whether it found it, because
--  a change that quietly does not happen is worse than one that fails.
-- ════════════════════════════════════════════════════════════════════════

-- ═══ STEP 1 — who holds what now. Changes nothing. ══════════════════════
select u.username, u.display_name, u.role,
       case when coalesce(u.is_active, true) then 'active' else 'switched off' end as state,
       u.last_login_at,
       case when a.id is null then 'no sign-in account' else 'has one' end as auth_account
  from app_users u
  left join auth.users a on a.id = u.auth_user_id
 order by u.username;


-- ═══ STEP 2 — Zoe schedules, under the current name ═════════════════════
-- The username, not the person's name: hers is zoelim.
update app_users
   set role = 'scheduler'
 where lower(username) = 'zoelim'
   and role <> 'scheduler';


-- ═══ STEP 3 — Tony's website login goes quiet ═══════════════════════════
update app_users
   set is_active = false
 where lower(username) = 'tony';


-- ═══ STEP 4 — and the seat comes off his sign-in account ════════════════
-- Switching the row off stops the website login. It does not touch the
-- Supabase Auth account behind it, which still carries ssb_role in its
-- metadata — and that claim is what a token says about him. Stripping it
-- means that even a token minted from that account says nothing about a
-- seat. Harmless if the account is already gone.
-- Matched by email as well as by the row, because if the login has
-- already been deleted there is no row left to follow to the account —
-- and that is exactly the case where the claim is still sitting there.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) - 'ssb_role' - 'app_user_id'
 where email = 'tony@staff.mystarswim.internal'
    or id = (select auth_user_id from app_users where lower(username) = 'tony');


-- ═══ STEP 5 — confirm ═══════════════════════════════════════════════════
-- Every login this file meant to touch, by name, and what became of it.
-- A spelling that matches nothing says so here instead of passing in
-- silence, which is how Zoe stayed a schedule_admin the first time.
with intended (username, meant_to) as (
  values ('zoelim', 'scheduler'),
         ('tony',   'off the website')
)
select i.username,
       i.meant_to,
       case
         when i.meant_to = 'off the website' then
           case when u.username is null              then 'gone entirely — fine'
                when coalesce(u.is_active, true)     then '>>> STILL ACTIVE'
                else 'switched off' end
         when u.username is null                     then '>>> NO SUCH LOGIN — check the spelling in STEP 1'
         when u.role = i.meant_to                    then 'done'
         else '>>> still ' || u.role
       end as state
  from intended i
  left join app_users u on lower(u.username) = lower(i.username)
 order by 1;

-- Everyone, and whether they can get in.
select u.username, u.display_name, u.role,
       case when coalesce(u.is_active, true) then 'active' else 'switched off' end as state
  from app_users u
 order by case when coalesce(u.is_active, true) then 0 else 1 end, u.username;

-- Who can work the scheduling side. Should be Clara, Zoe, and whoever
-- else genuinely needs it — not Tony.
select username, display_name, role
  from app_users
 where coalesce(is_active, true)
   and role in ('sysadmin','center_owner','administrator','scheduler','schedule_admin','admin')
 order by case role when 'sysadmin' then 1 when 'center_owner' then 2
                    when 'administrator' then 3 else 4 end, username;

-- No seat claim left on Tony's sign-in account. Expect either no row, or
-- a row reading 'none'.
select a.email,
       coalesce(a.raw_app_meta_data ->> 'ssb_role', 'none') as seat_claim
  from auth.users a
 where a.email = 'tony@staff.mystarswim.internal';


-- ════════════════════════════════════════════════════════════════════════
--  OPTIONAL — neither runs unless you uncomment it.
-- ════════════════════════════════════════════════════════════════════════

-- A. Remove the website login outright rather than switching it off. The
--    row goes; last_login_at and the record of the seat go with it.
--
--    delete from app_users where lower(username) = 'tony';

-- B. Remove his website sign-in account as well. Do this in the dashboard
--    — Authentication → Users → tony@staff.mystarswim.internal → Delete —
--    rather than with SQL, because deleting from auth.users by hand can
--    leave sessions and identities behind.
--
--    His instructing login is a DIFFERENT account (sstony@…), so this does
--    not touch it. Only do this after STEP 4 has shown 'none', and only if
--    you are sure he will not be back on the website.
-- ════════════════════════════════════════════════════════════════════════
