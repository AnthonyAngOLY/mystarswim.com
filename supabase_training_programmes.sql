-- ════════════════════════════════════════════════════════════════════════
--  Training programmes, which are not lessons
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  adds three columns and one function, and changes no data.
--
--  RUN THIS FIRST, then supabase_coach_roster.sql, then
--  supabase_class_credit_policy.sql. Those two read what this adds.
--
--  WHAT THIS IS FOR
--  A training programme is not a lesson. ASC squad and the SJKC Bandar
--  Seri Botani school course are the same kind of thing: ten or twenty
--  swimmers in the water, two or three coaches on the poolside, and a
--  session that runs whether or not any one swimmer turns up. Miss it
--  and you were absent. There are no credits, because the fee buys the
--  programme rather than the sessions.
--
--  The attendance app did not know that. It reads a swimmer's credit
--  balance before every mark, and a child who has never bought a credit
--  has a balance of nil — so every mark came back as "no credits left.
--  Billing or a renewal is needed", twenty times a session. Tap through
--  those and each one writes an attendance_unpaid row and drives the
--  balance to −1, −2, −3, until by the end of term every child in the
--  programme sits in the defaulters report owing money they have paid.
--
--  That is the credit system applying itself to a programme that has no
--  credits. The fix is to let a lesson type say which kind it is.
--
--  THE MODE CARRIES THE POLICY
--  Everything downstream reads programme_type rather than carrying its own
--  exception for this one programme:
--
--    lessons   learn-to-swim, as before. Credits read, moved and owed.
--    training  squad and school programmes. Attendance is recorded and
--              nothing else. No balance is
--              read, no ledger row written, no defaulters entry, and no
--              replacement — a training class runs on whether or not any
--              one swimmer is in it, so there is nothing to give back.
--              Clause 5.2 of the SJKC terms says the same in words.
--
--  ASC is perpetual: it simply goes on. SJKC is the same kind of
--  teaching with four months drawn around it, like a school semester.
--  That difference is a start and an end date, not a different rule, so
--  it is not modelled here.
--
--  So "no replacements for SJKC" is not a setting anybody has to
--  remember. It follows from the same fact that makes it true.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Which kind of programme is this ─────────────────────────────────
alter table scheduler_lesson_types
  add column if not exists programme_type text not null default 'lessons',
  -- The most this lesson type may ever hold, whatever a session says.
  -- Null leaves capacity to the ratio, which is the old behaviour.
  add column if not exists max_students integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lesson_types_programme_type_ck') then
    alter table scheduler_lesson_types
      add constraint lesson_types_programme_type_ck
      check (programme_type in ('lessons','training'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lesson_types_max_students_ck') then
    alter table scheduler_lesson_types
      add constraint lesson_types_max_students_ck
      check (max_students is null or max_students between 1 and 200);
  end if;
end $$;

comment on column scheduler_lesson_types.programme_type is
  'lessons: learn-to-swim. The fee buys sessions and attendance spends '
  'them. training: squad and school programmes. The class runs on '
  'regardless, attendance is recorded only, and a missed session is an '
  'absence with no replacement.';
comment on column scheduler_lesson_types.max_students is
  'The ceiling for this lesson type. A session may set a smaller roll of '
  'its own but never a larger one. Null means capacity comes from '
  'students_per_instructor times the number of coaches, as before.';


-- ─── 2. And how many this particular session takes ──────────────────────
-- A squad programme's roll varies week to week and term to term: the cap
-- is a property of the session, not of the kind of lesson. The lesson
-- type's ceiling still binds, so a roll cannot be raised past it by
-- editing one session.
alter table weekly_sessions
  add column if not exists max_students integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'weekly_sessions_max_students_ck') then
    alter table weekly_sessions
      add constraint weekly_sessions_max_students_ck
      check (max_students is null or max_students between 1 and 200);
  end if;
end $$;

comment on column weekly_sessions.max_students is
  'This session''s own roll. Null falls back to the lesson type''s '
  'max_students, and then to ratio times coaches.';


-- ─── 3. Asked in several places, so written once ────────────────────────
create or replace function lesson_type_is_training(p_lesson_type uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select lt.programme_type = 'training'
                     from scheduler_lesson_types lt
                    where lt.id = p_lesson_type), false);
$$;

comment on function lesson_type_is_training(uuid) is
  'True for a programme paid by the term. Read by mark_attendance, '
  'credit_defaulters and request_replacement so the rule lives in one '
  'place rather than three.';

revoke all on function lesson_type_is_training(uuid) from public, anon;
grant execute on function lesson_type_is_training(uuid) to authenticated;


-- ─── 4. What a session may hold ─────────────────────────────────────────
-- The same order the screens use: the session's own roll, then the
-- lesson type's ceiling, then the ratio. Written here so the office
-- screen and any report agree with the browser.
create or replace function session_capacity(p_session_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    ws.max_students,
    lt.max_students,
    nullif(coalesce(lt.students_per_instructor, 0), 0)
      * greatest(1, (select count(*) from session_instructors si
                      where si.session_id = ws.id))
  )
    from weekly_sessions ws
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where ws.id = p_session_id;
$$;

revoke all on function session_capacity(uuid) from public, anon;
grant execute on function session_capacity(uuid) to authenticated;


-- ─── 5. What is there now ───────────────────────────────────────────────
select 'lesson types' as thing, count(*)::text as n from scheduler_lesson_types
union all
select 'of those, paid by the term',
       count(*)::text from scheduler_lesson_types where programme_type = 'training'
union all
select 'of those, with a ceiling set',
       count(*)::text from scheduler_lesson_types where max_students is not null
union all
select 'sessions with a roll of their own',
       count(*)::text from weekly_sessions where max_students is not null
union all
select 'biggest class on the timetable',
       coalesce(max(n)::text, '0') from (
         select count(*) as n from weekly_session_students group by session_id) z;
