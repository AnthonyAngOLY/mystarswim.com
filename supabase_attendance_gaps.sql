-- ════════════════════════════════════════════════════════════════════════
--  The classes only one person can mark
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--  Nothing is created or changed.
--
--  WHY
--  The readiness check counts a class as visible by either of two routes:
--  a coach NAMED on it, or a coach ROSTERED to that pool's location for
--  the hour it runs. Both being above zero is good news, but the gap
--  between them is the interesting number. A class that is named-only
--  can be marked by exactly one person.
--
--  For a personal lesson that is correct and wanted. For a squad session
--  with three coaches in the water it is the thing we built the rostered
--  route to fix — and it fails on the day it matters, which is the day
--  the named coach is off and somebody covers. The cover coach opens the
--  app and the class is not there.
--
--  So this lists them, says why each one falls outside every shift, and
--  groups by programme, because the programme is what tells you whether
--  a single marker is the design or an accident.
--
--  WHAT TO DO WITH IT
--  Nothing, for anything personal or private. For a group or squad
--  session, either extend the shift that should have covered it or add
--  the other coaches to the class in the Scheduler.
--
--  ONE NOTE ON HOW COVER IS JUDGED
--  A shift covers a class when the class STARTS inside it. A class
--  starting at 16:45 under a shift ending at 17:00 counts as covered,
--  even though it runs past the end. That is deliberate — a coach who
--  begins a class finishes it — but it means a shift ending exactly when
--  a class starts covers nothing.
-- ════════════════════════════════════════════════════════════════════════

with
today as (select (now() at time zone 'Asia/Kuala_Lumpur')::date as d),
wk    as (select roster_week_of(d) as mon from today),

sess as (
  select ws.id,
         (ws.week_start_date + (ws.weekday - 1))::date  as on_date,
         (ws.start_minute * interval '1 minute')::time   as at_time,
         ws.pool_id,
         coalesce(lt.name, '—')::text                    as programme,
         coalesce(p.name, '—')::text                     as pool,
         p.location_id
    from weekly_sessions ws
    join wk on ws.week_start_date = wk.mon
    left join pools p                   on p.id = ws.pool_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where ws.cancelled_at is null
),

judged as (
  select s.*,
         exists (select 1 from session_instructors si where si.session_id = s.id) as named,
         exists (
           select 1 from shifts sh
            where sh.location_id = s.location_id
              and not sh.is_void
              and sh.shift_date = s.on_date
              and roster_week_is_live(sh.shift_date)
              and s.at_time >= sh.start_time
              and s.at_time <  sh.end_time) as rostered,
         exists (
           select 1 from shifts sh
            where sh.location_id = s.location_id
              and not sh.is_void
              and sh.shift_date = s.on_date) as any_shift_there
    from sess s
),

-- Named, but nobody is rostered to the water while it runs. One marker.
gap as (select * from judged where named and not rostered)

select line, programme, detail from (

  -- The summary first, so the shape is visible before the list.
  select 0 as sort, programme as line,
         count(*)::text || ' class' || case when count(*) = 1 then '' else 'es' end
           || ' only one person can mark' as programme,
         'of ' || (select count(*)::text from judged j where j.programme = g.programme)
           || ' this week' as detail,
         programme as grp, ''::text as ord
    from gap g group by programme

  union all

  select 1, '   ' || to_char(on_date, 'Dy DD Mon') || '  ' || to_char(at_time, 'HH24:MI'),
         pool,
         case when not any_shift_there
              then 'no shift at this pool''s location that day'
              else 'shifts that day, but none covering ' || to_char(at_time, 'HH24:MI') end,
         programme, to_char(on_date, 'YYYYMMDD') || to_char(at_time, 'HH24MI')
    from gap

  union all

  -- Always one row, so a clean week reports itself rather than returning
  -- nothing at all, which reads as a query that failed.
  select 2, 'ALL CLEAR',
         'every class this week can be marked by more than one person',
         'nothing to do',
         'zzzz', ''
    from judged having not exists (select 1 from gap)

) z order by grp, sort, ord;
