-- ════════════════════════════════════════════════════════════════════════
--  The syllabus: programmes, milestones, tasks, and what a child has done
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  IT CREATES TABLES, SO supabase_rls_guard.sql IS THE SECOND HALF OF
--  THIS JOB. Every table below is locked here, but run the guard after
--  this and read its last query. The anon key is printed in every page
--  we serve.
--
--  WHY
--  A coach's progress note is prose, written once, and it goes with the
--  coach. Nobody can recap a year of them, and a parent reading the
--  third one cannot tell whether their child is getting anywhere. The
--  syllabus is the other half: the same ladder for every child, ticked
--  rather than written, and readable at a glance by the three people who
--  need it -- the coach at the poolside, the office, and the parent.
--
--  THE SHAPE
--    programme   Water Discovery, Swim Passport, Advanced. A lesson type
--                is graded on exactly one; several lesson types may share
--                one.
--    milestone   A level within a programme. Guppy, Tortoise, Crab. Has
--                a level number, because "Guppy" means nothing to a
--                parent until they know it is level 1 of 7.
--    task        One thing a child can be seen to do. "Submerge and hold
--                breath for 10 seconds."
--    mark        A coach saw a child do a task, on a day, and is named
--                against it.
--
--  MILESTONES ARE NOT A QUEUE
--  A child can be ticked for a task in level 4 while level 3 is still
--  half done -- children do not learn in the order a syllabus is written.
--  A milestone is ACTIVATED when every one of its tasks has a live mark,
--  whenever that happens and in whatever order.
--
--  THE BADGE IS THE HIGHEST ACTIVATED MILESTONE, AND NOTHING ELSE
--  Not the highest touched. One tick on an easy task from level 6 would
--  otherwise promote a child who cannot swim a width, and a badge that
--  can be inflated by one tap is not worth collecting.
--
--  NOTHING IS DELETED
--  A tick removed in error keeps its row, with who removed it and when.
--  A milestone that stops being complete keeps its row too, revoked
--  rather than erased -- and if it is completed again later, the
--  original achievement date is what stands.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The programmes ──────────────────────────────────────────────────
create table if not exists grading_programs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  subtitle    text,
  description text,
  icon_path   text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table grading_programs is
  'A ladder a child is graded on. A lesson type points at exactly one; '
  'several lesson types may share one.';


-- ─── 2. The milestones within one ───────────────────────────────────────
create table if not exists grading_milestones (
  id           uuid primary key default gen_random_uuid(),
  program_id   uuid not null references grading_programs(id) on delete restrict,
  -- The number a parent reads. "Guppy" means nothing until it is level 1
  -- of 7, which is also what makes a progress bar possible.
  level_no     integer not null,
  name         text not null,
  description  text,
  icon_path    text,
  -- Some levels end in something to take home.
  certificate  boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint grading_milestones_level_unique unique (program_id, level_no)
);

create index if not exists grading_milestones_program_idx
  on grading_milestones (program_id, level_no);

-- on delete restrict, deliberately. A milestone that children hold is
-- not a row anybody should be able to remove: the achievements would
-- point at nothing. Switch is_active off instead -- it disappears from
-- the ladder and the children who earned it keep it.


