-- ════════════════════════════════════════════════════════════════════════
--  One passport again, in three bands
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_swim_passport_split.sql FIRST. This undoes the half of
--  it that turned out to be wrong, and keeps the half that was right.
--
--  WHY THIS REVERSES THE SPLIT
--  Splitting Swim Starters out solved a real problem -- a toddler's
--  parent being told their two-year-old was "1 of 8" -- by making it a
--  separate programme. But every printed thing Star Swim has is one
--  book: one passport, one back page, one set of stickers. Two
--  programmes meant the screen and the paper disagreed about how many
--  ladders there are.
--
--  The back page itself says what the right answer is. It groups the
--  levels into bands -- Swim Basics for 1 to 3, Swim Strokes for 4 to 6
--  -- and the cover does the same, adding Swim Starters for A and B. So
--  the structure was never two programmes. It was one programme with
--  three bands, and the bands are what a count should be measured
--  against.
--
--  A toddler now reads "Swim Starters · 2 of 2", not "2 of 8", on one
--  ladder that still shows the whole journey beneath it.
--
--  WHAT A NULL BAND MEANS
--  No bands. MAS BADGES has none, and counts across its seven levels as
--  it always did. Nothing about a programme without bands changes.
--
--  NOTHING A COACH TICKED IS LOST, AGAIN. The milestones move with
--  their ids, so ticks, earned stages and recorded certificates come
--  with them. Any lesson type pointing at Swim Starters is repointed at
--  Swim Passport, because there is now only one place for it to point.
--
--  THE EMPTY PROGRAMME IS TURNED OFF, NOT DELETED. It may be named in
--  an old audit row or a note. Void, do not delete.
-- ════════════════════════════════════════════════════════════════════════

alter table grading_milestones add column if not exists band text;

comment on column grading_milestones.band is
  'The group this level belongs to on the printed chart -- Swim '
  'Starters, Swim Basics, Swim Strokes. Progress is counted within the '
  'band, so a toddler reads "2 of 2" and not "2 of 8". Null means the '
  'programme has no bands and counts across the whole ladder.';

do $$
declare
  v_pass  uuid;
  v_start uuid;
  v_n     integer;
  v_moved integer;
begin
  select id into v_pass  from grading_programs where name = 'Swim Passport';
  select id into v_start from grading_programs where name = 'Swim Starters';

  if v_pass is null then
    raise exception 'Swim Passport does not exist. Run the passport files first.';
  end if;

  -- ── Fold Swim Starters back in ───────────────────────────────────────
  if v_start is not null
     and exists (select 1 from grading_milestones where program_id = v_start) then

    -- Make room at 1 and 2 by pushing 1..6 up to 3..8. DESCENDING this
    -- time -- 6→8, then 5→7, and so on -- because each target must be
    -- free when it is wanted. The split file renumbered ascending for
    -- exactly the same reason, in the opposite direction. Get it the
    -- wrong way round and the (program_id, level_no) unique index
    -- refuses the very first row.
    for v_n in reverse 6 .. 1 loop
      update grading_milestones
         set level_no = v_n + 2
       where program_id = v_pass and level_no = v_n;
    end loop;

    update grading_milestones
       set program_id = v_pass,
           level_no   = case label when 'A' then 1 else 2 end
     where program_id = v_start;
    get diagnostics v_moved = row_count;
    raise notice 'Folded % stage(s) back into Swim Passport.', v_moved;

    -- There is only one place left to point.
    update scheduler_lesson_types
       set grading_program_id = v_pass
     where grading_program_id = v_start;

    update grading_programs
       set is_active = false,
           description = 'Folded back into Swim Passport as the Swim Starters band. '
                      || 'Kept, turned off, because older audit rows may name it.'
     where id = v_start;
  else
    raise notice 'Swim Starters is already folded in (or was never split out).';
  end if;

  -- ── The bands, from the printed chart ────────────────────────────────
  -- Set every time, so a level added by hand later can be banded by
  -- re-running this file.
  update grading_milestones m
     set band = case
                  when m.level_no <= 2 then 'Swim Starters'
                  when m.level_no <= 5 then 'Swim Basics'
                  else 'Swim Strokes'
                end
   where m.program_id = v_pass;

  update grading_programs
     set subtitle    = 'Learn to Swim',
         sort_order  = 2,
         description = 'Star Swim''s Learn to Swim ladder, in three bands. Swim '
                    || 'Starters (A–B) is done with a parent in the water, roughly '
                    || '2½ to 5. Swim Basics (1–3) is the water safety every child '
                    || 'should have. Swim Strokes (4–6) is the four strokes with '
                    || 'turns. Progress is counted within the band, because that is '
                    || 'the stretch a family is actually enrolled for.'
   where id = v_pass;

  raise notice 'Bands set: Swim Starters A–B, Swim Basics 1–3, Swim Strokes 4–6.';
