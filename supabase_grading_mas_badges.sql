-- ════════════════════════════════════════════════════════════════════════
--  MAS BADGES — the seven-level Learn to Swim syllabus
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run: on a
--  second run it reports what is already there and changes nothing.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql, supabase_grading_colours.sql AND
--  supabase_grading_syllabus.sql FIRST. This fills in the ladder and the
--  attribution they made room for. Without the syllabus file the colour
--  and level data still land, but `syllabus_body` does not exist and the
--  file stops with "column does not exist".
--
--  WHAT THIS IS
--  Malaysia Aquatics' Swimming Proficiency Test, version 1.0, as the
--  Syllabus states it: seven levels, Starfish through Dolphin, and the
--  forty-five Assessment Criteria beneath them.
--
--  IT IS A FOURTH PROGRAMME, BESIDE THE THREE ALREADY THERE
--  Water Discovery, Swim Passport and Advanced Program are ours, written
--  here. MAS BADGES joins them rather than replacing one: a programme is
--  chosen per lesson type, and which lesson types are graded on which
--  ladder is an office decision, not this file's. Nothing that already
--  points at Swim Passport moves.
--
--  SO IT GRADES NOBODY UNTIL A LESSON TYPE POINTS AT IT.
--  Settings → Lesson Types → "Graded on". The confirm block at the
--  bottom says in as many words whether that has been done.
--
--  THE CRITERIA ARE THE TASKS. THE TEACHING OBJECTIVE IS NOT.
--  Each level in the Syllabus has two columns. The left is teaching
--  intent -- Introduce, Reinforce, Develop -- and the Syllabus says
--  plainly it is "not the pass bar". The right is what an examiner
--  assesses, observable and binary. Only the right column is loaded
--  here. Ticking "Introduce basic back mobility" would be ticking an
--  intention, and no two coaches would agree on when it was done.
--
--  THE ARTWORK IS THE REAL ARTWORK
--  Each level carries the MAS badge roundel the Syllabus prints, and the
--  level colours are sampled from its own pages -- so a level reads the
--  same on a phone as on the printed sheet. The images are served from
--  this site (/badges/...), not from the grading-icons bucket, because
--  they ship with the build and nobody should have to re-upload seven
--  files to stand a new environment up. An icon uploaded in Settings →
--  Grading still goes to the bucket and still wins; the apps read both.
--
--  IT REFUSES IF ANY CHILD HAS BEEN TICKED AGAINST ITS LEVELS.
--  A tick is a coach saying they watched a child do something, and this
--  file is not entitled to throw that away to re-seed a ladder.
--
--  ─────────────────────────────────────────────────────────────────────
--  ONE THING THIS CANNOT DO, AND SHOULD NOT PRETEND TO
--  ─────────────────────────────────────────────────────────────────────
--  The Syllabus is explicit about how MAS records a result: "The Portal
--  does not store partial criteria; the examiner judges the level as a
--  whole", outcomes are Pass or Refer per candidate per level, and "a
--  certificate is issued only on a recorded pass, gated and serialised".
--
--  This module does something different and useful, and they are not the
--  same thing. Here a coach ticks each criterion as they see it, and the
--  level lights up when all of them are ticked. That is Star Swim's
--  teaching record: what this child has been seen to do. It is not a MAS
--  assessment, the coach ticking is not an assigned examiner, and the
--  certificate flag below records that a piece of paper was handed over
--  -- not that MAS issued a serialised one.
--
--  Which means a badge in the parent app says "her coaches have seen all
--  seven" and must never be worded as "MAS has certified her". That
--  sentence is not left to whoever writes the next screen: it is stored
--  on the programme as syllabus_note, and the apps print it.
-- ════════════════════════════════════════════════════════════════════════

do $$
declare
  v_prog uuid;
  v_ms   uuid;
  v_held integer;
  v_old  integer;