-- ─── 3. The tasks within one milestone ──────────────────────────────────
create table if not exists grading_tasks (
  id           uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references grading_milestones(id) on delete restrict,
  name         text not null,
  description  text,
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists grading_tasks_milestone_idx
  on grading_tasks (milestone_id, sort_order);


-- ─── 4. What a child has been seen to do ────────────────────────────────
create table if not exists student_task_marks (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references students(id) on delete cascade,
  task_id        uuid not null references grading_tasks(id) on delete restrict,
  marked_at      timestamptz not null default now(),
  marked_by      uuid,
  -- The name as it was that day. A coach who leaves is still the coach
  -- who saw it, and an id alone stops meaning anything once they are
  -- archived.
  marked_by_name text,
  session_id     uuid,
  -- Void, never delete. A tick removed in error is a thing that
  -- happened, and the row says who removed it.
  removed_at     timestamptz,
  removed_by     uuid,
  removed_by_name text,
  note           text
);

-- One LIVE mark per child per task. A second tick is not an achievement
-- twice; it is two coaches ticking the same box on the same afternoon.
create unique index if not exists student_task_marks_live_unique
  on student_task_marks (student_id, task_id) where removed_at is null;

create index if not exists student_task_marks_student_idx
  on student_task_marks (student_id) where removed_at is null;


-- ─── 5. The milestones a child holds ────────────────────────────────────
-- Derived from the marks, kept as rows so an achievement has a date, an
-- order, and somewhere to record a certificate being handed over.
create table if not exists student_milestones (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete cascade,
  milestone_id  uuid not null references grading_milestones(id) on delete restrict,
  -- When it was FIRST completed. A milestone un-ticked and completed
  -- again keeps this date: the child did it, and the record of when is
  -- not the office's to move.
  achieved_at   timestamptz not null default now(),
  -- Set when it stops being complete. Not deleted, so "this was awarded
  -- and then withdrawn" is answerable.
  revoked_at    timestamptz,
  certificate_claimed_at timestamptz,
  certificate_claimed_by text,
  constraint student_milestones_unique unique (student_id, milestone_id)
);

create index if not exists student_milestones_student_idx
  on student_milestones (student_id) where revoked_at is null;

comment on table student_milestones is
  'A milestone a child has completed. Maintained by trigger from '
  'student_task_marks -- never written by hand except to record a '
  'certificate being claimed.';


-- ─── 6. Which programme a lesson type is graded on ──────────────────────
alter table scheduler_lesson_types
  add column if not exists grading_program_id uuid references grading_programs(id);

comment on column scheduler_lesson_types.grading_program_id is
  'The ladder children in this lesson type are graded on. Null means '
  'ungraded, which is correct for a one-off or a hire.';


-- ─── 7. Activating a milestone, and withdrawing one ─────────────────────
-- The rule in one place: every ACTIVE task of the milestone has a LIVE
-- mark for this child. Run after every tick and every untick, for the
-- one milestone the task belongs to.
create or replace function grading_recompute(p_student uuid, p_milestone uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_total integer; v_done integer;
begin
  select count(*) into v_total
    from grading_tasks t
   where t.milestone_id = p_milestone and t.is_active;

  select count(*) into v_done
    from grading_tasks t
    join student_task_marks m
      on m.task_id = t.id and m.student_id = p_student and m.removed_at is null
   where t.milestone_id = p_milestone and t.is_active;

  -- A milestone with no tasks is not an achievement waiting to happen.
  -- It is a milestone somebody has not finished writing, and awarding it
  -- to every child in the programme would be the loudest possible way to
  -- find that out.
  if v_total = 0 then
    update student_milestones set revoked_at = coalesce(revoked_at, now())
     where student_id = p_student and milestone_id = p_milestone and revoked_at is null;
    return;
  end if;

  if v_done >= v_total then
    insert into student_milestones (student_id, milestone_id)
    values (p_student, p_milestone)
    on conflict (student_id, milestone_id) do update
      -- Completed again after being withdrawn: the original date stands.
      set revoked_at = null;
  else
    update student_milestones set revoked_at = now()
     where student_id = p_student and milestone_id = p_milestone and revoked_at is null;
  end if;
end $$;

create or replace function grading_marks_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ms uuid; v_stu uuid;
begin
  select t.milestone_id into v_ms from grading_tasks t
   where t.id = coalesce(new.task_id, old.task_id);
  v_stu := coalesce(new.student_id, old.student_id);
  if v_ms is not null and v_stu is not null then
    perform grading_recompute(v_stu, v_ms);
  end if;
  return null;
end $$;

drop trigger if exists student_task_marks_recompute on student_task_marks;
create trigger student_task_marks_recompute
  after insert or update or delete on student_task_marks
  for each row execute function grading_marks_changed();

-- Changing the syllabus changes who has finished what. Adding a task to
-- a milestone children already hold must withdraw it until they do the
-- new thing, or the ladder means whatever it meant on the day each child
-- climbed it.
create or replace function grading_tasks_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ms uuid; r record;
begin
  v_ms := coalesce(new.milestone_id, old.milestone_id);
  for r in select distinct sm.student_id from student_milestones sm where sm.milestone_id = v_ms
  loop perform grading_recompute(r.student_id, v_ms); end loop;
  -- And children part-way up it, who may now be finished.
  for r in
    select distinct m.student_id
      from student_task_marks m
      join grading_tasks t on t.id = m.task_id
     where t.milestone_id = v_ms and m.removed_at is null
  loop perform grading_recompute(r.student_id, v_ms); end loop;
  return null;
end $$;

drop trigger if exists grading_tasks_recompute on grading_tasks;
create trigger grading_tasks_recompute
  after insert or update or delete on grading_tasks
  for each row execute function grading_tasks_changed();


-- ─── 8. Locked ──────────────────────────────────────────────────────────
-- The syllabus itself is readable by any signed-in seat and the parent
-- app: a programme and its tasks are not secret, and the parent app has
-- to draw the ladder a child is climbing. Writing it is the office's.
do $$
declare t text;
begin
  foreach t in array array['grading_programs','grading_milestones','grading_tasks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format($p$create policy %I on %I for all to authenticated
                     using (can_write_office()) with check (can_write_office())$p$,
                   t || '_write', t);
  end loop;
end $$;

-- A child's marks and milestones are that child's. A coach sees them
-- through the attendance app, which runs as a crew member; a parent sees
-- their own through my_* functions that are security definer; the office
-- sees all of them.
alter table student_task_marks enable row level security;
revoke all on student_task_marks from anon;
grant select, insert, update on student_task_marks to authenticated;
drop policy if exists student_task_marks_office on student_task_marks;
create policy student_task_marks_office on student_task_marks for all to authenticated
  using (is_website_login() or attendance_my_crew_id() is not null)
  with check (can_write_office() or attendance_my_crew_id() is not null);
revoke delete on student_task_marks from authenticated;

alter table student_milestones enable row level security;
revoke all on student_milestones from anon;
grant select, update on student_milestones to authenticated;
drop policy if exists student_milestones_office on student_milestones;
create policy student_milestones_office on student_milestones for all to authenticated
  using (is_website_login() or attendance_my_crew_id() is not null)
  with check (can_write_office() or attendance_my_crew_id() is not null);
revoke delete, insert on student_milestones from authenticated;


-- ─── 9. Badge art ───────────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No storage schema here — skipping the bucket (expected outside Supabase).';
    return;
  end if;

  -- Public, unlike every other bucket in this project, and on purpose: a
  -- badge is drawn in the parent app, the coach's app and a printed
  -- certificate. It is artwork, not a record about a child, and signing
  -- a URL for it would mean a round trip per badge on every screen that
  -- shows one.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('grading-icons', 'grading-icons', true, 2097152,
          array['image/png','image/jpeg','image/webp','image/svg+xml'])
  on conflict (id) do update
    set public = true,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute $p$ drop policy if exists grading_icons_office_write on storage.objects $p$;
  execute $p$
    create policy grading_icons_office_write on storage.objects for insert to authenticated
    with check (bucket_id = 'grading-icons' and can_write_office()) $p$;

  execute $p$ drop policy if exists grading_icons_office_update on storage.objects $p$;
  execute $p$
    create policy grading_icons_office_update on storage.objects for update to authenticated
    using (bucket_id = 'grading-icons' and can_write_office()) $p$;

  raise notice 'grading-icons bucket ready (public, 2 MB, images).';
end $$;


-- ─── 10. A seed, so the screens have something to draw ──────────────────
-- Three programmes with a level or two each, as a shape to edit rather
-- than a syllabus to adopt. Inserted only where the programme does not
-- already exist, so re-running this file never touches what you have
-- written.
do $$
declare v_prog uuid; v_ms uuid;
begin
  if exists (select 1 from grading_programs) then
    raise notice 'Programmes already exist — leaving the syllabus alone.';
    return;
  end if;

  -- Water Discovery
  insert into grading_programs (name, subtitle, description, sort_order)
  values ('Water Discovery', 'Toddlers',
          'First time in the water, with a parent. Confidence before technique.', 1)
  returning id into v_prog;

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 1, 'Droplet', 'Happy in the water and willing to get a face wet.', false)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Enters the water without distress', 1),
    (v_ms, 'Splashes and plays at the wall', 2),
    (v_ms, 'Allows water over the shoulders', 3),
    (v_ms, 'Wets own face with cupped hands', 4);

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 2, 'Ripple', 'Moving through the water, still supported.', true)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Blows bubbles at the surface', 1),
    (v_ms, 'Kicks while held, for five metres', 2),
    (v_ms, 'Submerges face for two seconds', 3),
    (v_ms, 'Holds the wall and kicks unaided', 4);

  -- Swim Passport
  insert into grading_programs (name, subtitle, description, sort_order)
  values ('Swim Passport', 'Learn to Swim',
          'The main ladder. Water safety, then the four strokes.', 2)
  returning id into v_prog;

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 1, 'Guppy', 'Safe and unafraid in shallow water.', false)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Submerges whole head', 1),
    (v_ms, 'Submerges and blows bubbles', 2),
    (v_ms, 'Holds breath under water for 10 seconds', 3),
    (v_ms, 'Floats on front with support', 4),
    (v_ms, 'Floats on back with support', 5),
    (v_ms, 'Enters feet first from the side', 6);

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 2, 'Tortoise', 'Moving unaided across the pool.', false)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Glides from the wall, face in', 1),
    (v_ms, 'Kicks 10 metres on a float', 2),
    (v_ms, 'Floats on back unaided for 10 seconds', 3),
    (v_ms, 'Rolls front to back unaided', 4),
    (v_ms, 'Jumps in and returns to the wall', 5);

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 3, 'Crab', 'The first recognisable stroke.', true)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Front crawl 10 metres with breathing', 1),
    (v_ms, 'Backstroke 10 metres', 2),
    (v_ms, 'Treads water for 30 seconds', 3),
    (v_ms, 'Retrieves an object from chest depth', 4),
    (v_ms, 'Swims 25 metres, any stroke', 5);

  -- Advanced
  insert into grading_programs (name, subtitle, description, sort_order)
  values ('Advanced Program', 'Squad and stroke correction',
          'For swimmers who have the strokes and are refining them.', 3)
  returning id into v_prog;

  insert into grading_milestones (program_id, level_no, name, description, certificate)
  values (v_prog, 1, 'Marlin', 'All four strokes, legal and sustained.', true)
  returning id into v_ms;
  insert into grading_tasks (milestone_id, name, sort_order) values
    (v_ms, 'Front crawl 50 metres, bilateral breathing', 1),
    (v_ms, 'Backstroke 50 metres', 2),
    (v_ms, 'Breaststroke 25 metres, legal kick', 3),
    (v_ms, 'Butterfly 15 metres', 4),
    (v_ms, 'Tumble turn, front crawl', 5),
    (v_ms, 'Dive entry from the blocks', 6);

  raise notice 'Seeded three programmes. Edit them in Admin → Grading.';
