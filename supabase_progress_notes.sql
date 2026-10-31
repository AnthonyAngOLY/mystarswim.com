-- ════════════════════════════════════════════════════════════════════════
--  Progress notes: what a coach tells a parent about their swimmer
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Creates one table if missing and replaces four
--  functions. Nothing is deleted, here or ever.
--
--  STRAIGHT TO THE PARENT
--  A note written at the poolside reaches the parent as soon as it is
--  saved. No queue, no approval step. That was the centre's decision and
--  it is the right one — a note held for review is a note written next
--  week, and a coach who knows nobody reads it stops writing them.
--
--  It also sets the bar. The coach's name is on it, in front of the
--  parent, from the moment they press save. That is not decoration: it
--  is the only thing standing in for an editor.
--
--  WHO MAY WRITE ONE
--  Any coach who teaches that swimmer — assigned to a class the child is
--  in, at any point, not only today. A coach covering a term's worth of
--  Saturdays should be able to write about a child they taught in March.
--  The office may write about anybody.
--
--  CORRECTIONS, NOT DELETIONS
--  A note can be reworded by its author on the day it was written, which
--  covers the mis-tap and the half-finished sentence. After that it
--  stands. Anything genuinely wrong is voided, which hides it from the
--  parent and keeps the row — the same rule the rest of this system
--  follows, because what was said to a parent is a record.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The table ───────────────────────────────────────────────────────
create table if not exists student_progress_notes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  -- The class it came out of, when there was one. Null for a note the
  -- office writes from the desk.
  session_id uuid references weekly_sessions(id) on delete set null,
  body text not null check (btrim(body) <> ''),

  -- Shown to the parent, and fixed at the moment of writing. A coach who
  -- later leaves, or is renamed, does not rewrite what the parent read.
  author_name text not null,
  author_crew_id uuid,
  author_app_user_id uuid,

  created_at timestamptz not null default now(),
  edited_at  timestamptz,

  -- Voided, never deleted.
  is_void boolean not null default false,
  voided_at timestamptz,
  voided_by text,
  void_reason text
);

create index if not exists progress_notes_student_idx
  on student_progress_notes (student_id, created_at desc) where not is_void;
create index if not exists progress_notes_session_idx
  on student_progress_notes (session_id) where session_id is not null;


-- ─── 2. May this caller write about this swimmer? ───────────────────────
-- Shared by the write and by the coach screen's "can I" check, so the
-- button and the server cannot disagree.
create or replace function can_note_on_student(p_student uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid; v_inst uuid; v_uid text;
begin
  if can_write_office() then return true; end if;

  v_me := attendance_my_crew_id();
  if v_me is null then
    begin
      v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
    exception when others then v_uid := null;
    end;
    if v_uid is null then return false; end if;
    select si.id into v_inst from scheduler_instructors si
      where si.app_user_id = v_uid::uuid and si.is_active is not false limit 1;
    if v_inst is null then return false; end if;
  end if;

  -- Assigned to any class this swimmer is in. Not only today's: a coach
  -- should be able to write up a term, not just an hour.
  if exists (
    select 1
      from weekly_session_students wss
      join session_instructors si   on si.session_id = wss.session_id
      join scheduler_instructors sc on sc.id = si.instructor_id
     where wss.student_id = p_student
       and ((v_me is not null and sc.crew_id = v_me)
         or (v_inst is not null and sc.id = v_inst)))
  then return true; end if;

  -- Or they have marked this swimmer's attendance themselves. Since
  -- coach_can_mark_session let an unnamed coach mark a class running in
  -- water they are rostered to, a squad session with three coaches and
  -- one name leaves two who plainly teach the child and could not write
  -- a word to the parent about it.
  --
  -- Having marked them is the proof, and a narrow one: it says this
  -- coach stood in front of this swimmer and recorded it. Being merely
  -- rostered to a busy pool is not enough, or a coach at Botani could
  -- write to the parents of six classes they have never taught.
  return v_me is not null and exists (
    select 1 from weekly_session_students wss
     where wss.student_id = p_student
       and wss.marked_by_crew_id = v_me);
end $$;


-- ─── 3. Writing one ─────────────────────────────────────────────────────
create or replace function add_progress_note(
  p_student uuid, p_body text, p_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid; v_uid text; v_name text; v_inst uuid; v_id uuid;
  v_body text;
begin
  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return jsonb_build_object('ok', false, 'error', 'There is nothing in the note.');
  end if;
  -- Long enough for a paragraph about a child, short enough that the
  -- parent app is not asked to render an essay.
  if length(v_body) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'That note is too long. Keep it under 2000 characters.');
  end if;
  if not can_note_on_student(p_student) then
    return jsonb_build_object('ok', false, 'error', 'You do not teach this swimmer.');
  end if;

  v_me := attendance_my_crew_id();
  if v_me is not null then
    select e.full_name into v_name from admin_employees e where e.id = v_me;
  else
    begin
      v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
    exception when others then v_uid := null;
    end;
    if v_uid is not null then
      select si.id, si.name into v_inst, v_name
        from scheduler_instructors si where si.app_user_id = v_uid::uuid limit 1;
      if v_name is null then
        select u.display_name into v_name from app_users u where u.id = v_uid::uuid;
      end if;
    end if;
  end if;
  v_name := coalesce(nullif(btrim(coalesce(v_name, '')), ''), 'Star Swim');

  insert into student_progress_notes
    (student_id, session_id, body, author_name, author_crew_id, author_app_user_id)
  values
    (p_student, p_session, v_body, v_name, v_me,
     case when v_uid is not null then v_uid::uuid end)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'author', v_name);