begin
  -- ── The programme ────────────────────────────────────────────────────
  -- Its own row, beside Water Discovery, Swim Passport and Advanced
  -- Program. Found by name so a re-run updates rather than duplicates;
  -- the unique index on name would refuse the duplicate anyway, and a
  -- file that falls over on its second run is a file nobody dares run.
  select id into v_prog from grading_programs where name = 'MAS BADGES';

  if v_prog is null then
    insert into grading_programs (name, subtitle, description, sort_order, colour)
    values ('MAS BADGES', 'Learn to Swim',
            'Malaysia Aquatics'' Swimming Proficiency Test. Seven levels from a '
         || 'first splash to competition readiness. Progression is '
         || 'competency-based, not age-based.', 4, '#0A435E')
    returning id into v_prog;
    raise notice 'Created the MAS BADGES programme.';
  else
    raise notice 'MAS BADGES already exists; updating it in place.';
  end if;

  -- The attribution, and the sentence about what a badge here does not
  -- mean. Set every time, because this is the file that knows them.
  update grading_programs
     set subtitle         = 'Learn to Swim',
         description      = 'Malaysia Aquatics'' Swimming Proficiency Test. Seven '
                         || 'levels from a first splash to competition readiness. '
                         || 'Progression is competency-based, not age-based.',
         colour           = coalesce(colour, '#0A435E'),
         icon_path        = coalesce(icon_path, '/badges/mas-badges-mark.png'),
         syllabus_body    = 'Malaysia Aquatics',
         syllabus_name    = 'BADGES — Swimming Proficiency Test',
         syllabus_version = '1.0',
         syllabus_note    = 'The levels, their names and their criteria are '
                         || 'Malaysia Aquatics''. A level lights up here when a '
                         || 'Star Swim coach has ticked every criterion — it is '
                         || 'our teaching record of what your child has been seen '
                         || 'to do. A MAS proficiency award is a separate '
                         || 'assessment, judged as a whole by an assigned '
                         || 'examiner, and certificated by MAS.'
   where id = v_prog;

  -- ── Already done? ────────────────────────────────────────────────────
  if exists (select 1 from grading_milestones
              where program_id = v_prog and level_no = 7 and name = 'Dolphin') then
    raise notice 'The seven MAS levels are already installed. Nothing changed.';
    return;
  end if;

  -- ── Is anything a child holds in the way? ────────────────────────────
  -- A tick is a coach saying they watched a child do something. This
  -- file is not entitled to throw that away to re-seed a ladder, so it
  -- stops and says what is in the way.
  select count(*) into v_held
    from student_task_marks k
    join grading_tasks t on t.id = k.task_id
    join grading_milestones m on m.id = t.milestone_id
   where m.program_id = v_prog;

  if v_held > 0 then
    raise exception
      'Cannot re-seed this programme: % task mark(s) already recorded against its '
      'levels. Those are coaches'' observations of real children. Fix the levels by '
      'hand in Settings → Grading, or point the lesson types at a NEW programme.', v_held;
  end if;

  select count(*) into v_old from grading_milestones where program_id = v_prog;
  delete from grading_tasks t
   using grading_milestones m
   where t.milestone_id = m.id and m.program_id = v_prog;
  delete from grading_milestones where program_id = v_prog;
  if v_old > 0 then
    raise notice 'Removed % half-built level(s) and their tasks.', v_old;
  end if;

  -- ── Level 1 · Starfish ───────────────────────────────────────────────
  -- Colours are sampled from the Syllabus' own level pages, so a level
  -- reads the same on a phone as on the printed sheet.
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 1, 'Starfish',
          'Water familiarisation, breath control, basic floating and gliding · '
       || 'Comfort and safety. All skills in shallow water, performed independently.',
          true, '#F0713C', '/badges/mas-1-starfish.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Enter and exit the pool safely', 1),
    (v_ms, 'Exhale (blow bubbles) with the head fully submerged and inhale on resurfacing for 10 repetitions (bobbing)', 2),
    (v_ms, 'Perform a front float comfortably for 10 seconds', 3),
    (v_ms, 'Perform a back float comfortably for 10 seconds', 4),
    (v_ms, 'Perform a streamlined front flutter kick for 3 metres', 5),
    (v_ms, 'Perform a back push and glide for 2 metres', 6),
    (v_ms, 'Perform a lateral rotation from a horizontal floating position — back to front and front to back', 7);

  -- ── Level 2 · Sea Turtle ─────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 2, 'Sea Turtle',
          'Self-survival to the wall; basic stroke shapes front and back · '
       || 'Basic mobility. All skills in shallow water, performed independently.',
          true, '#159C8B', '/badges/mas-2-sea-turtle.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Fall in, perform a turn in the water and grab onto a wall or ledge', 1),
    (v_ms, 'Perform basic front crawl arm movement with flutter kick for 5 metres', 2),
    (v_ms, 'Perform back flutter kick for 5 metres', 3),
    (v_ms, 'Perform basic backstroke arm movement with flutter kick for 5 metres', 4),
    (v_ms, 'Perform reach-and-pull with comfortable breath for 5 metres', 5);

  -- ── Level 3 · Guppy ──────────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 3, 'Guppy',
          'Front crawl with breathing, backstroke, deep-water treading · '
       || 'Independent swimmer. Shallow or deep water, performed independently.',
          true, '#0E93B8', '/badges/mas-3-guppy.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Perform basic front crawl swim with unilateral breathing for 10 metres', 1),
    (v_ms, 'Perform backstroke swim for 10 metres', 2),
    (v_ms, 'Perform a streamlined underwater push and glide for 3 metres', 3),
    (v_ms, 'Perform water treading for 30 seconds', 4);

  -- ── Level 4 · Octopus ────────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 4, 'Octopus',
          'Bilateral breathing, breaststroke kick, sit dive, survival backstroke · '
       || 'Three-stroke familiarity. Shallow or deep water, performed independently. '
       || 'Every Malaysian child who learns to swim should reach at least this level.',
          true, '#E0483B', '/badges/mas-4-octopus.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Perform front crawl with bilateral breathing for 15 metres', 1),
    (v_ms, 'Perform backstroke swim for 15 metres', 2),
    (v_ms, 'Perform breaststroke whip kick for 10 metres', 3),
    (v_ms, 'Perform a sit dive off the wet deck with underwater streamline glide for 3 metres', 4),
    (v_ms, 'Perform survival backstroke swim for 10 metres', 5);

  -- ── Level 5 · Frog ───────────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 5, 'Frog',
          'Full breaststroke, dolphin kick, sculling, basic flip turn, squat dive · '
       || 'Stroke breadth. Shallow or deep water, performed independently.',
          true, '#4FA45C', '/badges/mas-5-frog.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Perform front crawl with bilateral breathing for 25 metres', 1),
    (v_ms, 'Perform backstroke swim for 25 metres', 2),
    (v_ms, 'Perform breaststroke swim for 25 metres', 3),
    (v_ms, 'Perform dolphin kick for 10 metres', 4),
    (v_ms, 'Perform sculling with flutter kick and breathing for 15 metres', 5),
    (v_ms, 'Perform a 360° flip turn forwards and backwards separately', 6),
    (v_ms, 'Perform a squat dive off the wet deck with underwater dolphin kick for 5 metres', 7);

  -- ── Level 6 · Swordfish ──────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 6, 'Swordfish',
          'Butterfly, breaststroke pullout, tumble and open turns, sidestroke · '
       || 'Competition exposure encouraged. Shallow or deep water, performed '
       || 'independently.',
          true, '#2A72D4', '/badges/mas-6-swordfish.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Perform front crawl swim for 50 metres', 1),
    (v_ms, 'Perform backstroke swim for 50 metres', 2),
    (v_ms, 'Perform breaststroke with underwater pullout swim for 50 metres', 3),
    (v_ms, 'Perform butterfly for 10 metres', 4),
    (v_ms, 'Perform swim into the wall, tumble turn, and out of the wall with underwater kicks', 5),
    (v_ms, 'Perform swim into the wall, open turn, and out of the wall with underwater kicks', 6),
    (v_ms, 'Perform a stand dive off the wet deck with underwater dolphin kick for 5 metres', 7),
    (v_ms, 'Perform sidestroke for 15 metres', 8);

  -- ── Level 7 · Dolphin ────────────────────────────────────────────────
  insert into grading_milestones (program_id, level_no, name, description,
                                  certificate, colour, icon_path)
  values (v_prog, 7, 'Dolphin',
          'All four strokes to competitive distance, IM, backstroke dive, time '
       || 'qualification · Competitive readiness. All skills in deep water, '
       || 'performed independently.',
          true, '#6A4BD0', '/badges/mas-7-dolphin.png')
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Perform front crawl swim with high elbow for 100 metres within 2:30.00', 1),
    (v_ms, 'Perform backstroke swim with competitive pull for 100 metres', 2),
    (v_ms, 'Perform breaststroke swim with underwater pullout for 100 metres', 3),
    (v_ms, 'Perform butterfly for 50 metres', 4),
    (v_ms, 'Perform swim into the wall, tumble turn, and out of the wall with underwater kicks', 5),
    (v_ms, 'Perform swim into the wall, open turn, and out of the wall with underwater kicks', 6),
    (v_ms, 'Perform a stand dive off the blocks or wet deck with underwater skills into swim', 7),
    (v_ms, 'Perform a backstroke dive off the blocks or wet deck with underwater skills into swim', 8),
    (v_ms, 'Perform Individual Medley for 100 metres within 3:00.00', 9);

  raise notice 'MAS BADGES installed: seven levels, forty-five criteria.';
