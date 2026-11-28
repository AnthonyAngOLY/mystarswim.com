-- ─────────────────────────────────────────────────────────────────────────
-- Enough of the real database for the sign-in SQL to run against.
--
-- WHY THIS EXISTS
-- supabase_parent_signin_guard.sql and supabase_parent_password.sql were
-- reviewed by reading. Reading did not notice min(pa.id) on a uuid
-- column. Postgres has no min(uuid), and nothing says so until the
-- function is CALLED -- plpgsql resolves function names at run time, so
-- it installed cleanly, the confirm block reported success, and the
-- first parent to ask for a sign-in code got "we could not check that
-- just now" with the real reason buried in an Edge Function log.
--
-- The same shape of fault as the public-intake function using `db` before
-- `const db` ran: deployed, live, and dead on its newest path.
--
-- So: the smallest schema those two files touch, so they can be executed
-- here rather than read. Not a copy of the production database and not
-- trying to be -- every table is the columns the sign-in actually reads,
-- and nothing else.
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- Supabase's roles, which the files grant to.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create table parent_accounts (
  id              uuid primary key default gen_random_uuid(),
  display_name    text,
  phone_primary   text,
  phone_secondary text,
  active_phone    text not null default 'primary'
                  check (active_phone in ('primary','secondary')),
  email           text,
  auth_user_id    uuid unique,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now()
);

create or replace function parent_signin_phone(p parent_accounts)
returns text language sql immutable as $$
  select case when p.active_phone = 'secondary' then p.phone_secondary
              else p.phone_primary end;
$$;

create table students (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references parent_accounts(id),
  name       text,
  is_active  boolean default true
);

create table parent_message_settings (
  id integer primary key default 1
);

-- Supabase's own auth table. parent_password_uptake counts how many
-- parents have set a password by reading encrypted_password here. The
-- has_table_privilege() guard around that read does not spare us: the
-- statement still has to PARSE, so auth.users must exist even where it
-- cannot be read.
create schema if not exists auth;
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  phone              text,
  email              text,
  encrypted_password text
);

-- can_write_office() decides who may read the spend log. The real one
-- reads the JWT; here it is a switch a test flips, because what is being
-- tested is that the functions ask it, not how it answers.
create table _test_state (office boolean not null default true, crew uuid,
                          may_note boolean not null default true,
                          -- The website seat a test is pretending to be.
                          -- Null means no JWT at all, which is the SQL
                          -- editor and the attendance app.
                          app_user uuid);
insert into _test_state (office) values (true);

create or replace function can_write_office() returns boolean
language sql stable as $$ select office from _test_state limit 1 $$;

create or replace function is_website_login() returns boolean
language sql stable as $$ select true $$;

-- The project's own reading of a Malaysian mobile. reset_signin_attempts
-- normalises through it, so the fixture needs it.
create or replace function ss_normalise_phone(p_raw text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p_raw is null then return null; end if;
  d := regexp_replace(p_raw, '[^0-9]', '', 'g');
  if d = '' then return null; end if;
  if left(d, 2) = '60' then return '+' || d; end if;
  if left(d, 1) = '0'  then return '+60' || substr(d, 2); end if;
  return '+60' || d;
end $$;

-- Lesson types, which the grading module hangs a programme off.
create table if not exists scheduler_lesson_types (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  is_active  boolean default true,
  sort_order integer default 0
);

-- A coach, as the attendance app knows them. The grading policies let a
-- crew member write marks, so the fixture needs the function that says
-- whether the caller is one.
create or replace function attendance_my_crew_id() returns uuid
language sql stable as $$ select crew from _test_state limit 1 $$;

-- Enough of the timetable for my_roster_grading to run against.
-- AS THE REAL TABLE IS SHAPED, which is the whole point. This stood as
-- `session_date date` -- a column the live weekly_sessions does not
-- have -- because my_roster_grading filtered on that name. So the
-- fixture was built to fit the function instead of the database, the
-- suite called the function happily, and in production every class list
-- raised "column ws.session_date does not exist" and the app, which
-- catches that call, drew no badges at all. A mock more capable than
-- the real thing cannot catch misuse.
--
-- The live table stores the week and the day; every other file derives
-- the date as (week_start_date + (weekday - 1)). weekday is 1-based
-- from the week start.
create table if not exists weekly_sessions (
  id uuid primary key default gen_random_uuid(),
  week_start_date date, weekday integer,
  start_minute integer, duration_minutes integer);
create table if not exists weekly_session_students (
  id uuid primary key default gen_random_uuid(), session_id uuid, student_id uuid);
create table if not exists session_instructors (
  session_id uuid, instructor_id uuid);
create table if not exists student_enrollments (
  student_id uuid, lesson_type_id uuid);
create table if not exists admin_employees (
  id uuid primary key default gen_random_uuid(), full_name text);

-- The two tables acting_person_name() falls back to when there is no
-- crew id -- an instructor signed in at a desk, then any other website
-- seat. They are here because plpgsql resolves a table name when the
-- query RUNS: without them the function installs perfectly and raises
-- on the first tick somebody makes from the scheduler, which is the
-- exact shape of the min(uuid) fault this suite exists for.
create table if not exists scheduler_instructors (
  id uuid primary key default gen_random_uuid(), name text,
  app_user_id uuid, is_active boolean not null default true);
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(), display_name text);

-- A token, as the functions read one. Supabase's auth.jwt() raises when
-- there is none, and the functions all catch that -- so the default here
-- raises too, or the no-login path would never be the one under test.
create or replace function auth.jwt() returns jsonb
language plpgsql stable as $$
declare v uuid;
begin
  select app_user into v from _test_state limit 1;
  if v is null then
    raise exception 'no JWT';
  end if;
  return jsonb_build_object('app_metadata',
           jsonb_build_object('app_user_id', v::text));
end $$;

-- The one check that decides who may tick. The real one asks whether
-- this person was rostered to that child's water; here it is a switch,
-- because what is under test is that the functions ASK it.
create or replace function can_note_on_student(p_student uuid) returns boolean
language sql stable as $$ select coalesce((select may_note from _test_state limit 1), true) $$;

-- What the parent app reads through. The real one resolves the signed-in
-- auth user; here it is the first account, because what is under test is
-- what my_family does with the answer.
create or replace function my_parent_account_id() returns uuid
language sql stable as $$ select id from parent_accounts order by created_at limit 1 $$;

create table if not exists parent_messages (
  account_id uuid, read_at timestamptz);

insert into parent_message_settings (id) values (1);
