-- ════════════════════════════════════════════════════════════════════════
--  The platform says what the passport says
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_friendly_names.sql FIRST.
--
--  WHY
--  The Swim Passport stages were seeded from the syllabus as it stood
--  before the reconciliation. The printed passport has since been
--  corrected -- the distances raised to the school-age standard, the
--  preschool allowance dropped, "Backstroke" changed to "Back crawl",
--  and Level 2 given the "Water exit independently" line it was
--  missing. The database was not corrected with it.
--
--  So a coach holding the book and a coach holding the phone were
--  reading two different syllabuses. Thirteen lines apart, including
--  four distances on Level 3 alone -- a child could be ticked off at
--  10 metres on the phone for a skill the book sets at 15.
--
--  This file makes the database say exactly what the passport prints.
--
--  WHAT CHANGES, line by line
--    A   8,9   "parent & child together"      -> "assisted"
--    A, B      water entry moves above water exit
--    B   6,8,9,10  assisted                   -> unassisted
--    B   new   "Wall grab, unassisted"        -- was absent
--    1   2,5   glides 3 metres                -> 2 meters
--    2   2,5   glides 3 metres                -> 5 meters
--    2   new   "Water exit independently"     -- was absent
--    3   2,3   swim on front/back 10 metres   -> 15 meters
--    3   7     jump-swim-turn-swim-grab 5 m   -> 10 meters
--    3   8     swim, float, swim 15 metres    -> 25 meters
--    4,5,6 4   "Backstroke"                   -> "Back crawl"
--    all       "metres"                       -> "meters"
--
--  Stage B is the band where a child stops being held, and the seed had
--  it as nine assisted skills. The passport and the Progression chart
--  now agree that it is ten, and that four of them are unassisted --
--  which is the whole difference between A and B.
--
--  "meters" over "metres" because the printed passport spells it that
--  way on every line, and the parent reading the app has the book open
--  beside it. The book is the one we cannot reissue.
--
--  NOTHING IS DELETED. Renaming a task keeps its id, so every tick a
--  coach has ever made still points at it. The two new lines start
--  unticked for everyone, which is honest: nobody has been assessed on
--  them yet. A swimmer who already holds the Water Movement certificate
--  keeps it -- the award lives on the milestone, not on the tick count
--  -- and simply reads 9 of 10 until someone sees them climb out of the
--  pool unaided.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
-- Run out of order this file would install perfectly and quietly rename
-- nothing, because the stages it looks for would not be there yet. The
-- confirm block at the foot would report an empty ladder and that is
-- easy to read as "no change needed". So: refuse here instead, where
-- the SQL editor still shows it.
--
-- The column checks come FIRST, before anything that reads `label`.
-- The other order looks more natural -- ask about the syllabus, then
-- about its stages -- and it is wrong: on a database that has only the
-- base grading module, `label` is not a column yet, so the stage check
-- fails with "column label does not exist" from somewhere inside a DO
-- block. That is a refusal, but it is the kind that sends somebody
-- looking for a typo in this file instead of running the file before
-- it. A guard is only as good as the sentence it prints.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'grading_milestones'
                    and column_name = 'formal_name') then
    raise exception 'grading_milestones.formal_name does not exist. Run supabase_grading_friendly_names.sql first, then this file again.';
  end if;
end $$;


-- ─── Which programme is the passport ────────────────────────────────────
-- FOUND BY ITS STAGES, NOT BY ITS NAME. The name is a text box with a
-- Rename button beside it, and the office used it: "Swim Passport"
-- became "Star Swim Passport" the same afternoon this file first ran. A
-- file that matches on the name would then have refused with "no
-- grading program called Swim Passport" and told the reader to run the
-- seed file -- which, on a renamed programme, would have built a second
-- one beside the first.
--
-- A stage labelled A and a stage labelled 6 on the same programme is
-- the passport and nothing else: MAS BADGES is numbered 1-7 with no
-- letters, and Swim Starters was folded into the passport by the bands
-- migration and has no stages left at all.
--
-- A temporary table because this has to be readable from the eleven
-- statements below it, and it disappears when the session ends -- so
-- nothing is left behind in the database afterwards.
drop table if exists _passport;
create temporary table _passport as
  select p.id
    from grading_programs p
   where exists (select 1 from grading_milestones m
                  where m.program_id = p.id and m.label = 'A')
     and exists (select 1 from grading_milestones m
                  where m.program_id = p.id and m.label = '6')
   order by p.sort_order, p.name
   limit 1;