end $$;

comment on function add_progress_note(uuid, text, uuid) is
  'A coach writes about a swimmer they teach. Reaches the parent at '
  'once, with the coach''s name on it.';


-- ─── 4. Correcting and voiding ──────────────────────────────────────────
-- Same day, same author: the mis-tap and the unfinished sentence. After
-- midnight it stands, and anything wrong is voided instead.
create or replace function edit_progress_note(p_id uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare n student_progress_notes; v_me uuid; v_body text;
begin
  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return jsonb_build_object('ok', false, 'error', 'There is nothing in the note.');
  end if;
  select * into n from student_progress_notes where id = p_id;
  if n.id is null then
    return jsonb_build_object('ok', false, 'error', 'No such note.');
  end if;
  if n.is_void then
    return jsonb_build_object('ok', false, 'error', 'That note was withdrawn.');
  end if;

  if not can_write_office() then
    v_me := attendance_my_crew_id();
    if v_me is null or n.author_crew_id is distinct from v_me then
      return jsonb_build_object('ok', false, 'error', 'That is not your note.');
    end if;
    if (n.created_at at time zone 'Asia/Kuala_Lumpur')::date
       <> (now() at time zone 'Asia/Kuala_Lumpur')::date then
      return jsonb_build_object('ok', false,
        'error', 'That note was written on another day. The parent has it — ask the office.');
    end if;
  end if;

  update student_progress_notes
     set body = v_body, edited_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function void_progress_note(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare n student_progress_notes; v_me uuid; v_who text;
begin
  select * into n from student_progress_notes where id = p_id;
  if n.id is null then
    return jsonb_build_object('ok', false, 'error', 'No such note.');
  end if;
  if n.is_void then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  v_me := attendance_my_crew_id();
  if not can_write_office() then
    if v_me is null or n.author_crew_id is distinct from v_me then
      return jsonb_build_object('ok', false, 'error', 'That is not your note.');
    end if;
  end if;
  select coalesce(e.full_name, 'the office') into v_who
    from admin_employees e where e.id = v_me;

  update student_progress_notes
     set is_void = true, voided_at = now(),
         voided_by = coalesce(v_who, 'the office'),
         void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;


-- ─── 5. Reading them ────────────────────────────────────────────────────
-- The coach's view: what has been said about this swimmer, by anybody.
-- A coach taking over a class needs the history, not only their own.
create or replace function notes_for_student(p_student uuid)
returns table (id uuid, body text, author text, created_at timestamptz,
               edited_at timestamptz, mine boolean, same_day boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid;
begin
  if not can_note_on_student(p_student) then return; end if;
  v_me := attendance_my_crew_id();
  return query
    select n.id, n.body, n.author_name, n.created_at, n.edited_at,
           (v_me is not null and n.author_crew_id = v_me),
           ((n.created_at at time zone 'Asia/Kuala_Lumpur')::date
            = (now() at time zone 'Asia/Kuala_Lumpur')::date)
      from student_progress_notes n
     where n.student_id = p_student and not n.is_void
     order by n.created_at desc
     limit 50;
end $$;

-- The parent's view: their own children only, and no way to ask about
-- anybody else's. A voided note was never said as far as they are
-- concerned — that is what voiding it is for.
create or replace function my_child_notes(p_student uuid default null)
returns table (student_id uuid, child text, id uuid, body text,
               author text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.name::text, n.id, n.body, n.author_name, n.created_at
    from student_progress_notes n
    join students s on s.id = n.student_id
   where s.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
     and not n.is_void
     and (p_student is null or n.student_id = p_student)
   order by n.created_at desc
   limit 200;
$$;


-- ─── 6. Locks ───────────────────────────────────────────────────────────
-- Every door above is a definer function. The table itself is shut: a
-- policy wide enough to let a coach insert is wide enough to let them
-- write under somebody else's name.
alter table student_progress_notes enable row level security;

drop policy if exists spn_office on student_progress_notes;
create policy spn_office on student_progress_notes for all
  using (is_website_login()) with check (can_write_office());

revoke all on student_progress_notes from anon;
