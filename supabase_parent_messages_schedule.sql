-- ════════════════════════════════════════════════════════════════════════
--  Make the reminders run on their own
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run — it
--  removes its own jobs before adding them, so running it twice leaves
--  one of each and not two.
--
--  WHY THIS IS A FILE OF ITS OWN
--  Everything else is a migration: it describes what the database is.
--  This decides that something happens without anybody asking, which is
--  a different kind of decision and worth making on purpose.
--
--  WHAT IT SCHEDULES
--  One tick an hour, calling both reminder jobs. They do not need to be
--  told when to act — each reads parent_message_settings, works out
--  whether anything is due, and returns having done nothing if not. So
--  the office can move the send time from noon to 4pm and this schedule
--  never changes.
--
--  WHY HOURLY RATHER THAN ONCE AT 4PM
--  A job that fires once a day has one chance. If the database is busy,
--  or Supabase restarts the worker in that minute, the reminders for
--  that day are simply not sent and nothing says so. Hourly means the
--  next tick picks it up, and sending twice is impossible: every message
--  carries a key naming the family and the day, and the second attempt
--  finds it already there.
--
--  THE CLOCK
--  pg_cron runs on UTC. The functions hold the Malaysian clock
--  themselves — the send hour, the quiet hours, the two-day lead — so an
--  hourly tick in UTC is the right instruction whatever the office sets.
--  Scheduling this for "4pm" in UTC would be midnight in Ipoh and would
--  quietly disagree with the setting the moment anybody changed it.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'star-swim-class-reminders') then
    perform cron.unschedule('star-swim-class-reminders');
  end if;
  if exists (select 1 from cron.job where jobname = 'star-swim-replacement-reminders') then
    perform cron.unschedule('star-swim-replacement-reminders');
  end if;
end $$;

-- Five past, and twenty past, rather than both on the hour: two jobs
-- starting in the same instant is a lock contending with itself for no
-- reason, and a few minutes either way means nothing to a reminder sent
-- two days ahead.
select cron.schedule('star-swim-class-reminders', '5 * * * *',
                     $cron$ select send_class_reminders(); $cron$);

select cron.schedule('star-swim-replacement-reminders', '20 * * * *',
                     $cron$ select send_replacement_reminders(); $cron$);


-- ─── What is now running ────────────────────────────────────────────────
select jobname as job, schedule, active,
       case when jobname like 'star-swim-class%'
            then 'class reminders — reads the send time from settings'
            else 'replacement reminders — same timer, different sentence' end as what
  from cron.job
 where jobname like 'star-swim-%'
 order by jobname;

-- To see what they have done, afterwards. cron.job_run_details keys on
-- jobid and carries no jobname — that lives on cron.job — so the two
-- have to be joined. Selecting jobname straight from the run details is
-- the obvious guess and it fails with "column jobname does not exist".
--
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d
--     join cron.job j on j.jobid = d.jobid
--    where j.jobname like 'star-swim-%'
--    order by d.start_time desc limit 20;
--
-- status is the useful column there, and only that. return_message
-- holds the command tag — "1 row" — because pg_cron records what the
-- statement returned, not what the function decided. The job's own
-- answer never reaches it.
--
-- So to see what actually went out, ask the inbox rather than the
-- scheduler. This is the one to keep:
--
--   select kind,
--          count(*)                                        as messages,
--          count(distinct account_id)                      as families,
--          to_char(max(created_at) at time zone 'Asia/Kuala_Lumpur',
--                  'Dy DD Mon, HH24:MI')                   as most_recent
--     from parent_messages
--    where created_at > now() - interval '7 days'
--    group by kind order by 2 desc;
--
-- A row of zero is not possible there — a kind with nothing sent simply
-- does not appear, which is the answer when a reminder did not go.
--
-- To stop them:
--
--   select cron.unschedule('star-swim-class-reminders');
--   select cron.unschedule('star-swim-replacement-reminders');
--
-- Or leave them running and switch the reminders off in Messages →
-- Reminders, which is the reversible way: the jobs keep ticking and
-- return "reminders are switched off" until somebody turns them back on.
