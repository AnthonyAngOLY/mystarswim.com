-- ════════════════════════════════════════════════════════════════════════
--  Milestone awards: Self Rescue, Novice Swimmer, Competent Swimmer
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_bands.sql FIRST.
--
--  WHY
--  Eleven certificates exist on paper: one for each of the eight stages,
--  and three more that are not stages at all. Self Rescue is handed over
--  at Water Stamina, Novice Swimmer at Stroke Introduction, Competent
--  Swimmer at Stroke Mechanics -- the end of the ladder. They have their
--  own artwork, their own wording, and they mean something a stage
--  certificate does not: not "she finished a level" but "she can save
--  herself", "she can swim", "she is done".
--
--  The module had one certificate per stage and no way to say that. A
--  child reaching Water Stamina would have been offered one piece of
--  paper when the office is holding two.
--
--  WHAT THIS ADDS
--  award_name and award_icon_path on the stage, and a claimed_at /
--  claimed_by pair beside the certificate's own. The award rides on the
--  stage that earns it, so it is earned, revoked and recomputed by the
--  machinery that already exists -- no second ladder, no second trigger.
--
--  claim_certificate() GAINS A FOURTH ARGUMENT, WITH A DEFAULT.
--  p_kind defaults to 'certificate', so every call a phone already makes
--  keeps working and keeps meaning what it meant. An installed app that
--  has not been updated simply cannot hand over an award, which is the
--  correct failure: it does not know they exist.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
-- The function below reads m.band. plpgsql resolves a column name when
-- the query RUNS, not when the function is created -- so run out of
-- order this file installs perfectly, every confirm block reports
-- success, and the first parent to open the app gets a blank ladder with
-- the real reason in a log nobody is reading. Exactly the shape of
-- min(uuid). So: ask first, and refuse in the SQL editor where it can
-- still be read.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_milestones'
                    and column_name = 'band') then
    raise exception 'grading_milestones.band does not exist. Run supabase_grading_bands.sql first, then this file again.';
  end if;
end $$;

alter table grading_milestones add column if not exists award_name      text;
alter table grading_milestones add column if not exists award_icon_path text;

alter table student_milestones add column if not exists award_claimed_at timestamptz;
alter table student_milestones add column if not exists award_claimed_by text;

comment on column grading_milestones.award_name is
  'A second, named certificate handed over at this stage -- Self Rescue, '
  'Novice Swimmer, Competent Swimmer. Null on a stage that carries only '
  'its own certificate, which is most of them.';

do $$
declare v_prog uuid;
begin
  select id into v_prog from grading_programs where name = 'Swim Passport';
  if v_prog is null then
    raise exception 'Swim Passport does not exist. Run the passport files first.';
  end if;

  -- Cleared first, so a re-run after an award moves does not leave the
  -- old stage still offering it.
  update grading_milestones
     set award_name = null, award_icon_path = null
   where program_id = v_prog;

  update grading_milestones set award_name = 'Self Rescue',
         award_icon_path = '/badges/ms-self-rescue.png'
   where program_id = v_prog and label = '3';
  update grading_milestones set award_name = 'Novice Swimmer',
         award_icon_path = '/badges/ms-novice-swimmer.png'
   where program_id = v_prog and label = '4';
  update grading_milestones set award_name = 'Competent Swimmer',
         award_icon_path = '/badges/ms-competent-swimmer.png'
   where program_id = v_prog and label = '6';

  -- The stage artwork, redrawn. Matched by label so it survives any
  -- later renaming of the stages themselves.
  update grading_milestones m set icon_path = v.p
    from (values ('A','/badges/ss-a-water-discovery.png'),
                 ('B','/badges/ss-b-water-explorer.png'),
                 ('1','/badges/ss-1-water-acclimation.png'),
                 ('2','/badges/ss-2-water-movement.png'),
                 ('3','/badges/ss-3-water-stamina.png'),
                 ('4','/badges/ss-4-stroke-introduction.png'),
                 ('5','/badges/ss-5-stroke-development.png'),
                 ('6','/badges/ss-6-stroke-mechanics.png')) as v(l, p)
   where m.program_id = v_prog and m.label = v.l;

  raise notice 'Awards set on stages 3, 4 and 6; stage artwork repointed.';
end $$;


