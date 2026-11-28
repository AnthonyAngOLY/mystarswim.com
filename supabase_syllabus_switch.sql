-- ════════════════════════════════════════════════════════════════════════
--  A swimmer who changes syllabus keeps the one they were on
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_swim_passport_wording.sql FIRST.
--
--  THREE THINGS, all asked for together because they are one story:
--  what happens to a syllabus when the office stops using it.
--
--  1. A SYLLABUS CAN BE DELETED, not only switched off.
--     delete_grading_program() takes the word "delete" as its second
--     argument and refuses without it. The admin screen asks twice; this
--     is the half of that promise the database can keep, because a
--     confirmation that only lives in JavaScript is a confirmation a
--     stray fetch skips.
--
--     It refuses outright once a swimmer has been assessed against it.
--     Ticks and certificates are records, and the rule in this project
--     is void, do not delete. The refusal says how many swimmers and
--     points at the off switch instead. Deleting is for the syllabus
--     that was typed in, looked wrong, and was never taught.
--
--  2. THE OFFICE IS TOLD WHO IS USING IT, and is not stopped.
--     grading_program_usage() names the lesson types pointing at a
--     syllabus and counts the swimmers with progress on it. The admin
--     screen shows this while the syllabus is being edited. It is a
--     reminder, not a gate -- Anthony's words -- because the person
--     editing usually knows exactly what they are doing and being
--     blocked by their own tool is worse than being told.
--
--  3. A SWIMMER WHO MOVES KEEPS BOTH LADDERS.
--     student_grading() gains `previous`: every other syllabus this
--     swimmer has real progress on, each with its full stage list and
--     every tick still against it. The parent app shows the current one
--     and then the earlier one below it, with a line saying they have
--     since moved.
--
--     "Real progress" means a tick or an earned stage -- not a stored
--     "they switched" flag. That is what makes reinstating free: point
--     the lesson type back at the first syllabus and it becomes the
--     current one again, so it is no longer in `previous`, so the
--     remark disappears by itself. Nothing has to be undone, and a
--     syllabus someone opened by mistake and never ticked never shows
--     up at all.
--
--  NOTHING IS REMOVED OR REORDERED. student_grading() gains one key;
--  `also_earned` stays exactly as it is, because a phone running last
--  month's build still reads it.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
-- The ladder below reads m.band, m.award_name and m.formal_name.
-- plpgsql resolves a column name when the query RUNS, so out of order
-- this file installs perfectly and every parent gets a blank ladder.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_milestones'
                    and column_name = 'band') then
    raise exception 'grading_milestones.band does not exist. Run supabase_grading_bands.sql first, then this file again.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_milestones'
                    and column_name = 'formal_name') then
    raise exception 'grading_milestones.formal_name does not exist. Run supabase_grading_friendly_names.sql first, then this file again.';
  end if;
end $$;


-- ─── One stage list, written once ───────────────────────────────────────
-- student_grading() now draws two ladders or more. Spelling the stage
-- expression out per ladder is how the current one and the previous one
-- quietly drift apart -- someone adds a field to the first copy. So it
-- lives here and both callers get the same shape by construction.
create or replace function grading_ladder(p_student uuid, p_program uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(ms order by (ms->>'level_no')::int)
      from (
        select jsonb_build_object(
          'id', m.id, 'level_no', m.level_no, 'label', m.label, 'name', m.name,
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
                   -- Printed order, always. The parent app greys what is
                   -- not done rather than sinking it to the bottom, so a
                   -- line keeps its place in the list from the first
                   -- lesson to the last and a parent can follow along
                   -- with the book open beside them.
                   order by t.sort_order, t.name)
              from grading_tasks t
              left join student_task_marks k
                     on k.task_id = t.id and k.student_id = p_student
                    and k.removed_at is null
             where t.milestone_id = m.id and t.is_active), '[]'::jsonb)
        ) as ms
        from grading_milestones m
        left join student_milestones sm
               on sm.milestone_id = m.id and sm.student_id = p_student
       where m.program_id = p_program and m.is_active
      ) z), '[]'::jsonb);
