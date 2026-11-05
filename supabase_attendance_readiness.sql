-- ════════════════════════════════════════════════════════════════════════
--  Can my instructors actually use the attendance app this week?
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--  It creates nothing, changes nothing, and is safe to run at any time,
--  including in the middle of a session.
--
--  WHY THIS EXISTS
--  "Is the app working" has never been one question. A coach opens it,
--  signs in, and sees an empty day. Nothing has failed: no error, no
--  blank screen, no message. The app is working perfectly and showing
--  them the truth, which is that nothing has been published for them to
--  see. From the poolside that is indistinguishable from a broken app,
--  and the first thing anybody does about it is doubt the software.
--
--  So this walks the same chain the app walks, in order, and says where
--  it stops.
--
--  WHAT DECIDES WHETHER A COACH SEES A CLASS
--  Two routes, and either one is enough:
--
--    1. NAMED — the coach is on session_instructors for that class.
--       Works whatever the roster says. This is the old behaviour and it
--       has never depended on publishing anything.
--
--    2. ROSTERED — the coach has a shift at that pool's location,
--       covering the hour the class runs, in a week somebody has
--       PUBLISHED. This is what makes a three-coach squad session
--       markable by all three.
--
--  Route 2 is the one with a switch in it. roster_week_is_live() answers
--  false for a week with no roster_weeks row and for a week whose row has
--  published_at null — and "no row means no" is the deliberate default.
--  146 shifts can sit in the database, correct in every particular, and
--  be invisible to every coach because nobody pressed Publish.
--
--  HOW TO READ THE RESULT
--  Rows are in the order the chain runs. The first one that reads
--  "** " is where it stops; everything below it is downstream of that
--  and may be reporting a consequence rather than a cause.
-- ════════════════════════════════════════════════════════════════════════

with
-- Monday of the current week, in Malaysian time. The server thinks in
-- UTC, which before 8am local is still yesterday, and yesterday in the
-- small hours of a Monday is last week's roster.
today as (
  select (now() at time zone 'Asia/Kuala_Lumpur')::date as d
),
wk as (
  select roster_week_of(d) as this_mon, roster_week_of(d) + 7 as next_mon from today
),

-- ── The classes scheduled this week ────────────────────────────────────
-- week_start_date is the Monday and weekday counts from 1, so the real
-- date is week_start_date + (weekday - 1). Getting that wrong by one is
-- what made nine rostered windows cover not a single class.
sess as (
  select ws.id,
         (ws.week_start_date + (ws.weekday - 1))::date      as on_date,
         (ws.start_minute * interval '1 minute')::time      as at_time,
         ws.pool_id,
         ws.cancelled_at
    from weekly_sessions ws, wk
   where ws.week_start_date = wk.this_mon
),
live as (
  select s.id,
         exists (select 1 from session_instructors si where si.session_id = s.id) as named,
         exists (
           select 1
             from pools p
             join shifts sh on sh.location_id = p.location_id
            where p.id = s.pool_id
              and not sh.is_void
              and sh.shift_date = s.on_date
              and roster_week_is_live(sh.shift_date)
              and s.at_time >= sh.start_time
              and s.at_time <  sh.end_time
         ) as rostered
    from sess s
   where s.cancelled_at is null
),

-- ── The build gate ─────────────────────────────────────────────────────
-- BUILD in attendance/app.js and attendance/sw.js is 16. A min_build
-- above that locks every phone out of the app entirely, which is the one
-- failure here that looks like a failure.
gate as (
  select coalesce((select min_build from app_clients where app = 'attendance'), 0) as m
),

-- ── The functions the app calls ────────────────────────────────────────
fns as (
  select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
)

select part, thing, answer from (

  select 1 as part, 'week being reported' as thing,
         (select to_char(this_mon,'Dy DD Mon YYYY') || ' to '
                 || to_char(this_mon + 6,'Dy DD Mon YYYY') from wk) as answer

  union all
  select 2, 'roster for THIS week',
         case when (select roster_week_is_live((select this_mon from wk)))
              then 'published — rostered coaches can see and mark'
              else '** NOT PUBLISHED — no coach sees a class on this route **' end

  union all
  select 3, 'roster for NEXT week',
         case when (select roster_week_is_live((select next_mon from wk)))
              then 'published'
              else 'not published yet (fine until the week starts)' end

  union all
  select 4, 'shifts entered for this week',
         (select count(*)::text || ' shift'  || case when count(*) = 1 then '' else 's' end
                 || ', ' || count(distinct crew_id)::text
                 || ' coach' || case when count(distinct crew_id) = 1 then '' else 'es' end
            from shifts, wk
           where not is_void
             and shift_date >= wk.this_mon and shift_date < wk.this_mon + 7)

  union all
  select 5, 'classes scheduled this week', (select count(*)::text from live)

  union all
  select 6, 'visible because a coach is NAMED on them',
         (select count(*)::text from live where named)

  union all
  select 7, 'visible because a coach is ROSTERED to the water',
         (select count(*)::text from live where rostered)

  union all
  select 8, 'visible to NOBODY — cannot be marked by anyone',
         (select case when count(*) = 0 then '0'
                      else '** ' || count(*)::text || ' class'
                           || case when count(*) = 1 then '' else 'es' end || ' **' end
            from live where not named and not rostered)

  union all
  select 9, 'the build gate (phones run build 16)',
         (select case when m > 16 then '** min_build is ' || m || ' — every phone is locked out **'
                      when m = 0  then 'no app_clients row; the gate fails open, which is by design'
                      else 'min_build ' || m || ', so build 16 is allowed' end from gate)

  union all
  select 10, 'marking attendance',
         (select case when count(*) = 0 then '** mark_attendance is missing **'
                      else 'mark_attendance present (' || count(*)::text || ' signature'
                           || case when count(*) = 1 then '' else 's' end || ')' end
            from fns where proname = 'mark_attendance')

  union all
  select 11, 'who may mark',
         (select case when count(*) = 0 then '** coach_can_mark_session is missing **'
                      else 'coach_can_mark_session present' end
            from fns where proname = 'coach_can_mark_session')

  union all
  select 12, 'the roster screen',
         (select case when count(*) = 0 then '** get_my_session_roster is missing **'
                      else 'get_my_session_roster present' end
            from fns where proname = 'get_my_session_roster')

  union all
  select 13, 'progress notes',
         (select case when count(*) = 0 then '** can_note_on_student is missing **'
                      else 'can_note_on_student present — no time limit on writing one' end
            from fns where proname = 'can_note_on_student')

  union all
  select 14, 'what to do',
         (select case
            when not roster_week_is_live((select this_mon from wk))
              then 'Publish this week''s roster in the Scheduler. Until then a coach sees only classes they are named on.'
            when (select count(*) from live where not named and not rostered) > 0
              then 'Published, but some classes sit outside every shift window. Check those pools and hours.'
            else 'Nothing. Every class this week is visible to somebody.'
          end)

) z order by part;