-- ─── claim_certificate(), now able to hand over either ──────────────────
-- DROPPED FIRST, AND THAT IS THE WHOLE POINT. `create or replace` cannot
-- change a function's signature: it creates a SECOND function alongside
-- the old one. Both then match a three-argument call, Postgres refuses
-- to choose, and every installed phone gets "could not choose a best
-- candidate function" the next time a coach hands a certificate over.
--
-- The rule in CLAUDE.md -- add a parameter, give it a default -- is
-- right, but only once the old arity is gone. Dropping it is safe here
-- precisely because the new one defaults p_kind: the three-argument call
-- still resolves, and still means the stage certificate.
drop function if exists claim_certificate(uuid, uuid, boolean);

create or replace function claim_certificate(
  p_student uuid, p_milestone uuid, p_claimed boolean default true,
  p_kind text default 'certificate')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := attendance_my_crew_id();
  v_name  text;
  v_cert  boolean;
  v_award text;
  v_live  boolean;
begin
  if p_kind not in ('certificate', 'award') then
    return jsonb_build_object('ok', false, 'error', 'Unknown kind of certificate.');
  end if;

  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false,
      'error', 'You are not rostered to this swimmer.');
  end if;

  select m.certificate, m.award_name into v_cert, v_award
    from grading_milestones m where m.id = p_milestone;

  if p_kind = 'certificate' and v_cert is not true then
    return jsonb_build_object('ok', false,
      'error', 'That level does not come with a certificate.');
  end if;
  if p_kind = 'award' and v_award is null then
    return jsonb_build_object('ok', false,
      'error', 'That level does not come with an award.');
  end if;

  select (sm.revoked_at is null) into v_live
    from student_milestones sm
   where sm.student_id = p_student and sm.milestone_id = p_milestone;

  if v_live is not true then
    -- Nothing has been offered, so nothing can have been handed over.
    return jsonb_build_object('ok', false,
      'error', 'This swimmer has not earned that level yet.');
  end if;

  -- The name as it stands today. A coach who leaves is still the person
  -- who handed it over.
  select coalesce(nullif(btrim(e.full_name), ''), 'the office')
    into v_name from admin_employees e where e.id = v_me;
  v_name := coalesce(v_name, 'the office');

  if p_kind = 'certificate' then
    update student_milestones
       set certificate_claimed_at = case when p_claimed then now() else null end,
           -- Kept either way: this is the last person who touched it, and
           -- "nobody knows who un-marked it" is the worse record.
           certificate_claimed_by = v_name
     where student_id = p_student and milestone_id = p_milestone;
  else
    update student_milestones
       set award_claimed_at = case when p_claimed then now() else null end,
           award_claimed_by = v_name
     where student_id = p_student and milestone_id = p_milestone;
  end if;

  return jsonb_build_object('ok', true, 'claimed', p_claimed,
                            'kind', p_kind, 'by', v_name);
end $$;

revoke all on function claim_certificate(uuid, uuid, boolean, text) from public, anon;
grant execute on function claim_certificate(uuid, uuid, boolean, text) to authenticated;


-- ─── student_grading(), carrying the award beside the certificate ───────
-- Re-created whole, as every change to this function is. New since
-- supabase_grading_bands.sql: award, award_icon, award_claimed_at and
-- award_claimed_by on each milestone.
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

  -- The band of the first rung still to climb.
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
            'band', m.band,
            'description', m.description, 'icon', m.icon_path,
            'colour', m.colour,
            'certificate', m.certificate,
            -- The second piece of paper, where there is one.
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
  select 1 k, 'the eleven certificates' as thing,
         (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and m.certificate)
      || ' stage + '
      || (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and m.award_name is not null)
      || ' award = '
      || ((select count(*) from grading_milestones m
             join grading_programs p on p.id = m.program_id
            where p.name = 'Swim Passport' and m.certificate)
        + (select count(*) from grading_milestones m
             join grading_programs p on p.id = m.program_id
            where p.name = 'Swim Passport' and m.award_name is not null))::text as detail
  union all
  select 2, 'which stage carries which award',
         coalesce((select string_agg(m.label || ' ' || m.name || ' → ' || m.award_name,
                           ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.award_name is not null),
                  'NONE')
  union all
  select 3, 'stage artwork',
         (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and m.icon_path like '/badges/ss-%')
      || ' of 8 stages point at the redrawn roundels'
  union all
  select 4, 'award artwork',
         (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and m.award_icon_path like '/badges/ms-%')
      || ' of 3 awards point at their badge'
  union all
  select 5, 'the published contract',
         'claim_certificate() takes a fourth argument, p_kind, defaulting to '
      || '''certificate''. Every three-argument call a phone already makes still '
      || 'resolves here and still means the stage certificate.'
  union all
  select 6, 'next',
         'Deploy the coach app — it is where an award is handed over — and the '
      || 'parent app, which draws it beside the stage badge.'
  ) z
 order by z.k;