$$;

-- SECURITY DEFINER and it takes a student id, so left alone it would be
-- a way for anyone holding the anon key -- which is printed in every
-- page we serve -- to read any child's ticks by guessing a uuid. The
-- functions that wrap it do the "is this yours" check; this one does
-- not, so nobody outside gets to call it.
--
-- service_role is granted explicitly rather than left to PUBLIC: taking
-- it from public takes it from service_role too, and that is how an
-- Edge Function ends up answering "we could not check that just now".
revoke all on function grading_ladder(uuid, uuid) from public, anon, authenticated;
grant execute on function grading_ladder(uuid, uuid) to service_role;

comment on function grading_ladder(uuid, uuid) is
  'The stages of one syllabus with one swimmer''s progress against them. '
  'Used for the syllabus they are on and for any they have moved off. '
  'Not callable from a browser: it does no ownership check, because the '
  'functions that call it have already done one.';


-- ─── How many swimmers are on it ────────────────────────────────────────
-- Counted here rather than inside grading_program_usage, because
-- delete_grading_program needs the same number and must not inherit
-- that function's "are you signed in to the website" gate. A delete
-- that refused with a null reason because an inner function wanted a
-- JWT would be the worst kind of refusal: correct, and unreadable.
--
-- A swimmer counts as "on it" for either reason: a coach has ticked
-- something, or a stage has been awarded. Counting ticks alone would
-- call a syllabus unused the moment every stage on it was complete.
create or replace function grading_program_swimmers(p_program uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(distinct s)::integer from (
    select k.student_id as s
      from student_task_marks k
      join grading_tasks t on t.id = k.task_id
      join grading_milestones m on m.id = t.milestone_id
     where m.program_id = p_program and k.removed_at is null
    union
    select sm.student_id
      from student_milestones sm
      join grading_milestones m on m.id = sm.milestone_id
     where m.program_id = p_program and sm.revoked_at is null) u;
$$;

revoke all on function grading_program_swimmers(uuid) from public, anon;
grant execute on function grading_program_swimmers(uuid) to authenticated, service_role;


-- ─── Who is using this syllabus? ────────────────────────────────────────
-- Advisory. It gates nothing; the admin screen shows it beside the
-- editor so that a change to a syllabus taught to forty children is a
-- decision rather than a surprise.
create or replace function grading_program_usage(p_program uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_website_login() then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  if not exists (select 1 from grading_programs where id = p_program) then
    return jsonb_build_object('ok', false, 'error', 'No such syllabus.');
  end if;

  select jsonb_build_object(
    'ok', true,
    'program', jsonb_build_object('id', p.id, 'name', p.name,
                                  'is_active', p.is_active),
    'lesson_types', coalesce((
      select jsonb_agg(jsonb_build_object('id', lt.id, 'name', lt.name)
                       order by lt.sort_order nulls last, lt.name)
        from scheduler_lesson_types lt
       where lt.grading_program_id = p.id), '[]'::jsonb),
    'stages', (select count(*) from grading_milestones m where m.program_id = p.id),
    'tasks',  (select count(*) from grading_tasks t
                 join grading_milestones m on m.id = t.milestone_id
                where m.program_id = p.id),
    'swimmers', grading_program_swimmers(p.id),
    'awards', (
      select count(*) from student_milestones sm
       join grading_milestones m on m.id = sm.milestone_id
      where m.program_id = p.id and sm.revoked_at is null))
   into v_out
   from grading_programs p where p.id = p_program;

  return v_out
      || jsonb_build_object(
           'deletable', (v_out->>'swimmers')::int = 0,
           'reason', case when (v_out->>'swimmers')::int = 0 then null
                     else (v_out->>'swimmers')
                       || ' swimmer(s) have progress recorded on this syllabus. '
                       || 'Turn it off instead -- their records stay readable.' end);
end $$;

revoke all on function grading_program_usage(uuid) from public, anon;
grant execute on function grading_program_usage(uuid) to authenticated, service_role;


-- ─── Deleting one ───────────────────────────────────────────────────────
-- Two arguments on purpose. p_confirm is the word the admin screen makes
-- the person type, passed through, so the check survives the screen.
create or replace function delete_grading_program(p_program uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_on   integer;
  v_ms   integer; v_tk integer; v_lt integer;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if coalesce(lower(trim(p_confirm)), '') <> 'delete' then
    return jsonb_build_object('ok', false,
      'error', 'Type the word delete to confirm.');
  end if;

  select name into v_name from grading_programs where id = p_program;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such syllabus.');
  end if;

  v_on := grading_program_swimmers(p_program);
  if v_on > 0 then
    return jsonb_build_object('ok', false, 'swimmers', v_on,
      'error', v_on || ' swimmer(s) have progress recorded on this syllabus. '
            || 'Turn it off instead -- their records stay readable.');
  end if;

  -- A lesson type pointing at a syllabus that is about to stop existing
  -- would fail the foreign key. Cleared rather than left: a lesson type
  -- with no syllabus is the state the office already understands, and
  -- its own record is untouched.
  update scheduler_lesson_types set grading_program_id = null
   where grading_program_id = p_program;
  get diagnostics v_lt = row_count;

  delete from grading_tasks t
   using grading_milestones m
   where m.id = t.milestone_id and m.program_id = p_program;
  get diagnostics v_tk = row_count;

  delete from grading_milestones where program_id = p_program;
  get diagnostics v_ms = row_count;

  delete from grading_programs where id = p_program;

  return jsonb_build_object('ok', true, 'name', v_name,
    'stages', v_ms, 'tasks', v_tk, 'lesson_types_cleared', v_lt);
end $$;

revoke all on function delete_grading_program(uuid, text) from public, anon;
grant execute on function delete_grading_program(uuid, text) to authenticated, service_role;

comment on function delete_grading_program(uuid, text) is
  'Removes a syllabus and its stages and tasks. Refuses without the word '
  '"delete", and refuses once any swimmer has progress on it -- those are '
  'records, and the rule here is void, do not delete.';


-- ─── student_grading(), now carrying what came before ───────────────────
-- Re-created whole, as every change to this function is. New since
-- supabase_grading_friendly_names.sql: `previous`.
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

    -- ── The syllabus or syllabuses they were on before ────────────────
    -- Driven by progress, not by a flag. Reinstating the old syllabus
    -- makes it the current one, which takes it out of here, which
    -- removes the remark -- with nothing to clear up.
    'previous', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pv.id, 'name', pv.name, 'subtitle', pv.subtitle,
               'icon', pv.icon_path, 'colour', pv.colour,
               'is_active', pv.is_active,
               'syllabus', case
                 when coalesce(pv.syllabus_body, pv.syllabus_name,
                               pv.syllabus_version, pv.syllabus_note,
                               pv.syllabus_url) is null then null
                 else jsonb_build_object('body', pv.syllabus_body,
                                         'name', pv.syllabus_name,
                                         'version', pv.syllabus_version,
                                         'note', pv.syllabus_note,
                                         'url', pv.syllabus_url) end,
               'levels_total', (select count(*) from grading_milestones m3
                                 where m3.program_id = pv.id and m3.is_active),
               'level', (select max(m4.level_no) from student_milestones sm4
                           join grading_milestones m4 on m4.id = sm4.milestone_id
                          where sm4.student_id = p_student
                            and sm4.revoked_at is null
                            and m4.program_id = pv.id),
               -- When this syllabus was last worked on. We do not record
               -- the moment a lesson type was repointed, so saying "moved
               -- on 3 March" would be a guess. The last tick is a fact.
               'last_seen', greatest(
                 (select max(k5.marked_at) from student_task_marks k5
                    join grading_tasks t5 on t5.id = k5.task_id
                    join grading_milestones m5 on m5.id = t5.milestone_id
                   where k5.student_id = p_student and k5.removed_at is null
                     and m5.program_id = pv.id),
                 (select max(sm6.achieved_at) from student_milestones sm6
                    join grading_milestones m6 on m6.id = sm6.milestone_id
                   where sm6.student_id = p_student and sm6.revoked_at is null
                     and m6.program_id = pv.id)),
               'milestones', grading_ladder(p_student, pv.id))
             order by pv.sort_order, pv.name)
        from grading_programs pv
       where pv.id <> v_prog
         and (exists (select 1 from student_task_marks k7
                        join grading_tasks t7 on t7.id = k7.task_id
                        join grading_milestones m7 on m7.id = t7.milestone_id
                       where k7.student_id = p_student and k7.removed_at is null
                         and m7.program_id = pv.id)
           or exists (select 1 from student_milestones sm8
                        join grading_milestones m8 on m8.id = sm8.milestone_id
                       where sm8.student_id = p_student and sm8.revoked_at is null
                         and m8.program_id = pv.id))), '[]'::jsonb),

    'milestones', grading_ladder(p_student, v_prog))
    into v_out
    from grading_programs p where p.id = v_prog;

  return v_out;
