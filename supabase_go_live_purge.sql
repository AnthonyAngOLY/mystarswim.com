-- ════════════════════════════════════════════════════════════════════════
--  Clear the trial. Keep the people.
-- ════════════════════════════════════════════════════════════════════════
--  Run STEP 1 on its own and read it. Run STEP 2 only if the counts are
--  what you expect. Run STEP 3 to confirm.
--
--  ⚠️  STEP 2 is a REAL delete, not a void.
--      Everywhere else this system voids rather than deletes, on purpose:
--      a punch or a session is evidence. This file is the exception, and
--      the only one, because trial data is evidence of nothing and
--      carrying it into the first payroll is worse than losing it. Do not
--      reach for this file again to tidy live data. Void those rows.
--
--  WHAT GOES
--    punches, alerts, shifts, shift_patterns   the attendance record
--    leave_requests                            applications and decisions
--    audit_log rows for those tables           so the clean slate is clean
--
--  WHAT STAYS, AND IS CHECKED IN STEP 3
--    admin_employees        every crew record, exactly as it is
--    their attendance logins, passwords and PDPA consents
--    app_users              every website login and every seat. sysadmin
--                           and Centre Owner keep everything; this file
--                           does not touch roles or privileges at all
--    locations, leave types and allowances, shift categories, pay rates,
--    attendance settings    configuration, not data
--    vouchers, students, invoices    nothing in this file goes near them
--
--  ONE THING TO KNOW ABOUT LEAVE DOCUMENTS
--  A medical certificate attached to a leave request is a file in Storage,
--  and deleting the request row does not delete the file. If the trial
--  included MC uploads, clear the bucket too: Storage → leave-docs. The
--  optional block at the end lists what the rows pointed at before you
--  delete them, so you know what to look for.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 — preview. Changes nothing. ═════════════════════════════════
select 'punches'        as table_name, count(*) as rows_to_delete from punches
union all select 'alerts',         count(*) from alerts
union all select 'shifts',         count(*) from shifts
union all select 'shift_patterns', count(*) from shift_patterns
union all select 'leave_requests', count(*) from leave_requests
union all select 'audit_log (those tables only)', count(*)
  from audit_log where table_name in ('shifts','punches','alerts')
order by 1;

-- And what survives, so there are no surprises on Monday.
select 'crew records (kept)'        as table_name, count(*) as rows_kept from admin_employees
union all select 'attendance logins (kept)',  count(*) from admin_employees where auth_user_id is not null
union all select 'website logins (kept)',     count(*) from app_users
union all select 'PDPA consents (kept)',      count(*) from attendance_consents
union all select 'password state (kept)',     count(*) from attendance_password_state
union all select 'locations (kept)',          count(*) from locations
union all select 'leave allowances (kept)',   count(*) from leave_entitlements
order by 1;

-- Worth one look before it goes. This is the trial, in one table.
--   select s.shift_date, e.full_name, l.name as location, s.status
--     from shifts s
--     join admin_employees e on e.id = s.crew_id
--     left join locations l  on l.id = s.location_id
--    order by s.shift_date, s.start_time;


-- ═══ STEP 2 — the purge. ════════════════════════════════════════════════
-- One transaction: all of it or none of it. Order matters — punches and
-- alerts both point at shifts.
begin;

-- The audit triggers would write a DELETE row for every row removed here,
-- which would leave a trail of the cleanup in place of a clean slate.
-- Found by name rather than assumed, so a database that never had them
-- does not fall over on this line.
do $$
declare t record;
begin
  for t in select c.relname as tbl, g.tgname as trg
             from pg_trigger g
             join pg_class c on c.oid = g.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and g.tgname in ('shifts_audit','punches_audit','alerts_audit')
  loop
    execute format('alter table public.%I disable trigger %I', t.tbl, t.trg);
  end loop;
end $$;

delete from punches;
delete from alerts;
delete from shifts;

-- Empty in practice — the repeating roster writes real sessions rather
-- than patterns — but cleared anyway, so nothing from the trial can seed
-- a live week.
delete from shift_patterns;

-- Applications and the decisions on them. Allowances are configuration and
-- stay; what goes is the trial's usage of them.
delete from leave_requests;

-- The history the trial generated, and only that. This log is shared.
delete from audit_log where table_name in ('shifts','punches','alerts');

do $$
declare t record;
begin
  for t in select c.relname as tbl, g.tgname as trg
             from pg_trigger g
             join pg_class c on c.oid = g.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and g.tgname in ('shifts_audit','punches_audit','alerts_audit')
  loop
    execute format('alter table public.%I enable trigger %I', t.tbl, t.trg);
  end loop;
end $$;

commit;


-- ═══ STEP 3 — confirm. ══════════════════════════════════════════════════
-- Every one of these should read 0.
select 'punches' as table_name, count(*) as remaining from punches
union all select 'alerts',         count(*) from alerts
union all select 'shifts',         count(*) from shifts
union all select 'shift_patterns', count(*) from shift_patterns
union all select 'leave_requests', count(*) from leave_requests
union all select 'audit_log (those tables only)', count(*)
  from audit_log where table_name in ('shifts','punches','alerts')
order by 1;

-- And the people are all still here.
select 'crew records'      as kept, count(*) as n from admin_employees
union all select 'attendance logins', count(*) from admin_employees where auth_user_id is not null
union all select 'website logins',    count(*) from app_users
order by 1;

-- Seats untouched. sysadmin and Centre Owner read exactly as before.
select username, role,
       case when role in ('sysadmin','center_owner')
            then 'everything, both sides, and the attendance app'
            when role = 'administrator' then 'both website sides'
            else 'scheduling side only' end as reach
  from app_users
 where coalesce(is_active, true)
 order by case role when 'sysadmin' then 1 when 'center_owner' then 2
                    when 'administrator' then 3 else 4 end, username;

-- The audit triggers are back on. Anything other than 'on' here means
-- STEP 2 did not finish — tell Claude before anybody clocks in.
select c.relname as table_name,
       case g.tgenabled when 'O' then 'on'
            else 'STILL DISABLED — ' || g.tgenabled::text end as audit_trigger
  from pg_trigger g
  join pg_class c on c.oid = g.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and g.tgname in ('shifts_audit','punches_audit','alerts_audit')
 order by 1;


-- ════════════════════════════════════════════════════════════════════════
--  OPTIONAL — none of this runs unless you uncomment it. Each stands alone.
-- ════════════════════════════════════════════════════════════════════════

-- A. Medical certificates from the trial. Run the SELECT first: it lists
--    the files in Storage those rows pointed at. The rows are already gone
--    by STEP 2, so do this BEFORE STEP 2 if you want the list — otherwise
--    look in Storage → leave-docs and clear it by hand.
--
--    select id, crew_id, document_path from leave_requests
--     where document_path is not null;

-- B. Probation records set during the trial. The dates on the crew rows
--    themselves are not touched by this; only the log of changes.
--
--    select count(*) from crew_probation_log;
--    delete from crew_probation_log;

-- C. Onboarding applications and invite links from the trial.
--
--    select count(*) from crew_applications;
--    delete from crew_applications;
--    delete from crew_invites;

-- D. PDPA consent. Clearing it makes every worker see the location notice
--    again at their next sign-in. Only do that if the trial agreement
--    should not count — the first-agreement date is the one PDPA cares
--    about, and re-asking resets it.
--
--    delete from attendance_consents;

-- E. Test locations. Retiring beats deleting: a deleted location breaks
--    any session pointing at it, though after STEP 2 there are none.
--
--    update locations set is_active = false where name in ('Test Pool');
-- ════════════════════════════════════════════════════════════════════════
