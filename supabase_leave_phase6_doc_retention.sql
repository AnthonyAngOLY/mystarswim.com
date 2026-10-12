-- ============================================================================
-- Star Swim — how long medical certificates are kept
-- ----------------------------------------------------------------------------
-- Five years, from the day the application was made. The leave RECORD is not
-- touched: dates, kind, who decided it and their note stay for as long as the
-- employment record does. Only the image expires, because only the image is
-- the sensitive thing.
--
-- The deletion itself is done by the leave-docs-purge Edge Function, because
-- it has to go through the storage API. Removing a row from storage.objects
-- makes a file unreachable while leaving the bytes in the bucket, and
-- "unreachable" is not what the PDPA means by deleted.
--
-- This file sets the period and schedules the job.
-- ============================================================================

begin;

set local search_path = public, extensions;

alter table attendance_settings
  add column if not exists leave_doc_retention_months integer not null default 60;

alter table attendance_settings drop constraint if exists attendance_settings_doc_retention_sane;
alter table attendance_settings add constraint attendance_settings_doc_retention_sane
  check (leave_doc_retention_months between 1 and 240);

comment on column attendance_settings.leave_doc_retention_months is
  'Months a leave document is kept, from the date of application. The leave record itself is unaffected.';

update attendance_settings set leave_doc_retention_months = 60;

commit;

-- ============================================================================
-- §SCHEDULE IT
-- ----------------------------------------------------------------------------
-- Monthly is often enough for a five-year window, and a job that runs rarely
-- is a job worth watching, so run it by hand first and read the dry run.
--
-- Needs pg_net (Dashboard → Database → Extensions → pg_net). Replace
-- <PROJECT-REF> and <SERVICE-ROLE-KEY> before running.
--
--   select cron.schedule(
--     'leave_docs_purge',
--     '17 3 1 * *',                        -- 03:17 on the 1st, out of the way
--     $$
--       select net.http_post(
--         url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/leave-docs-purge',
--         headers := jsonb_build_object(
--                      'Content-Type',  'application/json',
--                      'Authorization', 'Bearer <SERVICE-ROLE-KEY>'),
--         body    := '{"commit": true}'::jsonb
--       );
--     $$);
--
-- WHAT IT WOULD DO, WITHOUT DOING IT — call the function with {} instead of
-- {"commit": true}. It reports what is in the bucket, how much is past its
-- date, how many uploads were abandoned, and deletes nothing.
--
-- §VERIFY
--   select leave_doc_retention_months from attendance_settings;        -- 60
--   select jobname, schedule from cron.job where jobname='leave_docs_purge';
--
-- CHANGE THE PERIOD LATER
--   update attendance_settings set leave_doc_retention_months = 36;
--
-- STOP THE JOB
--   select cron.unschedule('leave_docs_purge');
-- ============================================================================
