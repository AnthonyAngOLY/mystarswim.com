-- ════════════════════════════════════════════════════════════════════════
--  Which syllabus a programme follows
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql FIRST. This adds to what it made.
--  Run this BEFORE supabase_grading_mas_badges.sql, which fills these
--  columns in. The other order leaves the badge ladder installed with no
--  syllabus attribution and no error to say so.
--
--  WHY
--  A programme is a ladder of levels. It does not say where the ladder
--  came from, and for the MAS one that matters: the levels, their names
--  and their criteria are Malaysia Aquatics', not ours. A parent looking
--  at "Dolphin" is owed the provenance, an office answering "is this
--  recognised?" is owed it in writing, and a coach handing over a
--  certificate is owed the sentence about what it does NOT mean.
--
--  So: five fields on the programme, all of them typed by hand in
--  Settings -> Grading, all of them optional. A programme with none set
--  shows nothing at all -- Water Discovery is ours, invented here, and
--  has no syllabus to credit.
--
--      syllabus_body     who owns the standard. "Malaysia Aquatics"
--      syllabus_name     what it is called. "BADGES - Swimming
--                        Proficiency Test"
--      syllabus_version  the edition in use. "1.0"
--      syllabus_note     the paragraph nobody reads until they need it:
--                        what a level here means, and what it does not
--      syllabus_url      where to read it, if it is published
--
--  THE URL IS CHECKED, AND THIS IS NOT PEDANTRY
--  It is drawn as a link in three apps. An admin pasting
--  `javascript:...` into that box would be writing script that runs in
--  every parent's browser. The constraint below allows http and https
--  and nothing else, so the box cannot become one.
--
--  NOTHING IS REMOVED OR REORDERED
--  student_grading() is re-created with one more key in its `program`
--  object. A phone still running last week's build reads the keys it
--  knows and ignores the new one, which is the only kind of change a
--  function a phone calls is allowed to make.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
-- The function below reads p.colour. plpgsql resolves a column name when
-- the query RUNS, not when the function is created -- so run out of
-- order this file installs perfectly, every confirm block reports
-- success, and the first parent to open the app gets a blank ladder with
-- the real reason in a log nobody is reading. Exactly the shape of
-- min(uuid). So: ask first, and refuse in the SQL editor where it can
-- still be read.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_programs'
                    and column_name = 'colour') then
    raise exception 'grading_programs.colour does not exist. Run supabase_grading_colours.sql first, then this file again.';
  end if;
end $$;

alter table grading_programs add column if not exists syllabus_body    text;
alter table grading_programs add column if not exists syllabus_name    text;
alter table grading_programs add column if not exists syllabus_version text;
alter table grading_programs add column if not exists syllabus_note    text;
alter table grading_programs add column if not exists syllabus_url     text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'grading_programs_syllabus_url_http') then
    alter table grading_programs
      add constraint grading_programs_syllabus_url_http
      check (syllabus_url is null or syllabus_url ~* '^https?://[^[:space:]]+$');
  end if;
end $$;

comment on column grading_programs.syllabus_body is
  'Who owns the standard this ladder follows, e.g. Malaysia Aquatics. '
  'Null where the programme is our own.';
comment on column grading_programs.syllabus_note is
  'What a level on this programme means -- and does not mean. Shown on '
  'demand, never in the headline.';


