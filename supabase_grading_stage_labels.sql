-- ════════════════════════════════════════════════════════════════════════
--  What the badge actually says: a label per level
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql AND supabase_grading_syllabus.sql
--  FIRST. Run this BEFORE supabase_swim_passport_syllabus.sql, which
--  fills the column in. The other order stops with "column label does
--  not exist".
--
--  WHY
--  level_no is the rung: an integer that orders the ladder and makes
--  "3 of 8" possible. On the MAS ladder it is also what the badge says,
--  so nobody noticed the two were different things.
--
--  The Swim Passport ladder makes them different. Its eight stages are
--  printed A, B, 1, 2, 3, 4, 5, 6 -- Water Discovery is "A" and Water
--  Acclimation is "1" -- and the stickers a child has in their passport
--  say exactly that. Numbered 1 to 8 for ordering, the app would print
--  "Level 3" beside a sticker reading "Learn to Swim 1", and the front
--  desk would spend a year explaining it.
--
--  So: level_no keeps ordering the ladder, and label is what the child's
--  badge says. Null means they are the same thing and the apps carry on
--  printing the number, which is right for MAS BADGES.
--
--  NOTHING IS REMOVED OR REORDERED
--  student_grading() gains one key on each milestone. A phone running
--  last week's build reads the keys it knows and ignores it.
-- ════════════════════════════════════════════════════════════════════════

alter table grading_milestones add column if not exists label text;

comment on column grading_milestones.label is
  'What this level is called on the child''s badge -- "A", "B", "1". '
  'Null where the badge simply says the level number, which is the '
  'common case. level_no still orders the ladder either way.';


-- ─── student_grading(), now carrying the label ──────────────────────────
-- Re-created whole, as every change to this function is. The only
-- difference from supabase_grading_syllabus.sql is 'label'.
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
            'id', m.id, 'level_no', m.level_no, 'label', m.label, 'name', m.name,
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
  'milestone with its badge label and done/total for its bar, and every '
  'task marked or not. The one shape the coach app, the office and the '
  'parent app all draw.';

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;


-- my_roster_grading() reads this column too -- the badge beside each
-- swimmer on a coach's class list. It is defined, and now re-created
-- with the label, in supabase_grading_coach.sql, which also adds this
-- column itself so neither file depends on the other's order. RE-RUN
-- THAT FILE if the class list still shows L3 where the sticker says 1.

notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the column' as thing,
         coalesce((select 'in place, ' || data_type
                     from information_schema.columns
                    where table_schema='public' and table_name='grading_milestones'
                      and column_name='label'), 'MISSING') as detail
  union all
  select 2, 'levels whose badge says something else',
         coalesce((select string_agg(p.name || ' ' || m.label || ' = ' || m.name,
                           ' · ' order by p.name, m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where m.label is not null),
                  'NONE yet — correct until supabase_swim_passport_syllabus.sql runs')
  union all
  select 3, 'levels that just say their number',
         (select count(*)::text from grading_milestones where label is null)
      || ' — which is right wherever the badge and the rung agree, as on MAS BADGES'
  union all
  select 4, 'what the apps now receive',
         'Each milestone carries `label`, null where there is nothing extra to '
      || 'say. Old builds ignore the key; nothing was removed or reordered.'
  ) z
 order by z.k;
