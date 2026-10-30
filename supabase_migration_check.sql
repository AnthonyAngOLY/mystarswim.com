-- ════════════════════════════════════════════════════════════════════════
--  Which migrations has this database actually had?
-- ════════════════════════════════════════════════════════════════════════
--  Read-only. It creates nothing, changes nothing, and is safe to run any
--  time, on any database, as often as you like.
--
--  There is no migrations table — the files are run by hand in the SQL
--  editor — so this does not read a record of what was run. It looks for
--  what each file leaves behind: a table, a column, a function, or a
--  particular line inside a function that only one version of it has.
--  That is better than a record, because it answers the question you
--  actually have, which is not "did I run it" but "is it in".
--
--  WHAT THE ANSWERS MEAN
--    IN           the thing that file adds is present
--    NOT IN       it is not — run the file
--    SUPERSEDED   a later file replaced everything this one did, so
--                 there is nothing left to look for. Not a problem.
--    CHECK BY EYE  the file only moves data, so there is no object to
--                 find. The note says what to look at instead.
--
--  One query, one result. Run it and paste the whole thing back.
-- ════════════════════════════════════════════════════════════════════════

with
col as (
  select table_name::text as t, column_name::text as c
    from information_schema.columns where table_schema = 'public'
),
fn as (
  -- src is prosrc, which holds ONLY the body between the $$ markers. A
  -- name in the RETURNS TABLE clause is not in it — it is a parameter
  -- name, and lives in proargnames. A probe that looked for a returned
  -- column inside src read as NOT IN forever, on a file that had been
  -- run. Hence args, for the cases where the signature is what changed.
  select p.proname::text as n,
         p.prosrc as src,
         coalesce(array_to_string(p.proargnames, ','), '') as args
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
),
-- Counting rows in a table that may not exist cannot be written straight:
-- the query is parsed before the guard can stop it, so a missing table is
-- an error rather than a 0. The statement is chosen first and run second.
cnt as (
  select n.what, (xpath('/row/c/text()', query_to_xml(n.q, false, true, '')))[1]::text::bigint as v
    from (values
      ('open_geofence', case when to_regclass('public.alerts') is null then 'select 0 as c'
         else 'select count(*) as c from alerts where type = ''geofence'' and status = ''open''' end),
      ('shifts',  case when to_regclass('public.shifts')  is null then 'select 0 as c'
         else 'select count(*) as c from shifts'  end),
      ('punches', case when to_regclass('public.punches') is null then 'select 0 as c'
         else 'select count(*) as c from punches' end),
      ('alerts',  case when to_regclass('public.alerts')  is null then 'select 0 as c'
         else 'select count(*) as c from alerts'  end),
      ('pools_unplaced', case when not exists (
           select 1 from information_schema.columns
            where table_schema='public' and table_name='pools'
              and column_name='location_id') then 'select 0 as c'
         else 'select count(*) as c from pools where location_id is null' end)
    ) as n(what, q)
),
chk (ord, file, adds, state) as (values

  -- ── Attendance ──────────────────────────────────────────────────────
  (1, 'supabase_attendance_phase1_migration.sql', 'the attendance tables and locations',
      case when to_regclass('public.attendance_settings') is not null
           then 'IN' else 'NOT IN' end),
  (2, 'supabase_attendance_phase2_auth_migration.sql', 'Supabase Auth accounts for logins',
      case when exists (select 1 from col where t='app_users' and c='auth_user_id')
           then 'IN' else 'NOT IN' end),
  (3, 'supabase_attendance_phase3_alerts_migration.sql', 'alerts, with a snapshot of the shift',
      case when exists (select 1 from col where t='alerts' and c='shift_snapshot')
           then 'IN' else 'NOT IN' end),
  (4, 'supabase_attendance_phase3b_reason_window.sql', 'a window for editing a reason',
      case when exists (select 1 from col where t='attendance_settings' and c='reason_edit_window_min')
           then 'IN' else 'NOT IN' end),
  (5, 'supabase_attendance_phase3c_void_closes_alerts.sql', 'voiding a shift closes its alerts',
      case when exists (select 1 from fn where n='attendance_close_alerts_on_void')
           then 'IN' else 'NOT IN' end),
  (6, 'supabase_attendance_phase4_password_change.sql', 'one password change, on the phone',
      case when to_regclass('public.attendance_password_state') is not null
           then 'IN' else 'NOT IN' end),
  (7, 'supabase_attendance_phase4b_absence_supersedes.sql', 'an absence closes its no-check-in',
      case when exists (select 1 from fn where n='attendance_scan_alerts'
                          and src like '%superseded_by_absence%')
           then 'IN' else 'NOT IN' end),
  (8, 'supabase_attendance_phase4c_reason_codes.sql', 'one-tap reasons',
      case when exists (select 1 from col where t='alerts' and c='worker_reason_code')
           then 'IN' else 'NOT IN' end),
  (9, 'supabase_alerts_raise_once.sql', 'a resolved alert is not raised again',
      case when exists (select 1 from fn where n='attendance_scan_alerts'
                          and src like '%not exists%')
           then 'IN' else 'NOT IN' end),
  (10, 'supabase_geofence_no_alert.sql', 'a refused check-in raises no alert',
      case when to_regclass('public.alerts') is null then 'NOT IN'
           when (select v from cnt where what='open_geofence') > 0
           then 'NOT IN' else 'IN' end),

  -- ── Leave ───────────────────────────────────────────────────────────
  (11, 'supabase_leave_phase1_migration.sql', 'leave types, allowances and requests',
      case when to_regclass('public.leave_types') is not null
           then 'IN' else 'NOT IN' end),
  (12, 'supabase_leave_phase2_migration.sql', 'applying for and deciding leave',
      case when exists (select 1 from fn where n='apply_for_leave')
           then 'IN' else 'NOT IN' end),
  (13, 'supabase_leave_phase3_hr_role.sql', 'the old hr_admin seat',
      'SUPERSEDED'),
  (14, 'supabase_leave_phase4_hr_on_phone.sql', 'rostering from the phone',
      case when exists (select 1 from fn where n='get_rosterable_crew')
           then 'IN' else 'NOT IN' end),
  (15, 'supabase_leave_phase5_one_credential.sql', 'one login for an office seat',
      'SUPERSEDED'),
  (16, 'supabase_leave_phase6_doc_retention.sql', 'how long medical certificates are kept',
      case when exists (select 1 from col where t='attendance_settings' and c='leave_doc_retention_months')
           then 'IN' else 'NOT IN' end),
  (17, 'supabase_leave_opening_balance.sql', 'leave already taken before this system',
      case when exists (select 1 from col where t='leave_entitlements' and c='days_taken_before')
           then 'IN' else 'NOT IN' end),
  (18, 'supabase_unpaid_leave_is_leave.sql', 'unpaid leave actually marked unpaid',
      case when exists (select 1 from fn where n='decide_leave' and src like '%is_unpaid_leave%')
           then 'IN' else 'NOT IN' end),

  -- ── Crew and HR ─────────────────────────────────────────────────────
  (19, 'supabase_crew_archive_migration.sql', 'archiving a leaver',
      case when exists (select 1 from col where t='admin_employees' and c='archived_at')
           then 'IN' else 'NOT IN' end),
  (20, 'supabase_crew_onboarding_migration.sql', 'the onboarding link and applications',
      case when to_regclass('public.crew_invites') is not null
           then 'IN' else 'NOT IN' end),
  (21, 'supabase_hr_phase1_migration.sql', 'crew files and probation',
      case when to_regclass('public.crew_documents') is not null
           then 'IN' else 'NOT IN' end),
  (22, 'supabase_hr_phase2_roles.sql', 'leave approval is the owner''s alone',
      case when exists (select 1 from fn where n='attendance_is_hr'
                          and src like '%center_owner%' and src not like '%administrator%')
           then 'IN' else 'NOT IN' end),
  (23, 'supabase_hr_phase3_separate_platforms.sql', 'website and attendance logins split apart',
      case when exists (select 1 from fn where n='my_login_kind')
           then 'IN' else 'NOT IN' end),
  (24, 'supabase_crew_delete_guard.sql', 'a record with history cannot be deleted',
      case when exists (select 1 from fn where n='crew_delete_or_explain')
           then 'IN' else 'NOT IN' end),
  (25, 'supabase_login_linkage_repair.sql', 'dead sign-in pointers cleared',
      -- The two versions of this function differ only in what they
      -- return: has_signed_in before, ready_to_link and last_login_at
      -- after. That is the signature, so it is args, not src.
      case when exists (select 1 from fn where n='office_logins_for_linking'
                          and args like '%ready_to_link%')
           then 'IN' else 'NOT IN' end),
  (26, 'supabase_roles_restructure.sql', 'the four seats as they are named now',
      case when exists (select 1 from fn where n='attendance_is_admin' and src like '%center_owner%')
           then 'IN' else 'NOT IN' end),

  -- ── Money and the website ───────────────────────────────────────────
  (27, 'supabase_voucher_amendments_migration.sql', 'the voucher amendment log',
      case when to_regclass('public.voucher_amendments') is not null
           then 'IN' else 'NOT IN' end),
  (28, 'supabase_voucher_amendments_writeonce.sql', 'that log made write-once',
      case when exists (select 1 from fn where n='amend_voucher')
           then 'IN' else 'NOT IN' end),
  (29, 'supabase_payment_methods_migration.sql', 'payment methods',
      case when to_regclass('public.payment_methods') is not null
           then 'IN' else 'NOT IN' end),
  (30, 'supabase_public_website_migration.sql', 'the public pricing and schedule',
      case when to_regclass('public.public_pricing') is not null
           then 'IN' else 'NOT IN' end),
  (31, 'supabase_marked_full_migration.sql', 'a session marked full',
      case when exists (select 1 from col where t='weekly_sessions' and c='marked_full')
           then 'IN' else 'NOT IN' end),
  (32, 'supabase_week_scope_migration.sql', 'sessions scoped to a week',
      case when exists (select 1 from col where t='weekly_sessions' and c='week_start_date')
           then 'IN' else 'NOT IN' end),
  (33, 'supabase_tc_digital_acceptance_migration.sql', 'signed terms on the intake form',
      case when exists (select 1 from col where t='tc_acceptances' and c='signature_name')
           then 'IN' else 'NOT IN' end),
  (34, 'supabase_rls_phase0_lock_app_users.sql', 'password hashes out of the browser''s reach',
      case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                         where n.nspname='public' and c.relname='app_users' and c.relrowsecurity)
           then 'IN' else 'NOT IN' end),

  -- ── Locking the older half of the system down ───────────────────────
  (35, 'supabase_rls_stage_a.sql', 'the scheduler''s tables closed to the public key',
      case when exists (select 1 from fn where n='is_website_login')
           then 'IN' else 'NOT IN' end),
  (36, 'supabase_rls_stage_b.sql', 'the intake form''s tables closed too',
      case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                         where n.nspname='public' and c.relname='students' and c.relrowsecurity)
           then 'IN' else 'NOT IN' end),
  (37, 'supabase_roles_viewer_cs.sql', 'Timetable (view only) and Customer Service',
      case when exists (select 1 from fn where n='can_edit_sessions')
           then 'IN' else 'NOT IN' end),

  -- ── Seats and people ────────────────────────────────────────────────
  (38, 'supabase_scheduler_seat_changes.sql', 'Zoe schedules, Tony does not',
      case when exists (select 1 from app_users
                         where lower(username)='zoelim' and role='scheduler')
           then 'IN' else 'NOT IN' end),

  -- ── The parent app''s groundwork ────────────────────────────────────
  (39, 'supabase_parent_accounts_migration.sql', 'one account per family, by phone',
      case when to_regclass('public.parent_accounts') is not null
           then 'IN' else 'NOT IN' end),
  (40, 'supabase_parent_phone_international.sql', 'numbers with a country code, and the 60… fix',
      case when exists (select 1 from fn where n='ss_phones' and src like '%left(d, 2)%')
           then 'IN' else 'NOT IN' end),
  (41, 'supabase_parent_account_repair.sql', 'children whose account pointed at nothing',
      case when exists (select 1 from fn where n='ss_phone_looks_fake')
           then 'IN' else 'NOT IN' end),
  (42, 'supabase_instructor_pool_links.sql', 'the timetable joined to the attendance app',
      case when exists (select 1 from col where t='scheduler_instructors' and c='crew_id')
             and exists (select 1 from col where t='pools' and c='location_id')
           then 'IN' else 'NOT IN' end),
  (43, 'supabase_pool_location_links.sql', 'every pool placed at a location (SBIS Collab included)',
      case when not exists (select 1 from col where t='pools' and c='location_id')
             then 'NOT IN'
           when (select v from cnt where what='pools_unplaced') > 0
             then 'NOT IN'
           else 'IN' end),
  (44, 'supabase_invoice_account_link.sql', 'invoices joined to the family that owes them',
      case when exists (select 1 from col where t='invoices' and c='account_id')
           then 'IN' else 'NOT IN' end),

  -- ── The parent app itself ───────────────────────────────────────────
  (45, 'supabase_parent_messages.sql', 'messages, broadcasts, class reminders',
      case when to_regclass('public.parent_messages') is not null
             and exists (select 1 from fn where n='parent_render'
                                            and src like '%order by t.idx%')
           then 'IN' else 'NOT IN' end),
  (46, 'supabase_parent_app_reads.sql', 'what a parent may read: family, schedule, bills',
      case when exists (select 1 from fn where n='my_schedule')
           then 'IN' else 'NOT IN' end),
  (47, 'supabase_parent_account_claim.sql', 'a phone that signs in is matched to its account',
      case when exists (select 1 from fn where n='claim_parent_account')
           then 'IN' else 'NOT IN' end),
  (48, 'supabase_progress_notes.sql', 'coaches'' notes on a swimmer',
      case when to_regclass('public.student_progress_notes') is not null
           then 'IN' else 'NOT IN' end),

  -- ── Rostering and credits ───────────────────────────────────────────
  (49, 'supabase_roster_draft_live.sql', 'a roster week can be drafted before it goes live',
      case when to_regclass('public.roster_weeks') is not null
           then 'IN' else 'NOT IN' end),
  (50, 'supabase_class_credit_policy.sql', 'replacement policy, emergencies, negative credits',
      case when to_regclass('public.class_policy_settings') is not null
           then 'IN' else 'NOT IN' end),
  (51, 'supabase_coach_roster.sql', 'the coach''s class list — run AFTER the file above',
      -- Three markers, because this file has been re-run twice and an old
      -- copy still leaves the functions behind. All three or it is not the
      -- version that is in the repo: the weekday fix, the draft gate, and
      -- the no-credit confirm.
      case when exists (select 1 from fn where n='get_my_session_roster'
                                           and src like '%weekday - 1%'
                                           and src like '%roster_week_is_live%')
             and exists (select 1 from fn where n='mark_attendance'
                                            and src like '%attendance_unpaid%')
           then 'IN' else 'NOT IN' end)
)
-- ════════════════════════════════════════════════════════════════════════
--  ONE RESULT, ON PURPOSE
-- ════════════════════════════════════════════════════════════════════════
--  This was three separate queries, and the Supabase SQL editor shows
--  only the last one — so the file list, which is the point of the whole
--  exercise, was never on screen. Twice the lock table came back instead
--  and read as the answer.
--
--  So it is one query now. Three parts, stacked, with the part column
--  saying which is which:
--
--    migration        the files, worst news first
--    trial data       what the go-live purge would clear
--    table security   row security, open ones first
--
--  Paste the whole thing back. It is long and that is fine.
-- ════════════════════════════════════════════════════════════════════════
select part, action, state, name, detail
  from (

    -- ── The files ───────────────────────────────────────────────────────
    select 1 as grp,
           case state when 'NOT IN' then 0 when 'CHECK BY EYE' then 1
                      when 'IN' then 2 else 3 end as sub,
           ord as ord,
           'migration'::text                                        as part,
           (case state when 'NOT IN' then '>>> RUN THIS' else '' end)::text as action,
           state::text                                              as state,
           file::text                                               as name,
           adds::text                                               as detail
      from chk

    union all

    -- ── What the purge would clear ──────────────────────────────────────
    -- Three files leave nothing behind to find, by design, and so are not
    -- in the list above:
    --
    --   supabase_migration_check.sql        this file
    --   supabase_parent_phone_worklist.sql  read-only; the list shrinking
    --                                       is the point
    --   supabase_go_live_purge.sql          clears the trial attendance.
    --
    -- supabase_attendance_clear_test_data.sql is the purge's predecessor
    -- and the same applies. Three zeros below mean either the purge has
    -- run or there was never anything to clear.
    select 2,
           0,
           (case what when 'shifts' then 1 when 'punches' then 2 else 3 end),
           'trial data'::text,
           ''::text,
           ''::text,
           what::text,
           v::text
      from cnt
     where what in ('shifts','punches','alerts')

    union all

    -- ── Which tables are open to the public key ─────────────────────────
    -- Row security off means the anon key in every page we serve can read
    -- and write that table.
    select 3,
           (case when c.relrowsecurity then 1 else 0 end),
           0,
           'table security'::text,
           (case when c.relrowsecurity then '' else '>>> OPEN TO THE ANON KEY' end)::text,
           (case when c.relrowsecurity then 'locked' else 'open' end)::text,
           c.relname::text,
           ''::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'

  ) z
 order by grp, sub, ord, name;

-- ── Edge Functions are not in this list ─────────────────────────────────
-- Nothing in the database knows which Edge Functions are deployed, so no
-- query can answer it. Check them by eye in the dashboard, under Edge
-- Functions, where each one shows the date it was last deployed:
--
--   punch           has the draft-roster gate. If its last deploy is
--                   older than supabase_roster_draft_live.sql was run, a
--                   draft week is still punchable from the phone.
--   parent-signin   the parent app's gate, and the WhatsApp channel.
--   public-intake   the public intake form posts to this. Not deployed
--                   reads in the browser as "failed to fetch", which
--                   looks like a network fault and is not one.
--   login, staff-auth, admin-users, leave-docs-purge
--                   older, and unchanged for some time.
--
-- Anything deployed that is NOT in the list above is not in the repo.
-- Open it in the dashboard and find out what it is before deleting it.
