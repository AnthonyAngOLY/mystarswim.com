-- ════════════════════════════════════════════════════════════════════════
--  Splitting the Swim Passport: Swim Starters, then Swim Passport
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_swim_passport_syllabus.sql FIRST. This takes the eight
--  stages it installed and splits them in two.
--
--  WHY
--  One ladder of eight read as one journey, and it is two. Stages A and
--  B are the toddler lessons -- a parent in the water, roughly 2½ to 5
--  -- and the passport's own cover calls them SWIM STARTERS. Stages 1 to
--  6 are Learn to Swim, done by the child alone.
--
--  Together they told a toddler's parent their two-year-old was "1 of
--  8" and had six more levels to climb. That is not what they bought,
--  and it reads as a very long way to go. Split, the same child is
--  "1 of 2" on a ladder that ends where their lessons end.
--
--  THE PRINTED PASSPORT DOES NOT CHANGE. It is one book with both
--  halves in it, and that is the point of it -- something to hold. The
--  split is in how we grade, not in what we hand over. Both programmes
--  therefore credit the same syllabus, so the app prints
--  "Star Swim · Swim Passport v1.0" under each of them and a parent can
--  see they are two parts of one thing.
--
--  NOTHING A COACH TICKED IS LOST. Ticks hang off tasks, tasks hang off
--  milestones, and the milestones themselves move -- ids intact. A
--  child who finished stage A before this file ran still holds stage A
--  after it.
--
--  AND THE EARLIER HALF STAYS VISIBLE. A good four-year-old moves from
--  Starters to Passport mid-year, and without this their Water
--  Discovery and Water Explorer badges would simply vanish from the
--  app -- the ladder on screen is the one their lesson type points at.
--  student_grading() now also returns `also_earned`: what this child
--  holds on every OTHER programme. The parent app draws it as a quiet
--  row beneath the current ladder.
--
--  WHAT YOU MUST DO AFTERWARDS
--  Point the toddler lesson types at Swim Starters, in
--  Settings → Lesson Types → "Graded on". Until then they are still
--  graded on the six-stage Passport, which is the thing this file
--  exists to stop. The confirm block at the bottom says which is which.
-- ════════════════════════════════════════════════════════════════════════

do $$
declare
  v_pass  uuid;
  v_start uuid;
  v_moved integer;
  v_n     integer;
begin
  select id into v_pass from grading_programs where name = 'Swim Passport';
  if v_pass is null then
    raise exception 'Swim Passport does not exist. Run '
      'supabase_swim_passport_syllabus.sql first.';
  end if;

  -- ── The toddler half ─────────────────────────────────────────────────
  select id into v_start from grading_programs where name = 'Swim Starters';
  if v_start is null then
    insert into grading_programs (name, subtitle, sort_order, colour)
    values ('Swim Starters', 'Toddlers · with a parent', 2, '#2CBDBE')
    returning id into v_start;
    raise notice 'Created the Swim Starters programme.';
  end if;

  update grading_programs
     set subtitle         = 'Toddlers · with a parent',
         description      = 'Stages A and B of the Swim Passport, done with a parent '
                         || 'in the water. Roughly 2½ to 5 years old. A child who is '
                         || 'ready moves on to the Swim Passport itself, often at 4 — '
                         || 'these two stages are where that readiness is built, not a '
                         || 'shorter version of the same ladder.',
         colour           = coalesce(colour, '#2CBDBE'),
         icon_path        = coalesce(icon_path, '/badges/ss-a-water-discovery.png'),
         -- The same book. Both halves credit it, so the line the apps
         -- print under each programme is the same line.
         syllabus_body    = 'Star Swim',
         syllabus_name    = 'Swim Passport',
         syllabus_version = '1.0',
         syllabus_note    = 'Stages A and B of the Star Swim Swim Passport — the same '
                         || 'printed passport the Learn to Swim stages are in. Done '
                         || 'with a parent in the water. The stage names and the Swim '
                         || 'Starters grouping follow the YMCA of the USA swim lesson '
                         || 'framework. A stage lights up here when a Star Swim coach '
                         || 'has ticked every skill on it.'
   where id = v_start;

  -- ── The badge says Water Explorer, so the level does too ─────────────
  -- The sticker reads "Water Explorer". It was loaded as "Water
  -- Exploration", which is what the cover's summary panel calls it --
  -- and a parent holding the sticker is reading the sticker.
  update grading_milestones
     set name      = 'Water Explorer',
         icon_path = '/badges/ss-b-water-explorer.png'
   where label = 'B'
     and program_id in (v_pass, v_start)
     and name in ('Water Exploration', 'Water Explorer');

  -- ── Already split? ───────────────────────────────────────────────────
  if exists (select 1 from grading_milestones
              where program_id = v_start and label = 'B') then
    raise notice 'Already split: stages A and B are on Swim Starters. Nothing moved.';
    return;
  end if;

  -- ── Move A and B across ──────────────────────────────────────────────
  -- The milestone ids do not change, so every tick, every earned stage
  -- and every certificate already recorded against them comes too.
  update grading_milestones
     set program_id = v_start,
         level_no   = case label when 'A' then 1 else 2 end
   where program_id = v_pass and label in ('A', 'B');
  get diagnostics v_moved = row_count;
  raise notice 'Moved % stage(s) to Swim Starters.', v_moved;

  -- ── Close the gap the move left ──────────────────────────────────────
  -- 3→1, 4→2 … 8→6, in ascending order: each target is already free by
  -- the time it is wanted, so the (program_id, level_no) unique index is
  -- never momentarily violated. Descending order would collide on the
  -- very first row.
  for v_n in 3 .. 8 loop
    update grading_milestones
       set level_no = v_n - 2
     where program_id = v_pass and level_no = v_n;
  end loop;

  update grading_programs
     set subtitle    = 'Learn to Swim',
         sort_order  = 3,
         description = 'Stages 1 to 6 of the Swim Passport, performed by the child '
                    || 'alone: from a first independent submersion to all four '
                    || 'strokes with turns. Children arriving from Swim Starters '
                    || 'often begin here at 4. Progression is competency-based, not '
                    || 'age-based.'
   where id = v_pass;

  raise notice 'Split complete: Swim Starters A–B, Swim Passport 1–6.';