end $$;


-- ─── What is now in place ───────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the four programmes' as thing,
         (select string_agg(p.name || ' (' ||
                   (select count(*) from grading_milestones m
                     where m.program_id = p.id and m.is_active) || ')',
                 ' · ' order by p.sort_order, p.name)
            from grading_programs p) as detail
  union all
  select 2, 'the MAS ladder',
         coalesce((select string_agg('L' || m.level_no || ' ' || m.name
                          || ' (' || (select count(*) from grading_tasks t
                                       where t.milestone_id = m.id and t.is_active) || ')',
                          ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'MAS BADGES' and m.is_active), 'NOT INSTALLED')
  union all
  select 3, 'criteria in all seven',
         (select count(*)::text from grading_tasks t
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.name = 'MAS BADGES' and t.is_active)
      || ' — the Assessment Criteria only. The Teaching Objective is intent, '
      || 'and the Syllabus says it is not the pass bar.'
  union all
  select 4, 'badge artwork',
         (select count(*)::text from grading_milestones m
            join grading_programs p on p.id = m.program_id
           where p.name = 'MAS BADGES' and m.icon_path like '/badges/%')
      || ' of 7 levels carry their roundel, served from this site. If they '
      || 'do not appear, the build carrying /badges/ has not deployed yet.'
  union all
  select 5, 'the syllabus credited',
         coalesce((select p.syllabus_body || ' · ' || p.syllabus_name
                        || ' v' || p.syllabus_version
                     from grading_programs p where p.name = 'MAS BADGES'),
                  'NOT SET — run supabase_grading_syllabus.sql first')
  union all
  select 6, 'lesson types graded on it',
         coalesce((select string_agg(lt.name, ', ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id
                    where p.name = 'MAS BADGES'),
                  'NONE — nobody is graded on it yet. Settings → Lesson Types → '
               || '"Graded on" is where that is decided, and until it is, this '
               || 'programme sits in the list doing nothing.')
  union all
  select 7, 'what a badge here means',
         'That a coach has ticked every criterion. It is Star Swim''s teaching '
      || 'record, not a MAS assessment: MAS judges a level as a whole, through '
      || 'an assigned examiner, and issues its certificates serialised. That '
      || 'sentence is stored on the programme, and the apps print it.'
  ) z
 order by z.k;