end $$;

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
-- One statement. The Supabase editor shows the result of the last
-- statement only.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the new functions' as thing,
         coalesce((select string_agg(p.proname || '(' ||
                           pg_get_function_identity_arguments(p.oid) || ')',
                           '  ·  ' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('grading_program_usage',
                                        'grading_program_swimmers',
                                        'delete_grading_program',
                                        'grading_ladder')),
                  'NONE INSTALLED') as detail
  union all
  -- THIS FILE IS RUN IN THE SUPABASE SQL EDITOR, which carries no JWT --
  -- so is_website_login() and can_write_office() are both false there,
  -- and every gate in this file refuses. That is correct behaviour and
  -- the check has to say so. The first version of this row expected one
  -- exact sentence, got the other correct refusal, and printed "do not
  -- ship this" about working code. A self-check that cannot pass where
  -- it runs is worse than no check: it teaches people to ignore it.
  select 2, 'a syllabus cannot be deleted by accident',
         case (select delete_grading_program(
                 (select id from grading_programs order by sort_order limit 1),
                 'yes')->>'error')
           when 'Type the word delete to confirm.'
             then 'refused without the word — confirmed just now'
           when 'Not allowed.'
             then 'refused outright: the SQL editor is not an office login, which '
               || 'is the stricter of the two guards. Both are in place.'
           else 'THE GUARD DID NOT REFUSE — do not ship this' end
  union all
  -- Counted straight off the tables. Going through grading_program_usage()
  -- meant this row read "none" in the SQL editor -- not because nothing is
  -- pointed at anything, but because that function wants a website login
  -- and returned an error whose missing keys turned the whole line null.
  select 3, 'syllabuses and what is pointed at them',
         coalesce((select string_agg(x.line, E'\n' order by x.line)
                     from (select p.name
                             || case when p.is_active is false then ' (off)' else '' end
                             || ' — ' ||
                             (select count(*) from scheduler_lesson_types lt
                               where lt.grading_program_id = p.id)::text
                             || ' lesson type(s), ' ||
                             grading_program_swimmers(p.id)::text
                             || ' swimmer(s)' ||
                             case when grading_program_swimmers(p.id) = 0
                                  then ' — deletable' else ' — turn off, do not delete' end
                             as line
                             from grading_programs p) x), 'none')
  union all
  select 4, 'what the parent app now gets',
         'student_grading() carries `previous`: the full stage list and every '
      || 'tick of any syllabus a swimmer has moved off. Point the lesson type '
      || 'back and it becomes current again, and the remark goes on its own.'
  union all
  select 5, 'next',
         'Deploy the admin bundle, the parent app and the coach app. Until '
      || 'then nothing looks different — this file only adds.'
  ) z
 order by z.k;
