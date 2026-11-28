-- ════════════════════════════════════════════════════════════════════════
--  Ticking a task, from the poolside
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql FIRST. This builds on the tables
--  and on student_grading() that it creates.
--
--  IT ADDS grading_milestones.label ITSELF rather than depending on
--  supabase_grading_stage_labels.sql having run. my_roster_grading()
--  reads that column, and plpgsql resolves column names when the body
--  RUNS -- so without the column this file would install cleanly, every
--  confirm block would report success, and the first coach to open a
--  class list would get nothing with the reason in a log.
--
--  WHY THESE AND NOT THE TABLES DIRECTLY
--  The attendance app signs in as a crew member, not an office seat. It
--  could be given write access to student_task_marks and left to decide
--  for itself which children it may tick -- which means the rule about
--  who may tick whom would live in a phone, in whatever build that phone
--  last cached.
--
--  WHO MAY TICK
--  can_note_on_student() already answers it: the office, or a coach
--  rostered to water that child is in. It was written for progress
--  notes and it is the same question -- was this person actually there.
--  Reusing it rather than writing a second rule is the point: two rules
--  that mean the same thing drift, and the one that drifts is the one
--  nobody is looking at.
--
--  WHICH COACH, NOT WHETHER A COACH
--  Every mark carries the name as it was on the day. A coach who leaves
--  is still the coach who saw it, and an id alone stops meaning anything
--  the moment they are archived.
--
--  UNTICKING IS NOT DELETING
--  A tick removed keeps its row, with who removed it and when. Anyone
--  who may tick may untick: coaches cover each other constantly, and the
--  one who spots an error is usually not the one who made it. A rule
--  that sends them to the office turns a two-second fix into a message.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. What the coach may read ─────────────────────────────────────────
create or replace function coach_student_grading(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false,
      'error', 'You are not rostered to this swimmer.');
  end if;
  return student_grading(p_student);
end $$;

revoke all on function coach_student_grading(uuid) from public, anon;
grant execute on function coach_student_grading(uuid) to authenticated;

comment on function coach_student_grading(uuid) is
  'One child''s ladder, for a coach rostered to them. The same shape the '
  'office and the parent app read, behind the same check progress notes '
  'already use.';


-- ─── 2. The tick ────────────────────────────────────────────────────────
-- One call for both directions. A separate untick function would be a
-- second place for the permission check to be forgotten.
create or replace function mark_grading_task(
  p_student uuid, p_task uuid, p_on boolean, p_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me   uuid := attendance_my_crew_id();
  v_name text;
  v_ms   uuid;
  v_exists uuid;
begin
  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false,
      'error', 'You are not rostered to this swimmer.');
  end if;

  select t.milestone_id into v_ms from grading_tasks t where t.id = p_task and t.is_active;
  if v_ms is null then
    return jsonb_build_object('ok', false, 'error', 'That task is no longer on the syllabus.');
  end if;

  -- The name as it stands today, which is what the mark will carry for
  -- as long as it exists.
  select coalesce(nullif(btrim(e.full_name), ''), 'the office')
    into v_name from admin_employees e where e.id = v_me;
  v_name := coalesce(v_name, 'the office');

  select m.id into v_exists
    from student_task_marks m
   where m.student_id = p_student and m.task_id = p_task and m.removed_at is null;

  if p_on then
    if v_exists is not null then
      -- Two coaches on one squad session, both ticking. Not an error and
      -- not a second achievement.
      return jsonb_build_object('ok', true, 'already', true, 'task_id', p_task);
    end if;
    insert into student_task_marks (student_id, task_id, marked_by, marked_by_name, session_id)
    values (p_student, p_task, v_me, v_name, p_session);
  else
    if v_exists is null then
      return jsonb_build_object('ok', true, 'already', true, 'task_id', p_task);
    end if;
    update student_task_marks
       set removed_at = now(), removed_by = v_me, removed_by_name = v_name
     where id = v_exists;
  end if;

  -- The trigger on student_task_marks has already recomputed the
  -- milestone. Read it back rather than working it out here, so the
  -- screen and the database cannot disagree about whether that tick
  -- just earned something.
  return jsonb_build_object(
    'ok', true,
    'task_id', p_task,
    'milestone_id', v_ms,
    'activated', exists (select 1 from student_milestones sm
                          where sm.student_id = p_student
                            and sm.milestone_id = v_ms
                            and sm.revoked_at is null),
    'milestone', (select m.name from grading_milestones m where m.id = v_ms),
    'level_no', (select m.level_no from grading_milestones m where m.id = v_ms),
    'certificate', (select m.certificate from grading_milestones m where m.id = v_ms));
end $$;

revoke all on function mark_grading_task(uuid, uuid, boolean, uuid) from public, anon;
grant execute on function mark_grading_task(uuid, uuid, boolean, uuid) to authenticated;

comment on function mark_grading_task(uuid, uuid, boolean, uuid) is
  'Tick or untick one task for one child. Answers with whether that '
  'tick just activated the milestone, so the screen can say so without '
  'working it out a second way.';


-- ─── 3. The badge on the register ───────────────────────────────────────
-- A level beside every name on the coach's class list, in one call
-- rather than one per child. get_my_session_roster is a published
-- contract that installed phones call, so this is beside it rather than
-- inside it: adding columns there would mean every old build reading a
-- row it does not expect.
-- What the badge beside each swimmer says. label is added here, not
-- only in supabase_grading_stage_labels.sql, so this file installs on
-- its own in any order.
alter table grading_milestones add column if not exists label text;

-- Dropped and re-created, not replaced: Postgres will not change the
-- return type of a function in place, and `create or replace` with a
-- new column list fails with "cannot change return type of existing
-- function" -- which is what a re-run of this file hits otherwise.
drop function if exists my_roster_grading(date, date);

-- `label` goes LAST. A phone reads these rows by key and ignores one
-- it does not know, but only because nothing before it moved.
create function my_roster_grading(p_from date, p_to date)
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
     -- The live table stores the week and the day, not the date. Every
     -- other file derives it exactly this way; this one read a
     -- ws.session_date that does not exist, which raised on every call
     -- and left the class list with no badges and no error on screen.
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
    -- variable or a table column" -- which the file installs past
    -- without a word and raises on the first call. The attendance app
    -- catches that call and draws nothing, so the only symptom was
    -- badges quietly never appearing on a class list.
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


-- ─── 4. What is now in place ────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'who may tick' as thing,
         'The office, or a coach rostered to water that child is in — '
      || 'can_note_on_student(), the same check progress notes use. One '
      || 'rule, not two.' as detail
  union all
  select 2, 'the three functions',
         (select string_agg(p.proname, ', ' order by p.proname)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('coach_student_grading','mark_grading_task','my_roster_grading'))
  union all
  select 3, 'unticking',
         'Anyone who may tick may untick, and the row stays with who '
      || 'removed it. Coaches cover each other, and the one who spots an '
      || 'error is usually not the one who made it.'
  union all
  select 4, 'children a coach can see a level for',
         'Whoever is in their water over the week asked for. A child on '
      || 'a lesson type with no grading programme simply has no badge.'
  union all
  select 5, 'next',
         'Deploy the attendance app — whatever BUILD attendance/app.js now '
      || 'says; a number written here only goes stale, and this one did. '
      || 'Until then nothing calls these and the class list looks as it did.'
  ) z
 order by z.k;
