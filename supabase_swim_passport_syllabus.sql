-- ════════════════════════════════════════════════════════════════════════
--  Swim Passport — Star Swim's eight-stage Learn to Swim ladder
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run: on a
--  second run it reports what is already there and changes nothing.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN THESE FIRST, IN THIS ORDER:
--    supabase_grading_programs.sql
--    supabase_grading_colours.sql
--    supabase_grading_syllabus.sql
--    supabase_grading_stage_labels.sql
--  Without the last two this file stops with "column does not exist".
--
--  WHAT THIS IS
--  The Swim Passport ladder, taken from the printed passport artwork:
--  eight stages, A and B for a parent and child in the water together,
--  then 1 to 6 from first independent submersion to all four strokes
--  with turns. Sixty-eight skills in all, worded as the passport words
--  them.
--
--  IT REPLACES THE THREE PLACEHOLDER LEVELS ON SWIM PASSPORT
--  Guppy, Tortoise and Crab shipped with supabase_grading_programs.sql
--  as something to look at while the module was built. The programme
--  keeps its id, so every lesson type already pointing at it stays
--  pointed at it and nobody has to re-choose anything.
--
--  ─────────────────────────────────────────────────────────────────────
--  WHERE THIS LADDER COMES FROM, WHICH IS NOT A DETAIL
--  ─────────────────────────────────────────────────────────────────────
--  The stage names -- Water Discovery, Water Exploration, Water
--  Acclimation, Water Movement, Water Stamina, Stroke Introduction,
--  Stroke Development, Stroke Mechanics -- and the Swim Starters /
--  Swim Basics / Swim Strokes grouping above them are the YMCA of the
--  USA's swim lesson framework. They are published by YMCA associations
--  worldwide and are not Star Swim's invention.
--
--  What IS ours: which skills we assess, how we word them, the teaching
--  behind them, and the record this module keeps. So syllabus_body says
--  Star Swim and syllabus_note says where the stage structure came
--  from. Both are editable in Settings → Grading, and the apps print
--  whatever is there. Claiming authorship of the structure in that box
--  would be a claim the box exists to make honestly.
--
--  THE ARTWORK
--  The eight roundels are the passport's own stickers, re-branded: the
--  KuRenang lockup is gone from each and Star Swim's is in its place.
--  They are served from this site (/badges/ss-*.png), not the
--  grading-icons bucket, so they ship with the build. An icon uploaded
--  in Settings → Grading still goes to the bucket and still wins.
--
--  THE LABELS ARE WHAT THE STICKER SAYS
--  level_no runs 1 to 8 so the ladder has an order and a "3 of 8".
--  label is A, B, 1 … 6, which is what the child's sticker says. The
--  apps print the label where there is one. Without this the app would
--  say "Level 3" beside a sticker reading "Learn to Swim 1".
--
--  IT REFUSES IF ANY CHILD HAS BEEN TICKED AGAINST THE OLD LEVELS.
--  A tick is a coach saying they watched a child do something, and this
--  file is not entitled to throw that away to make room for a better
--  ladder.
-- ════════════════════════════════════════════════════════════════════════

do $$
declare
  v_prog uuid;
  v_ms   uuid;
  v_held integer;
  v_old  integer;
