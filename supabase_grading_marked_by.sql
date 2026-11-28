-- ════════════════════════════════════════════════════════════════════════
--  A tick says who made it
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_awards.sql FIRST (and the whole grading chain
--  before it). Nothing else depends on this file, and nothing has to be
--  deployed with it.
--
--  AND IF YOU EVER RE-RUN supabase_grading_coach.sql, run this file
--  after it: that file carries the older mark_grading_task and would
--  put the half-answer back.
--
--  WHY
--  Tick a skill from a coach's phone and the record says "Coach Sally".
--  Tick the same skill from the scheduler and it said "the office".
--
--  Both functions looked the signed-in person up ONE way: crew id ->
--  admin_employees.full_name. That is how an attendance login is
--  identified, and an office seat does not have one -- so every grading
--  made from a desk was attributed to nobody in particular. A parent
--  asking "who signed this off?" got an answer that named no one, and
--  so did the office asking the same thing of itself.
--
--  add_progress_note() already knew how to answer this properly, in
--  three steps. The two grading functions each knew the first step.
--  Rather than copy the other two steps into each of them -- a third and
--  fourth place for the same question to be answered differently -- the
--  whole resolution moves into one function that all three call.
--
--  WHAT DOES NOT CHANGE
--  Neither signature moves: mark_grading_task and claim_certificate take
--  exactly the arguments they took this morning, so a phone running last
--  month's build keeps working.
--
--  TICKS ALREADY MADE ARE LEFT ALONE. A row that says "the office" goes
--  on saying it. The name stored with a mark is what was true when the
--  mark was made, and rewriting history to be tidier is how a record
--  stops being one. Only new ticks carry the fuller name.
-- ════════════════════════════════════════════════════════════════════════


-- ─── Is what this file builds on actually here? ─────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'student_milestones'
                    and column_name = 'award_claimed_by') then
    raise exception 'student_milestones.award_claimed_by does not exist. Run supabase_grading_awards.sql first, then this file again.';
  end if;
end $$;


-- ─── Who is doing this, in one place ────────────────────────────────────
-- Three ways in, in the order that identifies a person most precisely:
--
--   1. a crew id -- somebody signed in to the attendance app, so their
--      employee record is the name on the roster;
--   2. an instructor with a website seat -- the same human as (1), but
--      signed in at a desk, so their scheduler name;
--   3. any other website seat -- the office, by the display name that
--      seat was given.
--
-- Falls back to 'Star Swim' rather than 'the office', matching what
-- add_progress_note() has always written. "The office" reads like a
-- department when what is meant is "we could not tell".
--
-- STABLE, not volatile: it reads a JWT and two small tables and is
-- called once per write.
create or replace function acting_person_name()
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_me   uuid := attendance_my_crew_id();
  v_uid  text;
  v_name text;
begin
  if v_me is not null then
    select e.full_name into v_name from admin_employees e where e.id = v_me;
  else
    begin
      v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
    exception when others then v_uid := null;
    end;
    if v_uid is not null then
      select si.name into v_name
        from scheduler_instructors si where si.app_user_id = v_uid::uuid limit 1;
      if v_name is null then
        select u.display_name into v_name from app_users u where u.id = v_uid::uuid;
      end if;
    end if;
  end if;
  return coalesce(nullif(btrim(coalesce(v_name, '')), ''), 'Star Swim');
end $$;

revoke all on function acting_person_name() from public, anon;
grant execute on function acting_person_name() to authenticated, service_role;

comment on function acting_person_name() is
  'The name to put on something this signed-in person just did: their '
  'crew record, else their scheduler seat, else their website seat. One '
  'answer, so a tick and a progress note cannot name them differently.';