end $$;


-- ─── student_grading(), now carrying what was earned elsewhere ──────────
-- Re-created whole, as every change to this function is. The only
-- difference from supabase_grading_stage_labels.sql is `also_earned`.
--
-- Without it the split quietly costs a child their history: the app
-- draws the ladder their lesson type points at, so the morning a
-- four-year-old moves up to the Passport, Water Discovery and Water
-- Explorer disappear from their parent's phone. The badges were never
-- lost -- they were simply not asked for.
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
    -- Everything this child holds on any OTHER programme, oldest first.
    -- Empty for almost every child; the whole point for the one who
    -- moved up from Swim Starters this term.
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
  'milestone with its badge label and done/total for its bar, every task '
  'marked or not, and what they earned on any other programme before '
  'this one. The one shape the coach app, the office and the parent app '
  'all draw.';

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';


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
  select 2, 'Swim Starters',
         coalesce((select string_agg(m.label || ' ' || m.name, ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Starters'), 'NOT SPLIT')
  union all
  select 3, 'Swim Passport',
         coalesce((select string_agg(m.label || ' ' || m.name, ' · ' order by m.level_no)
                     from grading_milestones m
                     join grading_programs p on p.id = m.program_id
                    where p.name = 'Swim Passport'), 'EMPTY')
  union all
  select 4, 'both credit the same book',
         (select string_agg(p.name || ' → ' || p.syllabus_body || ' ' || p.syllabus_name,
                            ' · ' order by p.sort_order)
            from grading_programs p
           where p.name in ('Swim Starters', 'Swim Passport'))
      || '. One printed passport, two ladders — which is what a parent is told.'
  union all
  select 5, 'nothing was lost in the move',
         (select count(*)::text from student_task_marks k
            join grading_tasks t on t.id = k.task_id
            join grading_milestones m on m.id = t.milestone_id
            join grading_programs p on p.id = m.program_id
           where p.name in ('Swim Starters', 'Swim Passport') and k.removed_at is null)
      || ' live tick(s) across both halves. The milestones moved with their ids, '
      || 'so every tick, earned stage and certificate came with them.'
  union all
  select 6, 'YOUR MOVE — toddler lesson types',
         coalesce((select string_agg(lt.name, ', ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id
                    where p.name = 'Swim Starters'),
                  'NONE point at Swim Starters yet. Settings → Lesson Types → '
               || '"Graded on": the toddler types belong on Swim Starters, the rest '
               || 'on Swim Passport. Until you do this the toddlers are still being '
               || 'shown a six-stage ladder.')
  union all
  select 7, 'and the rest',
         coalesce((select string_agg(lt.name, ', ' order by lt.name)
                     from scheduler_lesson_types lt
                     join grading_programs p on p.id = lt.grading_program_id
                    where p.name = 'Swim Passport'), 'NONE on Swim Passport')
  union all
  select 8, 'moving up mid-year',
         'A child who moves from Starters to Passport keeps their A and B badges on '
      || 'screen: student_grading() now returns `also_earned`, and the parent app '
      || 'draws it under the current ladder. Deploy the parent app or they vanish.'
  ) z
 order by z.k;