do $$
begin
  if not exists (select 1 from _passport) then
    raise exception 'No syllabus here has stages labelled A through 6, so there is no passport to correct. Run supabase_swim_passport_syllabus.sql and supabase_grading_bands.sql first, then this file again.';
  end if;
  raise notice 'Correcting "%"',
    (select name from grading_programs where id = (select id from _passport));
end $$;


-- ─── Two stages gain a line each ────────────────────────────────────────
-- Stage B gains "Wall grab, unassisted" at 7 and Level 2 gains "Water
-- exit independently" at 6, both in the position the printed list puts
-- them, so the lines below each one move down.
--
-- The shift runs DESCENDING. grading_tasks has no unique index on
-- (milestone_id, sort_order) today, so an ascending shift would not
-- error -- it would silently leave two tasks sharing a number and the
-- list would order itself by name inside the collision. Descending is
-- correct whether or not the index exists, so it does not matter which
-- is true next year.
--
-- Each is wrapped in "only if the line is not already there", which is
-- what makes a second run a no-op rather than a second insert and a
-- second shift.
do $$
declare
  v_ms uuid;
  r    record;
  v    record;
begin
  for v in select * from (values ('B', 7, 'Wall grab, unassisted'),
                                 ('2', 6, 'Water exit independently'))
                       as t(label, at, name)
  loop
    select m.id into v_ms
      from grading_milestones m
      join grading_programs p on p.id = m.program_id
     where p.id = (select id from _passport) and m.label = v.label;

    continue when v_ms is null;
    continue when exists (select 1 from grading_tasks
                           where milestone_id = v_ms and name = v.name);

    for r in select id, sort_order from grading_tasks
              where milestone_id = v_ms and sort_order >= v.at
              order by sort_order desc
    loop
      update grading_tasks set sort_order = r.sort_order + 1 where id = r.id;
    end loop;

    insert into grading_tasks (milestone_id, name, sort_order)
    values (v_ms, v.name, v.at);
  end loop;
end $$;


-- ─── Entry before exit, on A and B ──────────────────────────────────────
-- The passport lists water ENTRY above water EXIT on both Swim Starters
-- stages. The seed had them the other way round.
--
-- This swaps the ROWS, not the words. Writing the new names over the old
-- positions would be one line shorter and quietly wrong: a child ticked
-- for getting out of the pool but not yet for getting in would come back
-- the next morning ticked for getting in and not out. The tick belongs
-- to the skill, so the skill moves and takes it with it.
--
-- Matched on "Water entry%" / "Water exit%" rather than the full name,
-- because this has to work on a database still carrying the seed's
-- "Water exit parent & child together" as well as one where an earlier
-- run of this file already renamed it. Re-running is safe: once entry
-- sits above exit the condition is false and nothing moves.
do $$
declare
  v_entry record;
  v_exit  record;
  v_label text;
begin
  foreach v_label in array array['A', 'B'] loop
    select t.id, t.sort_order into v_entry
      from grading_tasks t
      join grading_milestones m on m.id = t.milestone_id
      join grading_programs p on p.id = m.program_id
     where p.id = (select id from _passport) and m.label = v_label
       and t.name like 'Water entry%';

    select t.id, t.sort_order into v_exit
      from grading_tasks t
      join grading_milestones m on m.id = t.milestone_id
      join grading_programs p on p.id = m.program_id
     where p.id = (select id from _passport) and m.label = v_label
       and t.name like 'Water exit%';

    continue when v_entry.id is null or v_exit.id is null;
    continue when v_entry.sort_order < v_exit.sort_order;

    update grading_tasks set sort_order = v_exit.sort_order  where id = v_entry.id;
    update grading_tasks set sort_order = v_entry.sort_order where id = v_exit.id;
  end loop;
end $$;


