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
--  Run it, then paste the whole result back to Claude.
-- ════════════════════════════════════════════════════════════════════════

with
col as (
  select table_name::text as t, column_name::text as c
    from information_schema.columns where table_schema = 'public'
),
fn as (
  select p.proname::text as n, p.prosrc as src
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
         else 'select count(*) as c from alerts'  end)
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
      case when exists (select 1 from fn where n='office_logins_for_linking'
                          and src like '%ready_to_link%')
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
           then 'IN' else 'NOT IN' end)
)
select case state when 'NOT IN' then '>>> RUN THIS' else '' end as action,
       state, file, adds
  from chk
 order by case state when 'NOT IN' then 0 when 'CHECK BY EYE' then 1
                     when 'IN' then 2 else 3 end, ord;

-- ── And the one that is not a migration ─────────────────────────────────
-- supabase_attendance_clear_test_data.sql deletes the test attendance. It
-- leaves nothing behind to find, by design. This is what it would clear.
select (xpath('/row/c/text()', query_to_xml(
          case when to_regclass('public.shifts') is null then 'select 0 as c'
               else 'select count(*) as c from shifts' end, false, true, '')))[1]::text::bigint as shifts_now,
       (xpath('/row/c/text()', query_to_xml(
          case when to_regclass('public.punches') is null then 'select 0 as c'
               else 'select count(*) as c from punches' end, false, true, '')))[1]::text::bigint as punches_now,
       (xpath('/row/c/text()', query_to_xml(
          case when to_regclass('public.alerts') is null then 'select 0 as c'
               else 'select count(*) as c from alerts' end, false, true, '')))[1]::text::bigint as alerts_now;

-- ── Which tables are still open to the public key ───────────────────────
-- Row security off means the anon key in every page we serve can read and
-- write that table. The attendance and HR tables were locked down as they
-- were built; the scheduler's own tables never have been.
select c.relname as table_name,
       case when c.relrowsecurity then 'locked' else '>>> OPEN TO THE ANON KEY' end as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relrowsecurity, c.relname;
