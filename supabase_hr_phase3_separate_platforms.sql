-- ════════════════════════════════════════════════════════════════════════
--  Two platforms, two credentials
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Run supabase_hr_phase2_roles.sql first if you have not; this builds on
--  the seat rules it sets. Deploy the site update alongside it.
--
--  THE RULE, IN ONE TABLE
--
--    Seat            Website (scheduling / system)   Attendance app
--    ──────────────────────────────────────────────────────────────────
--    Scheduler       scheduling side only            own ss… crew login
--    Administrator   both sides, with the button     own ss… crew login
--    Centre Owner    both sides, with the button     the same login
--    sysadmin        both sides, with the button     the same login
--
--  Only the last two carry one credential across both. For everybody else
--  the website login and the attendance login are separate things with
--  separate passwords, and signing in to one does nothing for the other —
--  including in the same browser.
--
--  WHY THE LINK HAD TO GO
--  "Use office login" pointed a crew record at somebody's website account
--  so they would have one password for both. It read as a convenience and
--  behaved as a merge: the website seat started deciding what the phone
--  showed, and an Administrator who was also crew ended up holding the HR
--  side of the phone because of a button pressed on a different screen.
--  It is also what put Anthony on Sally's roster.
--
--  Two credentials is the plainer thing to explain and the plainer thing
--  to revoke. Taking somebody off the roster no longer touches their
--  website access, and taking away their website access no longer takes
--  their attendance history's owner with it.
--
--  WHAT THIS DOES TO EXISTING LINKS
--  Every linked crew record is unpicked. The website logins themselves are
--  untouched — nobody loses access to the scheduler, and no Auth account
--  is deleted. What each unlinked person needs is an ss… crew login, made
--  the ordinary way on the Crew screen: + Create login.
--
--  The two links in place when this was written:
--    Anthony Ang    → anthony   (sysadmin — reaches the phone through the
--                                office route anyway, so the link was
--                                never doing anything for him)
--    Chuah Wei Tong → tony      (scheduler — needs sstony making)
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Unpick every office link ─────────────────────────────────────────
-- staff_id goes too: it held the website username, and leaving it there
-- would have the Crew screen showing "tony" as an attendance login that
-- no longer works.
do $$
declare v_tbl text; v_n int;
begin
  select c.relname into v_tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end
   limit 1;
  if v_tbl is null then return; end if;

  execute format($q$
    update public.%I
       set auth_user_id = null, staff_id = null, login_is_office = false
     where login_is_office
  $q$, v_tbl);
  get diagnostics v_n = row_count;
  raise notice 'Unlinked % office login(s) from crew records.', v_n;
end $$;

-- ── 2. The link button is gone, and so is the function behind it ────────
-- Kept rather than dropped, and kept saying why: a browser running
-- yesterday's bundle still has the button, and a sentence it can show is
-- better than a 404 it cannot explain.
create or replace function link_office_login(p_crew_id uuid, p_username text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  return jsonb_build_object('ok', false,
    'error', 'Website logins and attendance logins are separate now. Give '
          || 'them an attendance login of their own with + Create login — '
          || 'their website password is not affected, and theirs stops '
          || 'working on the phone when you remove it here.');
end $$;

comment on function link_office_login(uuid, text) is
  'Disabled. The website login and the attendance login are separate '
  'credentials except for sysadmin and Centre Owner, who reach the phone '
  'through get_my_profile''s office branch and need no crew link.';

-- ── 3. So the phone can say which kind of login it just refused ─────────
-- get_my_profile returns nothing for a website login with no crew record,
-- and "nothing" is the same answer as a crew record whose login has been
-- removed. They are different problems and want different sentences, so
-- the app asks this on the way to the error message.
--
--   crew      a crew record answers to this account
--   office    sysadmin or Centre Owner — the dual credential
--   website   an Administrator or Scheduler: right password, wrong door
--   unknown   neither, which should not happen
create or replace function my_login_kind()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_has boolean; v_role text;
begin
  select c.relname into v_tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end
   limit 1;

  if v_tbl is not null then
    execute format('select exists (select 1 from public.%I where auth_user_id = auth.uid())', v_tbl)
      into v_has;
    if v_has then return 'crew'; end if;
  end if;

  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;

  if coalesce(v_role, '') in ('sysadmin', 'center_owner') then return 'office'; end if;
  if coalesce(v_role, '') <> '' then return 'website'; end if;
  return 'unknown';
end $$;

revoke all on function my_login_kind()                  from public, anon;
revoke all on function link_office_login(uuid, text)    from public, anon;
grant execute on function my_login_kind()               to authenticated;
grant execute on function link_office_login(uuid, text) to authenticated;

-- ── Nothing should answer to a website login any more ───────────────────
select count(*) as crew_records_still_linked_to_a_website_login
  from admin_employees where login_is_office;

-- ── Who now needs an attendance login making ────────────────────────────
-- Anyone on the roster with no ss… login. Make them on the Crew screen
-- with + Create login; each one is a password you hand over in person.
select e.full_name,
       coalesce(e.staff_id, '— none —') as attendance_login,
       e.status
  from admin_employees e
 where e.archived_at is null
   and e.auth_user_id is null
 order by 1;
