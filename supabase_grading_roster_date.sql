-- ════════════════════════════════════════════════════════════════════════
--  The coaches' class list had no badges, and said nothing about why
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  Nothing to deploy with it. Re-creates one function; no app changes.
--
--  WHAT WAS WRONG
--  my_roster_grading() -- the one call that puts a stage badge beside
--  each swimmer on a coach's class list -- narrowed the week like this:
--
--      where ws.session_date between p_from and p_to
--
--  weekly_sessions has no session_date. It stores the week and the day,
--  and every other file in this project derives the date the same way:
--
--      (ws.week_start_date + (ws.weekday - 1))::date
--
--  plpgsql resolves a column name when the query RUNS, so the function
--  installed perfectly and raised "column ws.session_date does not
--  exist" on every call. The attendance app catches that call on
--  purpose -- a database without the grading module should leave the
--  class list looking exactly as it did -- so the only symptom was no
--  badges, for every swimmer, on every class, with nothing on screen
--  and nothing in a log anybody reads.
--
--  WHY THE TESTS DID NOT CATCH IT
--  The suite's stand-in weekly_sessions had been given a session_date
--  column, because that is what the function asked for. The fixture was
--  shaped to fit the function instead of the database, so the suite
--  called it happily. A mock more capable than the real thing cannot
--  catch misuse. The fixture now matches the live table, and the probe
--  puts a real class in the week, rosters a coach to it and insists on
--  a badge coming back -- calling it against an empty timetable returns
--  no rows whatever is wrong inside, which is how this got through.
--
--  WHAT THIS DOES NOT CHANGE
--  The signature, the columns, the order of the columns, and the
--  grants. An installed phone calls this by name and reads these rows
--  by key; nothing moves.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'weekly_sessions'
                    and column_name = 'week_start_date') then
    raise exception 'weekly_sessions has no week_start_date. This database is not shaped the way the rest of the project expects; stop and look before going further.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_milestones'
                    and column_name = 'label') then
    raise exception 'grading_milestones.label does not exist. Run supabase_grading_stage_labels.sql first, then this file again.';
  end if;
end $$;


-- ─── The badge beside each swimmer on a class list ──────────────────────
-- Re-created whole. The only change from supabase_grading_coach.sql is
-- the line that narrows the week.
create or replace function my_roster_grading(p_from date, p_to date)
returns table (
  student_id   uuid,
  program_name text,
  level_no     integer,
  levels_total integer,
  label        text
)
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := attendance_my_crew_id();
begin
  if v_me is null and not can_write_office() then return; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to > p_from + 62 then return; end if;

  return query
  with mine as (
    -- The children in water this person is rostered to, over the range.
    select distinct wss.student_id
      from weekly_sessions ws
      join weekly_session_students wss on wss.session_id = ws.id
     -- THE FIX. The table stores the week and the day, not a date, and
     -- the old filter asked for a column that is not there. Derived
     -- exactly as supabase_coach_roster.sql and
     -- supabase_parent_messages_v2.sql derive it, so there is one way
     -- of working out a session's date in this project and not three.
     where (ws.week_start_date + (ws.weekday - 1))::date between p_from and p_to
       and wss.student_id is not null
       and (can_write_office() or exists (
             select 1 from session_instructors si
              where si.session_id = ws.id and si.instructor_id = v_me))
  ),
  prog as (
    select m.student_id, lt.grading_program_id as pid
      from mine m
      join student_enrollments se on se.student_id = m.student_id
      join scheduler_lesson_types lt on lt.id = se.lesson_type_id
     where lt.grading_program_id is not null
  ),
  pick as (
    -- Every column qualified. `student_id` is also one of this
    -- function's OUT names, so bare it is "ambiguous: a PL/pgSQL
    -- variable or a table column" -- which installs without a word and
    -- raises on the first call. Same family of fault as the one above.
    select distinct on (prog.student_id) prog.student_id, prog.pid
      from prog order by prog.student_id, prog.pid
  ),
  top as (
    select p.student_id, p.pid,
           (select max(ms.level_no) from student_milestones sm
              join grading_milestones ms on ms.id = sm.milestone_id
             where sm.student_id = p.student_id and sm.revoked_at is null
               and ms.program_id = p.pid)::integer as lvl
      from pick p
  )
  select t.student_id,
         g.name::text,
         t.lvl,
         (select count(*) from grading_milestones ms
           where ms.program_id = t.pid and ms.is_active)::integer,
         (select ms.label from grading_milestones ms
           where ms.program_id = t.pid and ms.level_no = t.lvl)::text
    from top t join grading_programs g on g.id = t.pid;
end $$;

revoke all on function my_roster_grading(date, date) from public, anon;
grant execute on function my_roster_grading(date, date) to authenticated;


notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
-- One statement. The Supabase editor shows the result of the last
-- statement only.
--
-- Row 4 is the one to read. The function itself cannot be called
-- usefully from here -- it asks who you are, and the SQL editor is
-- nobody -- so row 4 runs the same joins without that gate and counts
-- the badges a coach SHOULD see this week. If it is 0, the fault is no
-- longer this function: either no lesson type points at a syllabus, or
-- nobody is rostered to the classes.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the week is narrowed off the real columns now' as thing,
         case when exists (select 1 from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public'
                             and p.proname = 'my_roster_grading'
                             and p.prosrc like '%week_start_date%'
                             -- The FILTER, not the words. An earlier
                             -- version of this check looked for the
                             -- column name anywhere in the body and
                             -- matched the comment above explaining the
                             -- fix, so a correct install reported itself
                             -- broken.
                             and p.prosrc not like '%session_date between%')
              then 'yes — the old filter is gone'
              else 'NO. The old version is still installed; do not stop here' end as detail
  union all
  select 2, 'weekly_sessions really has no session_date',
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='weekly_sessions'
                              and column_name='session_date')
              then 'it DOES have one — then something else was wrong; tell Claude'
              else 'confirmed: week_start_date + weekday is the only way to a date' end
  union all
  select 3, 'lesson types pointed at a syllabus',
         coalesce((select string_agg(lt.name || ' → ' || p.name, ' · ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id), 'NONE')
  union all
  select 4, 'badges a coach should see this week',
         (select count(*)::text from (
            select distinct wss.student_id
              from weekly_sessions ws
              join weekly_session_students wss on wss.session_id = ws.id
              join student_enrollments se on se.student_id = wss.student_id
              join scheduler_lesson_types lt on lt.id = se.lesson_type_id
             where (ws.week_start_date + (ws.weekday - 1))::date
                     between date_trunc('week', current_date)::date
                         and date_trunc('week', current_date)::date + 6
               and lt.grading_program_id is not null
               and exists (select 1 from session_instructors si
                            where si.session_id = ws.id)) x)
      || ' swimmer(s) in a rostered class this week whose lesson type has a syllabus'
  union all
  select 5, 'next',
         'Nothing to deploy. Have a coach close the app fully and open it '
      || 'again, then Classes → the day → the chip beside a name.'
  ) z
 order by z.k;