-- ─── student_grading(), with the syllabus on the programme ──────────────
-- Re-created whole, as every change to this function is. The only
-- difference from supabase_grading_programs.sql is the 'syllabus' key.
-- It comes back null, not an empty object, when nothing is filled in:
-- the clients then have one thing to ask rather than five.
create or replace function student_grading(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prog uuid; v_out jsonb; v_high integer; v_levels integer;
begin
  -- The programme comes from the lesson type the child is enrolled on.
  -- A child in two graded lesson types takes the first by sort order,
  -- which is a choice the office makes by ordering them.
  select lt.grading_program_id into v_prog
    from student_enrollments se
    join scheduler_lesson_types lt on lt.id = se.lesson_type_id
   where se.student_id = p_student and lt.grading_program_id is not null
   order by lt.sort_order nulls last, lt.name
   limit 1;

  if v_prog is null then
    return jsonb_build_object('ok', true, 'graded', false);
  end if;

  select count(*) into v_levels
    from grading_milestones where program_id = v_prog and is_active;

  select max(m.level_no) into v_high
    from student_milestones sm
    join grading_milestones m on m.id = sm.milestone_id
   where sm.student_id = p_student and sm.revoked_at is null
     and m.program_id = v_prog;

  select jsonb_build_object(
    'ok', true,
    'graded', true,
    'program', jsonb_build_object('id', p.id, 'name', p.name,
                                  'subtitle', p.subtitle, 'icon', p.icon_path,
                                  'colour', p.colour,
      'syllabus', case
        when coalesce(p.syllabus_body, p.syllabus_name, p.syllabus_version,
                      p.syllabus_note, p.syllabus_url) is null then null
        else jsonb_build_object('body', p.syllabus_body,
                                'name', p.syllabus_name,
                                'version', p.syllabus_version,
                                'note', p.syllabus_note,
                                'url', p.syllabus_url) end),
    -- The badge: highest ACTIVATED level, and nothing else.
    'level', v_high,
    'levels_total', v_levels,
    'milestones', coalesce((
      select jsonb_agg(ms order by (ms->>'level_no')::int)
        from (
          select jsonb_build_object(
            'id', m.id, 'level_no', m.level_no, 'name', m.name,
            'description', m.description, 'icon', m.icon_path,
            'colour', m.colour,
            'certificate', m.certificate,
            'achieved_at', sm.achieved_at,
            'activated', (sm.id is not null and sm.revoked_at is null),
            'certificate_claimed_at', sm.certificate_claimed_at,
            'certificate_claimed_by', sm.certificate_claimed_by,
            'total', (select count(*) from grading_tasks t
                       where t.milestone_id = m.id and t.is_active),
            'done',  (select count(*) from grading_tasks t
                        join student_task_marks k on k.task_id = t.id
                                                 and k.student_id = p_student
                                                 and k.removed_at is null
                       where t.milestone_id = m.id and t.is_active),
            'tasks', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', t.id, 'name', t.name, 'description', t.description,
                       'done', (k.id is not null),
                       'marked_at', k.marked_at,
                       'marked_by', k.marked_by_name)
                     -- Done first, then the rest in syllabus order.
                     order by (k.id is null), t.sort_order, t.name)
                from grading_tasks t
                left join student_task_marks k
                       on k.task_id = t.id and k.student_id = p_student
                      and k.removed_at is null
               where t.milestone_id = m.id and t.is_active), '[]'::jsonb)
          ) as ms
          from grading_milestones m
          left join student_milestones sm
                 on sm.milestone_id = m.id and sm.student_id = p_student
         where m.program_id = v_prog and m.is_active
        ) z), '[]'::jsonb))
    into v_out
    from grading_programs p where p.id = v_prog;

  return v_out;
end $$;

comment on function student_grading(uuid) is
  'One child''s ladder: the programme and the syllabus behind it, every '
  'milestone with done/total for its bar, and every task marked or not. '
  'The one shape the coach app, the office and the parent app all draw.';

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;

-- PostgREST caches the shape of the schema. New columns are invisible to
-- the admin page until it is told to look again.
notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
-- One statement: the SQL editor shows the last one only, and a file that
-- ends in three selects reports a third of what it did.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the five columns' as thing,
         (select string_agg(column_name, ', ' order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'grading_programs'
             and column_name like 'syllabus%') as detail
  union all
  select 2, 'the url constraint',
         coalesce((select 'in place — ' || pg_get_constraintdef(oid)
                     from pg_constraint
                    where conname = 'grading_programs_syllabus_url_http'),
                  'MISSING — an admin could paste a javascript: link')
  union all
  select 3, 'programmes crediting a syllabus',
         coalesce((select string_agg(p.name || ' → ' || coalesce(p.syllabus_body,'?')
                             || ' ' || coalesce(p.syllabus_name,'')
                             || coalesce(' v' || p.syllabus_version, ''),
                           ' · ' order by p.sort_order, p.name)
                     from grading_programs p
                    where coalesce(p.syllabus_body, p.syllabus_name) is not null),
                  'NONE yet — run supabase_grading_mas_badges.sql, or fill '
               || 'them in at Settings → Grading')
  union all
  select 4, 'programmes crediting none',
         coalesce((select string_agg(p.name, ', ' order by p.sort_order, p.name)
                     from grading_programs p
                    where coalesce(p.syllabus_body, p.syllabus_name) is null),
                  'none')
      || ' — which is correct for a ladder we wrote ourselves'
  union all
  select 5, 'what the apps now receive',
         'student_grading() carries program.syllabus, null when nothing is '
      || 'set. Old builds ignore the key; nothing was removed or reordered.'
  ) z
 order by z.k;
