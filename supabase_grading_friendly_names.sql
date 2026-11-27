-- ════════════════════════════════════════════════════════════════════════
--  The name a child reads, and the name the syllabus uses
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_awards.sql FIRST.
--
--  WHY
--  Every stage has two names and both are in print. The certificate a
--  child takes home says LEARN TO SWIM STARFISH. The Progression chart
--  on its back says 1 Water Acclimation. They are the same rung.
--
--  The platform only had room for one, and it had the syllabus one --
--  so a parent holding a certificate that says Starfish opened the app
--  and found Water Acclimation. Interchangeable to us; not to a
--  five-year-old.
--
--  So: `name` becomes the one a child reads, and `formal_name` keeps the
--  one the syllabus and the chart use. The apps lead with the friendly
--  name and carry the formal one quietly beside it, which is what the
--  printed materials do too.
--
--  A AND B KEEP THEIR NAMES. Water Discovery and Water Explorer are
--  already the friendly names -- the certificate and the chart agree on
--  them -- so there is nothing to split and formal_name stays null.
--
--  The band prefix comes out of the descriptions while we are here. It
--  was there before `band` was a column of its own, and a stage that
--  says "Swim Basics" twice reads like a mistake.
--
--  NOTHING IS REMOVED OR REORDERED. student_grading() gains one key.
-- ════════════════════════════════════════════════════════════════════════

alter table grading_milestones add column if not exists formal_name text;

comment on column grading_milestones.formal_name is
  'The syllabus name for this stage -- Water Acclimation, Stroke '
  'Mechanics -- where it differs from the name a child reads. Null '
  'where the two agree, as on Water Discovery and Water Explorer.';

do $$
declare v_prog uuid;
begin
  select id into v_prog from grading_programs where name = 'Swim Passport';
  if v_prog is null then
    raise exception 'Swim Passport does not exist. Run the passport files first.';
  end if;

  -- Matched on label, not on name: this file renames the very thing a
  -- name match would have to find, so a re-run would miss every row.
  update grading_milestones m set
         name        = v.friendly,
         formal_name = v.formal,
         description = v.formal || ' · ' || v.blurb
    from (values
      ('1', 'Starfish', 'Water Acclimation',
       'Increases comfort with underwater exploration and introduces basic '
       || 'self-rescue skills performed with assistance.'),
      ('2', 'Crab', 'Water Movement',
       'Encourages forward movement in water and basic self-rescue skills '
       || 'performed independently.'),
      ('3', 'Octopus', 'Water Stamina',
       'Develops intermediate self-rescue skills performed at longer distances '
       || 'than in previous stages. Every child who learns to swim should reach '
       || 'at least this stage.'),
      ('4', 'Turtle', 'Stroke Introduction',
       'Introduces basic stroke technique in front crawl and back crawl and '
       || 'reinforces water safety through treading water and elementary '
       || 'backstroke.'),
      ('5', 'Whale', 'Stroke Development',
       'Introduces breaststroke and butterfly and reinforces water safety '
       || 'through treading water and sidestroke.'),
      ('6', 'Ray', 'Stroke Mechanics',
       'Refines stroke technique on all major competitive strokes and '
       || 'encourages swimming as part of a healthy lifestyle.')
    ) as v(l, friendly, formal, blurb)
   where m.program_id = v_prog and m.label = v.l;

  -- A and B: one name only, and the band heading already says the rest.
  update grading_milestones set
         formal_name = null,
         description = 'Introduces infants and toddlers to the aquatic environment. '
                    || 'A parent is in the water throughout.'
   where program_id = v_prog and label = 'A';
  update grading_milestones set
         formal_name = null,
         description = 'Focuses on exploring body positions, blowing bubbles, and '
                    || 'fundamental safety and aquatic skills.'
   where program_id = v_prog and label = 'B';

  raise notice 'Stages 1-6 renamed; the syllabus names kept beside them.';
end $$;


-- ─── student_grading(), carrying both names ─────────────────────────────
-- Re-created whole, as every change to this function is. New since
-- supabase_grading_awards.sql: formal_name on each milestone.
create or replace function student_grading(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_prog   uuid; v_out jsonb; v_high integer; v_levels integer;
  v_band   text; v_band_total integer; v_band_done integer;
begin
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

  select m.band into v_band
    from grading_milestones m
   where m.program_id = v_prog and m.is_active and m.band is not null
     and not exists (select 1 from student_milestones sm
                      where sm.milestone_id = m.id and sm.student_id = p_student
                        and sm.revoked_at is null)
   order by m.level_no
   limit 1;

  if v_band is null then
    select m.band into v_band
      from grading_milestones m
     where m.program_id = v_prog and m.is_active and m.band is not null
     order by m.level_no desc
     limit 1;
  end if;

  if v_band is not null then
    select count(*) into v_band_total
      from grading_milestones m
     where m.program_id = v_prog and m.is_active and m.band = v_band;
    select count(*) into v_band_done
      from grading_milestones m
      join student_milestones sm on sm.milestone_id = m.id
                                and sm.student_id = p_student
                                and sm.revoked_at is null
     where m.program_id = v_prog and m.is_active and m.band = v_band;
  end if;

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
    'level', v_high,
    'levels_total', v_levels,
    'band', case when v_band is null then null else
      jsonb_build_object('name', v_band, 'done', v_band_done,
                         'total', v_band_total) end,
    'also_earned', coalesce((
      select jsonb_agg(jsonb_build_object(
               'program', p2.name, 'level_no', m2.level_no, 'label', m2.label,
               'name', m2.name, 'icon', m2.icon_path, 'colour', m2.colour,
               'achieved_at', sm2.achieved_at)
             order by p2.sort_order, m2.level_no)
        from student_milestones sm2
        join grading_milestones m2 on m2.id = sm2.milestone_id
        join grading_programs p2 on p2.id = m2.program_id
       where sm2.student_id = p_student and sm2.revoked_at is null
         and m2.program_id <> v_prog), '[]'::jsonb),
    'milestones', coalesce((
      select jsonb_agg(ms order by (ms->>'level_no')::int)
        from (
          select jsonb_build_object(
            'id', m.id, 'level_no', m.level_no, 'label', m.label, 'name', m.name,
            -- The syllabus name, where it differs from the one a child
            -- reads. Null where they agree.
            'formal_name', m.formal_name,
            'band', m.band,
            'description', m.description, 'icon', m.icon_path,
            'colour', m.colour,
            'certificate', m.certificate,
            'award', m.award_name,
            'award_icon', m.award_icon_path,
            'award_claimed_at', sm.award_claimed_at,
            'award_claimed_by', sm.award_claimed_by,
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

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the ladder, as a child reads it' as thing,
         coalesce((select string_agg(m.label || ' ' || m.name, ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.is_active), 'NOT RENAMED') as detail
  union all
  select 2, 'and as the syllabus writes it',
         coalesce((select string_agg(m.label || ' ' || m.formal_name, ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.formal_name is not null), 'NONE')
  union all
  select 3, 'stages with one name only',
         coalesce((select string_agg(m.label || ' ' || m.name, ', ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.formal_name is null), 'none')
      || ' — the certificate and the chart already agree on these'
  union all
  select 4, 'nothing was lost in the rename',
         (select count(*)::text from student_task_marks k
            join grading_tasks t on t.id = k.task_id
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and k.removed_at is null)
      || ' live tick(s). A rename touches no id, so nothing moved.'
  union all
  select 5, 'next',
         'Deploy both apps. They lead with the child''s name and carry the '
      || 'syllabus one quietly beside it, which is what the printed materials do.'
  ) z
 order by z.k;