begin
  select id into v_prog from grading_programs where name = 'Swim Passport';

  if v_prog is null then
    insert into grading_programs (name, subtitle, sort_order, colour)
    values ('Swim Passport', 'Learn to Swim', 2, '#0C63AF')
    returning id into v_prog;
    raise notice 'Created the Swim Passport programme.';
  end if;

  update grading_programs
     set subtitle         = 'Learn to Swim',
         description      = 'Star Swim''s Learn to Swim ladder. Eight stages: A and B '
                         || 'in the water with a parent, then 1 to 6 from a first '
                         || 'independent submersion to all four strokes with turns. '
                         || 'Progression is competency-based, not age-based.',
         colour           = coalesce(colour, '#0C63AF'),
         icon_path        = coalesce(icon_path, '/badges/star-swim-mark.png'),
         syllabus_body    = 'Star Swim',
         syllabus_name    = 'Swim Passport',
         syllabus_version = '1.0',
         syllabus_note    = 'Star Swim''s own Learn to Swim ladder: eight stages from '
                         || 'a first splash with a parent to all four strokes with '
                         || 'turns. The stage names and the Swim Starters / Swim '
                         || 'Basics / Swim Strokes grouping follow the YMCA of the '
                         || 'USA swim lesson framework. A stage lights up here when '
                         || 'a Star Swim coach has ticked every skill on it — it is '
                         || 'our record of what your child has been seen to do.'
   where id = v_prog;

  -- ── Already done? ────────────────────────────────────────────────────
  if exists (select 1 from grading_milestones
              where program_id = v_prog and level_no = 8 and name = 'Stroke Mechanics') then
    raise notice 'The eight stages are already installed. Nothing changed.';
    return;
  end if;

  -- ── Is anything a child holds in the way? ────────────────────────────
  select count(*) into v_held
    from student_task_marks k
    join grading_tasks t on t.id = k.task_id
    join grading_milestones m on m.id = t.milestone_id
   where m.program_id = v_prog;

  if v_held > 0 then
    raise exception
      'Cannot replace this programme: % task mark(s) already recorded against its '
      'levels. Those are coaches'' observations of real children. Move or retire '
      'the old levels by hand, or point the lesson types at a NEW programme.', v_held;
  end if;

  select count(*) into v_old from grading_milestones where program_id = v_prog;
  delete from grading_tasks t
   using grading_milestones m
   where t.milestone_id = m.id and m.program_id = v_prog;
  delete from grading_milestones where program_id = v_prog;
  if v_old > 0 then
    raise notice 'Removed % placeholder level(s) and their tasks.', v_old;
  end if;

  -- ══ SWIM STARTERS · parent and child lessons ═════════════════════════

  -- ── Stage A · Water Discovery ────────────────────────────────────────
  -- Colours are sampled from the passport's own stage chips, so a stage
  -- reads the same on a phone as on the printed sheet.
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 1, 'A', 'Water Discovery',
          'Swim Starters · Introduces infants and toddlers to the aquatic '
       || 'environment. A parent is in the water throughout.',
          true, '#2CBDBE', '/badges/ss-a-water-discovery.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Blow bubbles on surface, assisted', 1),
    (v_ms, 'Front tow chin in water, assisted', 2),
    (v_ms, 'Front float chin in water, assisted', 3),
    (v_ms, 'Back float assisted, head on shoulder', 4),
    (v_ms, 'Back tow assisted, head on shoulder', 5),
    (v_ms, 'Roll assisted, back to front & front to back', 6),
    (v_ms, 'Wall grab, assisted', 7),
    (v_ms, 'Water exit parent & child together', 8),
    (v_ms, 'Water entry parent & child together', 9);

  -- ── Stage B · Water Exploration ──────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 2, 'B', 'Water Exploration',
          'Swim Starters · Focuses on exploring body positions, blowing bubbles, '
       || 'and fundamental safety and aquatic skills.',
          true, '#2CACE2', '/badges/ss-b-water-exploration.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Blow bubbles mouth & nose submerged, assisted', 1),
    (v_ms, 'Front tow blow bubbles, assisted', 2),
    (v_ms, 'Front float blow bubbles, assisted', 3),
    (v_ms, 'Back float assisted, head on chest', 4),
    (v_ms, 'Back tow assisted, head on chest', 5),
    (v_ms, 'Roll assisted, back to front & front to back', 6),
    (v_ms, 'Monkey crawl assisted, on edge, 2 metres', 7),
    (v_ms, 'Water exit, assisted', 8),
    (v_ms, 'Water entry, assisted', 9);

  -- ══ SWIM BASICS · the skills everyone should have around water ═══════

  -- ── Stage 1 · Water Acclimation ──────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 3, '1', 'Water Acclimation',
          'Swim Basics · Increases comfort with underwater exploration and '
       || 'introduces basic self-rescue skills performed with assistance.',
          true, '#C51A8D', '/badges/ss-1-water-acclimation.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Submerge, bob independently', 1),
    (v_ms, 'Front glide assisted, to wall, 3 metres', 2),
    (v_ms, 'Front float assisted, 10 secs., recover independently', 3),
    (v_ms, 'Back float assisted, 10 secs., recover independently', 4),
    (v_ms, 'Back glide assisted, at wall, 3 metres', 5),
    (v_ms, 'Water exit independently', 6),
    (v_ms, 'Roll assisted, back to front & front to back', 7),
    (v_ms, 'Jump, push, turn, grab assisted', 8),
    (v_ms, 'Swim, float, swim assisted, 5 metres', 9);

  -- ── Stage 2 · Water Movement ─────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 4, '2', 'Water Movement',
          'Swim Basics · Encourages forward movement in water and basic '
       || 'self-rescue skills performed independently.',
          true, '#F15B25', '/badges/ss-2-water-movement.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Submerge look at object on bottom', 1),
    (v_ms, 'Front glide 3 metres', 2),
    (v_ms, 'Front float 20 secs.', 3),
    (v_ms, 'Back float 20 secs.', 4),
    (v_ms, 'Back glide 3 metres', 5),
    (v_ms, 'Roll back to front & front to back', 6),
    (v_ms, 'Tread water 10 secs., near wall, & exit', 7),
    (v_ms, 'Jump, push, turn, grab', 8),
    (v_ms, 'Swim, float, swim 5 metres', 9);

  -- ── Stage 3 · Water Stamina ──────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 5, '3', 'Water Stamina',
          'Swim Basics · Develops intermediate self-rescue skills performed at '
       || 'longer distances than in previous stages. Every child who learns to '
       || 'swim should reach at least this stage.',
          true, '#E6A01C', '/badges/ss-3-water-stamina.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Submerge retrieve object in chest-deep water', 1),
    (v_ms, 'Swim on front 10 metres', 2),
    (v_ms, 'Swim on back 10 metres', 3),
    (v_ms, 'Water exit independently', 4),
    (v_ms, 'Roll back to front & front to back', 5),
    (v_ms, 'Tread water 1 min. & exit', 6),
    (v_ms, 'Jump, swim, turn, swim, grab 5 metres', 7),
    (v_ms, 'Swim, float, swim 15 metres', 8);

  -- ══ SWIM STROKES · skills to support a healthy lifestyle ═════════════

  -- ── Stage 4 · Stroke Introduction ────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 6, '4', 'Stroke Introduction',
          'Swim Strokes · Introduces basic stroke technique in front crawl and '
       || 'back crawl and reinforces water safety through treading water and '
       || 'elementary backstroke.',
          true, '#056A6C', '/badges/ss-4-stroke-introduction.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Front crawl rotary breathing, 15 metres', 1),
    (v_ms, 'Breaststroke kick, 15 metres', 2),
    (v_ms, 'Butterfly kick, 15 metres', 3),
    (v_ms, 'Backstroke swim 15 metres', 4),
    (v_ms, 'Dive sitting', 5),
    (v_ms, 'Resting stroke elementary backstroke, 15 metres', 6),
    (v_ms, 'Tread water with scissor & whip kick, 1 min.', 7),
    (v_ms, 'Endurance: any stroke or combination of strokes, 25 metres', 8);

  -- ── Stage 5 · Stroke Development ─────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 7, '5', 'Stroke Development',
          'Swim Strokes · Introduces breaststroke and butterfly and reinforces '
       || 'water safety through treading water and sidestroke.',
          true, '#0C63AF', '/badges/ss-5-stroke-development.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Front crawl bent-arm recovery, 25 metres', 1),
    (v_ms, 'Breaststroke 25 metres', 2),
    (v_ms, 'Butterfly simultaneous arm action & kick, 15 metres', 3),
    (v_ms, 'Backstroke pull, 25 metres', 4),
    (v_ms, 'Dive kneeling', 5),
    (v_ms, 'Resting stroke sidestroke, 25 metres', 6),
    (v_ms, 'Tread water scissor & whip kick, 2 mins.', 7),
    (v_ms, 'Endurance: any stroke or combination of strokes, 50 metres', 8);

  -- ── Stage 6 · Stroke Mechanics ───────────────────────────────────────
  insert into grading_milestones (program_id, level_no, label, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 8, '6', 'Stroke Mechanics',
          'Swim Strokes · Refines stroke technique on all major competitive '
       || 'strokes and encourages swimming as part of a healthy lifestyle.',
          true, '#5E2F90', '/badges/ss-6-stroke-mechanics.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Front crawl flip turn, 2 x 25 metres', 1),
    (v_ms, 'Breaststroke open turn, 2 x 25 metres', 2),
    (v_ms, 'Butterfly 25 metres', 3),
    (v_ms, 'Backstroke pull & flip turn, 2 x 25 metres', 4),
    (v_ms, 'Dive standing', 5),
    (v_ms, 'Resting stroke elementary backstroke or sidestroke, 50 metres', 6),
    (v_ms, 'Tread water retrieve object off bottom, tread 1 min.', 7),
    (v_ms, 'Endurance: any stroke or combination of strokes, 150 metres', 8);

  raise notice 'Swim Passport installed: eight stages, sixty-eight skills.';