end $$;


-- ─── 10b. Reading a child's ladder ──────────────────────────────────────
-- One shape, drawn by three different screens: the coach's student list,
-- the office's progress page and the parent's app. Written once so they
-- cannot disagree about what a child has done.
--
-- Every milestone carries `done` and `total`, because the bar under each
-- one is tasks-completed over tasks-in-that-milestone and nothing else.
-- A bar computed in the client from a list it filtered itself is a bar
-- that reads differently in three places the first time somebody
-- filters slightly differently.
--
-- Tasks come back completed-first, then the rest, which is the order
-- they are drawn in: what the child can do, then what is next.
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
                                  'subtitle', p.subtitle, 'icon', p.icon_path),
    -- The badge: highest ACTIVATED level, and nothing else.
    'level', v_high,
    'levels_total', v_levels,
    'milestones', coalesce((
      select jsonb_agg(ms order by (ms->>'level_no')::int)
        from (
          select jsonb_build_object(
            'id', m.id, 'level_no', m.level_no, 'name', m.name,
            'description', m.description, 'icon', m.icon_path,
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
  'One child''s ladder: the programme, every milestone with done/total '
  'for its bar, and every task marked or not. The one shape the coach '
  'app, the office and the parent app all draw.';

revoke all on function student_grading(uuid) from public, anon;
grant execute on function student_grading(uuid) to authenticated, service_role;


-- A parent may ask only about their own children. Separate from the
-- function above rather than a flag on it: a check that can be passed an
-- argument is a check somebody passes the wrong argument to.
create or replace function my_child_grading(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_acct uuid;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  if not exists (select 1 from students s
                  where s.id = p_student and s.account_id = v_acct
                    and s.is_active is not false) then
    return jsonb_build_object('ok', false, 'error', 'Not one of yours.');
  end if;
  return student_grading(p_student);
end $$;

revoke all on function my_child_grading(uuid) from public, anon;
grant execute on function my_child_grading(uuid) to authenticated;


-- ─── 11. What is now in place ───────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'programmes' as thing,
         (select string_agg(name || ' (' || (select count(*) from grading_milestones m
                                              where m.program_id = p.id)::text || ' levels)',
                            ' · ' order by sort_order)
            from grading_programs p) as detail
  union all
  select 2, 'tasks in all of them', (select count(*)::text from grading_tasks)
  union all
  select 3, 'lesson types graded',
         (select count(*)::text from scheduler_lesson_types where grading_program_id is not null)
      || ' of ' || (select count(*)::text from scheduler_lesson_types)
      || ' — set each one in Admin → Settings → Lesson types'
  union all
  select 4, 'the badge rule',
         'Highest ACTIVATED milestone only. A milestone activates when '
      || 'every one of its tasks has a live mark, in any order — so one '
      || 'tick on a high level promotes nobody.'
  union all
  select 5, 'marks so far', (select count(*)::text from student_task_marks where removed_at is null)
      || ' live, ' || (select count(*)::text from student_task_marks where removed_at is not null)
      || ' removed and kept'
  union all
  select 6, 'next, in this order',
         '1. Run supabase_rls_guard.sql — this file created five tables. '
      || '2. Set a grading programme on each lesson type. '
      || '3. Edit the seeded syllabus in Admin → Grading; it is a shape '
      || 'to change, not one to adopt.'
  ) z
 order by z.k;