-- ─── The tick ───────────────────────────────────────────────────────────
-- Re-created whole, as every change to this function is. New since
-- supabase_grading_coach.sql: the name comes from acting_person_name().
create or replace function mark_grading_task(
  p_student uuid, p_task uuid, p_on boolean, p_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me   uuid := attendance_my_crew_id();
  v_name text;
  v_ms   uuid;
  v_exists uuid;
begin
  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false,
      'error', 'You are not rostered to this swimmer.');
  end if;

  select t.milestone_id into v_ms from grading_tasks t where t.id = p_task and t.is_active;
  if v_ms is null then
    return jsonb_build_object('ok', false, 'error', 'That task is no longer on the syllabus.');
  end if;

  -- The name as it stands today, which is what the mark will carry for
  -- as long as it exists. A coach who leaves is still the person who
  -- watched the child do it.
  v_name := acting_person_name();

  select m.id into v_exists
    from student_task_marks m
   where m.student_id = p_student and m.task_id = p_task and m.removed_at is null;

  if p_on then
    if v_exists is not null then
      -- Two coaches on one squad session, both ticking. Not an error and
      -- not a second achievement.
      return jsonb_build_object('ok', true, 'already', true, 'task_id', p_task);
    end if;
    insert into student_task_marks (student_id, task_id, marked_by, marked_by_name, session_id)
    values (p_student, p_task, v_me, v_name, p_session);
  else
    if v_exists is null then
      return jsonb_build_object('ok', true, 'already', true, 'task_id', p_task);
    end if;
    update student_task_marks
       set removed_at = now(), removed_by = v_me, removed_by_name = v_name
     where id = v_exists;
  end if;

  -- The trigger on student_task_marks has already recomputed the
  -- milestone. Read it back rather than working it out here, so the
  -- screen and the database cannot disagree about whether that tick
  -- just earned something.
  return jsonb_build_object(
    'ok', true,
    'task_id', p_task,
    'by', v_name,
    'milestone_id', v_ms,
    'activated', exists (select 1 from student_milestones sm
                          where sm.student_id = p_student
                            and sm.milestone_id = v_ms
                            and sm.revoked_at is null),
    'milestone', (select m.name from grading_milestones m where m.id = v_ms),
    'level_no', (select m.level_no from grading_milestones m where m.id = v_ms),
    'certificate', (select m.certificate from grading_milestones m where m.id = v_ms));
end $$;

revoke all on function mark_grading_task(uuid, uuid, boolean, uuid) from public, anon;
grant execute on function mark_grading_task(uuid, uuid, boolean, uuid) to authenticated;


-- ─── Handing the certificate over ───────────────────────────────────────
-- Re-created whole. New since supabase_grading_awards.sql: same.
create or replace function claim_certificate(
  p_student uuid, p_milestone uuid, p_claimed boolean default true,
  p_kind text default 'certificate')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
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

  v_name := acting_person_name();

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


notify pgrst, 'reload schema';


-- ─── What is now in place ───────────────────────────────────────────────
-- One statement. The Supabase editor shows the result of the last
-- statement only.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the three functions that name a person' as thing,
         coalesce((select string_agg(p.proname, '  ·  ' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('acting_person_name',
                                        'mark_grading_task',
                                        'claim_certificate',
                                        'add_progress_note')),
                  'NONE INSTALLED') as detail
  union all
  select 2, 'and they all ask the same thing',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('mark_grading_task', 'claim_certificate')
             and p.prosrc like '%acting_person_name()%')
      || ' of 2 grading functions now resolve the name in one place '
      || '(2 is right)'
  union all
  select 3, 'who this session would be recorded as',
         acting_person_name()
      || ' — in the SQL editor there is no login, so "Star Swim" here is '
      || 'correct and says nothing about what the apps will write'
  union all
  select 4, 'ticks already recorded, by name',
         coalesce((select string_agg(x.who || ' (' || x.n || ')', ' · ' order by x.n desc)
                     from (select coalesce(k.marked_by_name, '—') as who, count(*) as n
                             from student_task_marks k
                            where k.removed_at is null
                            group by 1) x), 'none yet')
  union all
  select 5, 'old marks are left as they are',
         'A tick that says "the office" goes on saying it. The name on a '
      || 'mark is what was true when it was made; only new ticks carry '
      || 'the fuller name.'
  union all
  select 6, 'next',
         'Nothing to deploy. Both apps call these functions by the same '
      || 'names and with the same arguments as before.'
  ) z
 order by z.k;