-- ─── Every line, as the passport prints it ──────────────────────────────
-- Set by (stage label, position), not by matching the old text. Matching
-- old text means a file that silently does nothing the day someone has
-- already corrected one line by hand in the admin screen; setting by
-- position says what the answer is and gets there from wherever the row
-- started. The count of rows actually changed is reported below, so a
-- run that moves nothing is visible rather than reassuring.
update grading_tasks t
   set name = v.name
  from (values
    -- A · Water Discovery
    ('A', 1, 'Blow bubbles on surface, assisted'),
    ('A', 2, 'Front tow chin in water, assisted'),
    ('A', 3, 'Front float chin in water, assisted'),
    ('A', 4, 'Back float assisted, head on shoulder'),
    ('A', 5, 'Back tow assisted, head on shoulder'),
    ('A', 6, 'Roll assisted, back to front & front to back'),
    ('A', 7, 'Wall grab, assisted'),
    ('A', 8, 'Water entry assisted'),
    ('A', 9, 'Water exit assisted'),
    -- B · Water Explorer
    -- B is where a child stops being held. The print spells the word
    -- "uassisted" on two of these lines; it is spelled properly here.
    -- Copying a typo into the database to match the book would put it
    -- on every phone and make it harder to fix, not easier -- and the
    -- artwork is the thing that can still be reprinted.
    ('B', 1, 'Blow bubbles mouth & nose submerged, assisted'),
    ('B', 2, 'Front tow blow bubbles, assisted'),
    ('B', 3, 'Front float blow bubbles, assisted'),
    ('B', 4, 'Back float assisted, head on chest'),
    ('B', 5, 'Back tow assisted, head on chest'),
    ('B', 6, 'Roll unassisted, back to front & front to back'),
    ('B', 7, 'Wall grab, unassisted'),
    ('B', 8, 'Monkey crawl unassisted, on edge, 2 meters'),
    ('B', 9, 'Water entry, unassisted'),
    ('B',10, 'Water exit, unassisted'),
    -- 1 · Starfish · Water Acclimation
    ('1', 1, 'Submerge, bob independently'),
    ('1', 2, 'Front glide assisted, to wall, 2 meters'),
    ('1', 3, 'Front float assisted, 10 secs., recover independently'),
    ('1', 4, 'Back float assisted, 10 secs., recover independently'),
    ('1', 5, 'Back glide assisted, at wall, 2 meters'),
    ('1', 6, 'Water exit independently'),
    ('1', 7, 'Roll assisted, back to front & front to back'),
    ('1', 8, 'Jump, push, turn, grab assisted'),
    ('1', 9, 'Swim, float, swim assisted, 5 meters'),
    -- 2 · Crab · Water Movement
    ('2', 1, 'Submerge look at object on bottom'),
    ('2', 2, 'Front glide 5 meters'),
    ('2', 3, 'Front float 20 secs.'),
    ('2', 4, 'Back float 20 secs.'),
    ('2', 5, 'Back glide 5 meters'),
    ('2', 6, 'Water exit independently'),
    ('2', 7, 'Roll back to front & front to back'),
    ('2', 8, 'Tread water 10 secs., near wall, & exit'),
    ('2', 9, 'Jump, push, turn, grab'),
    ('2',10, 'Swim, float, swim 5 meters'),
    -- 3 · Octopus · Water Stamina
    ('3', 1, 'Submerge retrieve object in chest-deep water'),
    ('3', 2, 'Swim on front 15 meters'),
    ('3', 3, 'Swim on back 15 meters'),
    ('3', 4, 'Water exit independently'),
    ('3', 5, 'Roll back to front & front to back'),
    ('3', 6, 'Tread water 1 min. & exit'),
    ('3', 7, 'Jump, swim, turn, swim, grab 10 meters'),
    ('3', 8, 'Swim, float, swim 25 meters'),
    -- 4 · Turtle · Stroke Introduction
    ('4', 1, 'Front crawl rotary breathing, 15 meters'),
    ('4', 2, 'Breaststroke kick, 15 meters'),
    ('4', 3, 'Butterfly kick, 15 meters'),
    ('4', 4, 'Back crawl swim 15 meters'),
    ('4', 5, 'Dive sitting'),
    ('4', 6, 'Resting stroke elementary backstroke, 15 meters'),
    ('4', 7, 'Tread water with scissor & whip kick, 1 min.'),
    ('4', 8, 'Endurance: any stroke or combination of strokes, 25 meters'),
    -- 5 · Whale · Stroke Development
    ('5', 1, 'Front crawl bent-arm recovery, 25 meters'),
    ('5', 2, 'Breaststroke 25 meters'),
    ('5', 3, 'Butterfly simultaneous arm action & kick, 15 meters'),
    ('5', 4, 'Back crawl pull, 25 meters'),
    ('5', 5, 'Dive kneeling'),
    ('5', 6, 'Resting stroke sidestroke, 25 meters'),
    ('5', 7, 'Tread water scissor & whip kick, 2 mins.'),
    ('5', 8, 'Endurance: any stroke or combination of strokes, 50 meters'),
    -- 6 · Ray · Stroke Mechanics
    ('6', 1, 'Front crawl flip turn, 2 x 25 meters'),
    ('6', 2, 'Breaststroke open turn, 2 x 25 meters'),
    ('6', 3, 'Butterfly 25 meters'),
    ('6', 4, 'Back crawl pull & flip turn, 2 x 25 meters'),
    ('6', 5, 'Dive standing'),
    ('6', 6, 'Resting stroke elementary backstroke or sidestroke, 50 meters'),
    ('6', 7, 'Tread water retrieve object off bottom, tread 1 min.'),
    ('6', 8, 'Endurance: any stroke or combination of strokes, 150 meters')
  ) as v(label, sort_order, name)
  join grading_milestones m on m.label = v.label
  join grading_programs  p on p.id = m.program_id and p.id = (select id from _passport)
 where t.milestone_id = m.id
   and t.sort_order  = v.sort_order
   and t.name       is distinct from v.name;


notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
-- One statement. The Supabase editor shows the result of the last
-- statement only, so a confirm block that is three selects reports one
-- of them and the other two simply are not there.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'stages and how many lines each' as thing,
         coalesce((select string_agg(x.label || ':' || x.n, '  ' order by x.level_no)
                     from (select m.label, m.level_no,
                                  (select count(*) from grading_tasks t
                                    where t.milestone_id = m.id and t.is_active)::text as n
                             from grading_milestones m
                             join grading_programs p on p.id = m.program_id
                            where p.id = (select id from _passport) and m.is_active) x),
                  'NOTHING FOUND') as detail
  union all
  select 2, 'should read',
         'A:9  B:10  1:9  2:10  3:8  4:8  5:8  6:8 — B and Level 2 are the tens'
  union all
  select 3, 'Stage B, in order',
         coalesce((select string_agg(t.name, ' · ' order by t.sort_order)
                     from grading_tasks t
                     join grading_milestones m on m.id = t.milestone_id
                     join grading_programs p on p.id = m.program_id
                    where p.id = (select id from _passport) and m.label = 'B' and t.is_active),
                  'NOTHING FOUND')
  union all
  select 4, 'Level 2, in order',
         coalesce((select string_agg(t.name, ' · ' order by t.sort_order)
                     from grading_tasks t
                     join grading_milestones m on m.id = t.milestone_id
                     join grading_programs p on p.id = m.program_id
                    where p.id = (select id from _passport) and m.label = '2' and t.is_active),
                  'NOTHING FOUND')
  union all
  select 5, 'anything still spelled "metres"',
         coalesce((select string_agg(m.label || ' · ' || t.name, ' | ' order by m.label, t.sort_order)
                     from grading_tasks t
                     join grading_milestones m on m.id = t.milestone_id
                     join grading_programs p on p.id = m.program_id
                    where p.id = (select id from _passport) and t.name like '%metres%'),
                  'none — the app and the book spell it the same way')
  union all
  select 6, 'anything still saying "Backstroke" as a stroke name',
         coalesce((select string_agg(m.label || ' · ' || t.name, ' | ' order by m.label, t.sort_order)
                     from grading_tasks t
                     join grading_milestones m on m.id = t.milestone_id
                     join grading_programs p on p.id = m.program_id
                    where p.id = (select id from _passport)
                      and t.name ~ '^Backstroke'),
                  'none — it is Back crawl throughout, as the chart has it')
  union all
  select 7, 'ticks carried through the rename',
         (select count(*)::text from student_task_marks k
            join grading_tasks t on t.id = k.task_id
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.id = (select id from _passport) and k.removed_at is null)
      || ' live tick(s). A rename keeps the id, so none of them moved.'
  union all
  select 8, 'next',
         'Nothing to deploy. The apps read these names from the database, '
      || 'so a coach opening the pad after this run sees the printed wording.'
  ) z
 order by z.k;
