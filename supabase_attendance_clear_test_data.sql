-- ============================================================================
-- Star Swim Attendance — clear test data before going live
-- ----------------------------------------------------------------------------
-- Run this once you have finished trialling and want a clean slate for real
-- attendance. It removes punches, alerts and rostered sessions, and the audit
-- trail those produced.
--
-- ⚠️  These are REAL deletes, not voids.
--     The rest of this system follows void-not-delete, deliberately — a punch
--     or a session is evidence and never disappears. This file is the one
--     exception, because trial data is not evidence of anything and carrying
--     it into payroll would be worse than losing it. Do not reuse this script
--     as a way to tidy up live data later: void the rows instead.
--
-- Nothing here touches the schema, your locations, your staff logins or the
-- Crew records. Those are set up once and kept.
--
-- HOW TO USE
--   1. Run STEP 1 on its own and read the counts.
--   2. If they match what you expect, run STEP 2.
--   3. Run STEP 3 to confirm everything is zero.
-- ============================================================================


-- ─── STEP 1 — preview. Changes nothing. ─────────────────────────────────────
select 'punches'      as table_name, count(*) as rows_to_delete from punches
union all select 'alerts',   count(*) from alerts
union all select 'shifts',   count(*) from shifts
union all select 'audit_log (attendance rows only)', count(*)
  from audit_log where table_name in ('shifts','punches','alerts')
order by 1;

-- Also worth a look before you wipe: what the trial actually recorded.
--   select s.shift_date, e.full_name, l.name as location, s.status,
--          s.late_min, s.early_min
--   from shifts s
--   join admin_employees e on e.id = s.crew_id
--   join locations l on l.id = s.location_id
--   order by s.shift_date, s.start_time;


-- ─── STEP 2 — the purge. ────────────────────────────────────────────────────
-- One transaction: it all goes or none of it does. Order matters, because
-- punches and alerts both point at shifts.
begin;

-- The audit triggers would otherwise write a DELETE row for every row we
-- remove here, leaving a trail of the cleanup instead of a clean slate.
alter table shifts  disable trigger shifts_audit;
alter table punches disable trigger punches_audit;
alter table alerts  disable trigger alerts_audit;

delete from punches;
delete from alerts;
delete from shifts;

-- Drop the history the trial generated, but leave any other table's audit
-- rows alone — this log is shared.
delete from audit_log where table_name in ('shifts','punches','alerts');

alter table shifts  enable trigger shifts_audit;
alter table punches enable trigger punches_audit;
alter table alerts  enable trigger alerts_audit;

commit;


-- ─── STEP 3 — confirm. Every count should be 0. ─────────────────────────────
select 'punches' as table_name, count(*) as remaining from punches
union all select 'alerts',   count(*) from alerts
union all select 'shifts',   count(*) from shifts
union all select 'audit_log (attendance rows only)', count(*)
  from audit_log where table_name in ('shifts','punches','alerts')
order by 1;


-- ============================================================================
-- OPTIONAL EXTRAS — only if you want these gone too. Each is independent.
-- ============================================================================

-- A. Test locations. Keep the real pools; name the ones to remove.
--    Retiring is usually better than deleting, and is what the Locations
--    screen does, because a deleted location breaks any session pointing at
--    it. Deleting only works once STEP 2 has removed those sessions.
--
--    update locations set is_active = false where name in ('Test Pool');
--    delete from locations where name in ('Test Pool');

-- B. PDPA consent. Clearing this makes every worker see the location notice
--    again at their next sign-in. Only do that if the trial consent should
--    not count — the first-agreement date is the one PDPA cares about.
--
--    delete from attendance_consents;

-- C. Test worker logins. This unlinks them in the app but does NOT remove the
--    Supabase Auth user — do that under Authentication → Users, or use the
--    Remove button on the Crew screen, which handles both.
--
--    update admin_employees set auth_user_id = null, staff_id = null
--    where full_name in ('Test Instructor');

-- D. Settings and categories are configuration, not data. Leave them unless
--    you changed them while experimenting:
--      select * from attendance_settings;
--      select name, sort_order from shift_categories order by sort_order;
-- ============================================================================