end $$;


-- ─── What is now in place ───────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the programmes' as thing,
         (select string_agg(p.name || ' (' ||
                   (select count(*) from grading_milestones m
                     where m.program_id = p.id and m.is_active) || ')',
                 ' · ' order by p.sort_order, p.name)
            from grading_programs p) as detail
  union all
  select 2, 'the Swim Passport ladder',
         coalesce((select string_agg(coalesce(m.label, m.level_no::text) || ' ' || m.name
                          || ' (' || (select count(*) from grading_tasks t
                                       where t.milestone_id = m.id and t.is_active) || ')',
                          ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport' and m.is_active), 'NOT INSTALLED')
  union all
  select 3, 'skills in all eight',
         (select count(*)::text from grading_tasks t
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and t.is_active)
      || ' — worded as the printed passport words them, with its run-together '
      || 'distances spaced out (15mters → 15 metres).'
  union all
  select 4, 'badge artwork',
         (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'Swim Passport' and m.icon_path like '/badges/ss-%')
      || ' of 8 stages carry their sticker, re-branded to Star Swim and served '
      || 'from this site. If they do not appear, the build carrying /badges/ '
      || 'has not deployed yet.'
  union all
  select 5, 'the syllabus credited',
         coalesce((select p.syllabus_body || ' · ' || p.syllabus_name
                        || ' v' || p.syllabus_version
                     from grading_programs p where p.name = 'Swim Passport'),
                  'NOT SET — run supabase_grading_syllabus.sql first')
      || '. The note says the stage structure follows the YMCA of the USA '
      || 'framework, which it does. Edit it in Settings → Grading.'
  union all
  select 6, 'lesson types graded on it',
         coalesce((select string_agg(lt.name, ', ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id
                    where p.name = 'Swim Passport'),
                  'NONE — nobody is graded on it. Settings → Lesson Types → '
               || '"Graded on" is where that is decided.')
  union all
  select 7, 'what a stage here means',
         'That a coach has ticked every skill on it. Stages A and B are done '
      || 'with a parent in the water; 1 to 6 are performed by the child. The '
      || 'sticker in the printed passport and the badge in the app are the '
      || 'same award, recorded in one place.'
  ) z
 order by z.k;