end $$;


-- ─── student_grading(), counting within the band ────────────────────────
-- Re-created whole, as every change to this function is. New since
-- supabase_swim_passport_split.sql: `band` on each milestone, and a
-- `band` block saying which one the child is working in and how far
-- through it they are.
--
-- The band a child is "in" is the band of the lowest level they have NOT
-- yet earned -- not the highest they have. A child who has just finished
-- Water Explorer is starting Swim Basics, and that is what their parent
-- should be shown. When every level is earned, the last band stands.
create or replace function student_grading(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_prog   uuid; v_out jsonb; v_high integer; v_levels integer;
  v_band   text; v_band_total integer; v_band_done integer;
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

  -- The band of the first rung still to climb.
  select m.band into v_band
    from grading_milestones m
   where m.program_id = v_prog and m.is_active and m.band is not null
     and not exists (select 1 from student_milestones sm
                      where sm.milestone_id = m.id and sm.student_id = p_student
                        and sm.revoked_at is null)
   order by m.level_no
   limit 1;

  -- Every level earned: the last band is where they finished.
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
    -- The badge: highest ACTIVATED level, and nothing else.
    'level', v_high,
    'levels_total', v_levels,
    -- Null where the programme has no bands, which is how a client
    -- tells "count within the band" from "count across the ladder".
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
  'One child''s ladder: the programme, the syllabus behind it, the band '
  'they are working in and how far through it they are, every milestone '
  'with its badge label and done/total, every task marked or not, and '
  'what they earned on any other programme. The one shape the coach '
  'app, the office and the parent app all draw.';

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the programmes' as thing,
         (select string_agg(p.name || ' (' ||
                   (select count(*) from grading_milestones m
                     where m.program_id = p.id and m.is_active) || ')'
                   || case when p.is_active = false then ' — off' else '' end,
                 ' · ' order by p.sort_order, p.name)
            from grading_programs p) as detail
  union all
  select 2, 'the one ladder, in bands',
         coalesce((select string_agg(m.band || ' ' || m.label || ' ' || m.name,
                           ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.is_active), 'NOT BANDED')
  union all
  select 3, 'what each band is worth',
         coalesce((select string_agg(b.band || ' = ' || b.n || ' stage(s)', ' · '
                             order by b.lo)
                     from (select m.band, count(*) n, min(m.level_no) lo
                             from grading_milestones m
                             join grading_programs p on p.id = m.program_id
                            where p.name = 'Swim Passport' and m.is_active
                            group by m.band) b), 'NONE')
      || '. A toddler reads "Swim Starters · 2 of 2", not "2 of 8".'
  union all
  select 4, 'nothing was lost in the fold',
         (select count(*)::text from student_task_marks k
            join grading_tasks t on t.id = k.task_id
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and k.removed_at is null)
      || ' live tick(s) on the ladder. The stages moved with their ids, so every '
      || 'tick, earned stage and certificate came with them.'
  union all
  select 5, 'programmes with no bands',
         coalesce((select string_agg(distinct p.name, ', ')
                     from grading_programs p
                     join grading_milestones m on m.program_id = p.id
                    where m.band is null and m.is_active), 'none')
      || ' — which is correct: they count across the whole ladder, as before.'
  union all
  select 6, 'YOUR MOVE — lesson types',
         coalesce((select string_agg(lt.name, ', ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id
                    where p.name = 'Swim Passport'),
                  'NONE point at Swim Passport. Settings → Lesson Types → '
               || '"Graded on": toddler and Learn to Swim types now go to the SAME '
               || 'programme — the band sorts them out. Until you do this nobody '
               || 'is graded.')
  union all
  select 7, 'next',
         'Deploy the parent app: it draws the band headings and counts within the '
      || 'band. An older build shows one long list of eight and the "2 of 8" '
      || 'problem comes back.'
  ) z
 order by z.k;
