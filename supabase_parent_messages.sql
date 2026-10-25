-- ════════════════════════════════════════════════════════════════════════
--  What the centre says to parents: reminders and announcements
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Creates tables if missing, replaces functions, and
--  does not touch a message already sent.
--
--  TWO KINDS OF MESSAGE, ONE INBOX
--  A reminder is written by the system from the timetable. An
--  announcement is written by a person. A parent should not have to
--  care which, so both land in parent_messages and the app shows one
--  list.
--
--  IN-APP ONLY, FOR NOW
--  Nothing here sends a WhatsApp or an SMS. channel exists on the
--  settings row so that when Twilio is live the switch is a setting and
--  not a rewrite, but every message today is read in the app.
--
--  SENDING TWICE IS THE FAILURE TO DESIGN AGAINST
--  A reminder job runs on a schedule, and a schedule fires twice more
--  often than anyone expects — a retry, a clock change, somebody
--  pressing the button to test it. Every reminder carries a dedupe_key
--  naming exactly what it is about (this family, these classes, this
--  date), with a unique index behind it. Running the job ten times
--  sends one message.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Settings ────────────────────────────────────────────────────────
-- One row. The scheduling side edits it; the job reads it.
create table if not exists parent_message_settings (
  id boolean primary key default true check (id),

  reminders_enabled boolean not null default true,

  -- WHEN. Two shapes, because they answer different worries.
  --   day_before   — everyone hears at the same hour, the evening before.
  --                  Predictable, and it is what a parent expects.
  --   hours_before — a fixed run-up per class. Better for a centre with
  --                  early classes, where "yesterday at noon" is a long
  --                  time before a 7am swim.
  lead_mode text not null default 'day_before'
            check (lead_mode in ('day_before', 'hours_before')),
  send_at_time time not null default '12:00',
  hours_before integer not null default 24
               check (hours_before between 1 and 168),

  -- Nothing lands at 3am. Matters little in an app, and a great deal
  -- the day this becomes a WhatsApp.
  quiet_start time not null default '07:00',
  quiet_end   time not null default '21:30',

  -- One message listing every child, or one per child.
  one_message_per_family boolean not null default true,

  -- A class the office has cancelled is not a class to turn up to.
  skip_cancelled boolean not null default true,

  channel text not null default 'in_app'
          check (channel in ('in_app', 'whatsapp', 'both')),

  reminder_title text not null default 'Class reminder',
  -- Placeholders, replaced when the message is built:
  --   {parent_name} {centre_name} {date} {class_list} {child_names}
  reminder_template text not null default
    E'Hi {parent_name},\n\nA reminder about {date}:\n\n{class_list}\n\nSee you at the pool.\n{centre_name}',
  -- One line per class inside {class_list}:
  --   {child} {time} {lesson} {pool} {coach}
  reminder_line_template text not null default '• {child} — {time}, {lesson} at {pool}',

  centre_name text not null default 'Star Swim',

  updated_at timestamptz not null default now(),
  updated_by text
);

insert into parent_message_settings (id) values (true) on conflict (id) do nothing;


-- ─── 2. Announcements written by a person ───────────────────────────────
create table if not exists parent_broadcasts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body  text not null,
  audience text not null default 'all' check (audience in ('all', 'selected')),
  created_at timestamptz not null default now(),
  created_by text,
  -- Null until it goes out. A draft is not an announcement.
  sent_at timestamptz,
  recipients integer
);

create table if not exists parent_broadcast_targets (
  broadcast_id uuid not null references parent_broadcasts(id) on delete cascade,
  account_id   uuid not null references parent_accounts(id) on delete cascade,
  primary key (broadcast_id, account_id)
);


-- ─── 3. The inbox ───────────────────────────────────────────────────────
create table if not exists parent_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references parent_accounts(id) on delete cascade,
  kind text not null check (kind in ('reminder', 'announcement')),
  title text not null,
  body  text not null,
  -- What this message is about. Two messages with the same key are the
  -- same message, and the second one is not sent.
  dedupe_key text,
  broadcast_id uuid references parent_broadcasts(id) on delete set null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create unique index if not exists parent_messages_dedupe_idx
  on parent_messages (account_id, kind, dedupe_key)
  where dedupe_key is not null;

create index if not exists parent_messages_inbox_idx
  on parent_messages (account_id, created_at desc);


-- ─── 4. Which classes a reminder is for ─────────────────────────────────
-- Shared by the preview and the send, so what you are shown and what
-- goes out cannot be two different answers.
--
-- A swimmer who asked for a replacement is already out of the roster,
-- so they are not reminded about a class they are not attending.
create or replace function parent_reminder_rows(p_for_date date)
returns table (
  account_id   uuid,
  parent_name  text,
  child        text,
  class_date   date,
  start_time   time,
  lesson       text,
  pool         text,
  coach        text
)
language sql stable security definer set search_path = public as $$
  select s.account_id,
         coalesce(nullif(btrim(pa.display_name), ''), 'there')::text,
         coalesce(nullif(btrim(wss.student_name), ''), s.name)::text,
         (ws.week_start_date + (ws.weekday - 1))::date,
         (ws.start_minute * interval '1 minute')::time,
         coalesce(lt.name, 'Class')::text,
         coalesce(p.name, '')::text,
         coalesce((select string_agg(sc.name, ', ' order by sc.name)
                     from session_instructors si
                     join scheduler_instructors sc on sc.id = si.instructor_id
                    where si.session_id = ws.id), '')::text
    from weekly_sessions ws
    join weekly_session_students wss on wss.session_id = ws.id
    join students s          on s.id = wss.student_id
    join parent_accounts pa  on pa.id = s.account_id
    left join pools p        on p.id = ws.pool_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where (ws.week_start_date + (ws.weekday - 1))::date = p_for_date
     and (ws.cancelled_at is null
          or not (select skip_cancelled from parent_message_settings where id))
     and coalesce(wss.is_replacement, false) is not null
   order by s.account_id, 4, 5;
$$;


-- ─── 5. Building the text ───────────────────────────────────────────────
-- Splitting on the braces leaves the pieces alternating: literal text at
-- the odd positions, the name inside the braces at the even ones. The
-- order matters as much as the test — string_agg without one is free to
-- hand back the sentence shuffled.
create or replace function parent_render(p_text text, p_vars jsonb)
returns text language sql immutable as $$
  select coalesce(
    (select string_agg(
              case when t.idx % 2 = 1 then t.part
                   else coalesce(p_vars ->> t.part, '{' || t.part || '}') end,
              '' order by t.idx)
       from regexp_split_to_table(coalesce(p_text, ''), '[{}]')
            with ordinality t(part, idx)),
    p_text);
$$;

comment on function parent_render(text, jsonb) is
  'Replaces {name} with the value of name. An unknown placeholder is '
  'left as it was written rather than becoming an empty space, so a '
  'typo in a template reads as a typo and not as missing information.';


-- ─── 6. What would go out ───────────────────────────────────────────────
-- Read-only. The module calls this to show the office the actual
-- messages, to the actual families, before anything is sent.
create or replace function parent_reminder_preview(p_for_date date)
returns table (account_id uuid, parent_name text, title text, body text, classes integer)
language plpgsql stable security definer set search_path = public as $$
declare st parent_message_settings;
begin
  select * into st from parent_message_settings where id;
  if st is null then return; end if;

  return query
  with rows as (select * from parent_reminder_rows(p_for_date)),
  lines as (
    select r.account_id, r.parent_name, r.child,
           parent_render(st.reminder_line_template, jsonb_build_object(
             'child',  r.child,
             'time',   to_char(r.start_time, 'FMHH12:MI AM'),
             'lesson', r.lesson,
             'pool',   r.pool,
             'coach',  r.coach)) as line
      from rows r
  )
  select l.account_id,
         max(l.parent_name)::text,
         st.reminder_title,
         parent_render(st.reminder_template, jsonb_build_object(
           'parent_name', max(l.parent_name),
           'centre_name', st.centre_name,
           'date',        to_char(p_for_date, 'FMDay FMDD FMMonth'),
           'child_names', (select string_agg(distinct x.child, ', ') from lines x
                            where x.account_id = l.account_id),
           'class_list',  string_agg(l.line, E'\n' order by l.line)))::text,
         count(*)::int
    from lines l
   group by l.account_id;
end $$;


-- ─── 7. Sending them ────────────────────────────────────────────────────
-- Called on a schedule, and safe to call by hand. Works out which date
-- is due from the settings rather than being told, so the schedule
-- cannot drift away from what the office configured.
--
--   day_before   — due when the clock passes send_at_time; the date
--                  reminded about is tomorrow.
--   hours_before — due for any class inside the next hours_before, and
--                  the dedupe key keeps a family from hearing twice.
--
-- Returns what it did, so a cron log says something useful.
create or replace function send_class_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st        parent_message_settings;
  v_local   timestamp;
  v_time    time;
  v_for     date;
  v_key     text;
  v_sent    int := 0;
  v_skipped int := 0;
begin
  select * into st from parent_message_settings where id;
  if st is null or not st.reminders_enabled then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'reminders are switched off');
  end if;

  v_local := (p_now at time zone 'Asia/Kuala_Lumpur');
  v_time  := v_local::time;

  -- Quiet hours are a floor on when a person is disturbed, not a reason
  -- to lose the message: it goes out at the next run inside the window.
  if v_time < st.quiet_start or v_time > st.quiet_end then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'inside quiet hours');
  end if;

  if st.lead_mode = 'day_before' then
    if v_time < st.send_at_time then
      return jsonb_build_object('ok', true, 'sent', 0, 'why', 'not yet time today');
    end if;
    v_for := (v_local::date) + 1;
  else
    v_for := (v_local + make_interval(hours => st.hours_before))::date;
  end if;

  -- One row per family. The key names the family and the day, so the
  -- second run of the same day finds the message already there.
  v_key := 'classes:' || v_for::text;

  with p as (select * from parent_reminder_preview(v_for)),
  ins as (
    insert into parent_messages (account_id, kind, title, body, dedupe_key)
    select p.account_id, 'reminder', p.title, p.body, v_key from p
    on conflict (account_id, kind, dedupe_key) where dedupe_key is not null
      do nothing
    returning 1
  )
  select (select count(*) from ins), (select count(*) from p) - (select count(*) from ins)
    into v_sent, v_skipped;

  return jsonb_build_object('ok', true, 'for_date', v_for,
                            'sent', v_sent, 'already_had_one', v_skipped);
end $$;

comment on function send_class_reminders(timestamptz) is
  'The reminder job. Reads parent_message_settings for when and what, '
  'and is safe to run as often as you like: a family already reminded '
  'about a day is not reminded again.';


-- ─── 8. An announcement going out ───────────────────────────────────────
create or replace function send_broadcast(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare b parent_broadcasts; v_n int := 0;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to send.');
  end if;

  select * into b from parent_broadcasts where id = p_id;
  if b.id is null then
    return jsonb_build_object('ok', false, 'error', 'No such announcement.');
  end if;
  -- Sending twice would put it in every inbox twice, and there is no
  -- unsending. One way only.
  if b.sent_at is not null then
    return jsonb_build_object('ok', false, 'error',
      'This was already sent on ' || to_char(b.sent_at at time zone 'Asia/Kuala_Lumpur',
                                             'FMDD Mon YYYY at FMHH12:MI AM') || '.');
  end if;

  with targets as (
    select pa.id as account_id
      from parent_accounts pa
     where b.audience = 'all'
        or exists (select 1 from parent_broadcast_targets t
                    where t.broadcast_id = b.id and t.account_id = pa.id)
  ),
  ins as (
    insert into parent_messages (account_id, kind, title, body, dedupe_key, broadcast_id)
    select t.account_id, 'announcement', b.title, b.body, 'broadcast:' || b.id::text, b.id
      from targets t
    on conflict (account_id, kind, dedupe_key) where dedupe_key is not null
      do nothing
    returning 1
  )
  select count(*) into v_n from ins;

  update parent_broadcasts
     set sent_at = now(), recipients = v_n
   where id = p_id;

  return jsonb_build_object('ok', true, 'recipients', v_n);
end $$;


-- ─── 9. The parent's own inbox ──────────────────────────────────────────
-- Keyed to the signed-in account and nothing else. There is no argument
-- for whose inbox to read, because an argument is something a caller
-- can change.
create or replace function my_parent_account_id()
returns uuid language sql stable security definer set search_path = public as $$
  select pa.id from parent_accounts pa where pa.auth_user_id = auth.uid();
$$;

create or replace function my_messages(p_limit integer default 50)
returns table (id uuid, kind text, title text, body text,
               created_at timestamptz, read_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.kind, m.title, m.body, m.created_at, m.read_at
    from parent_messages m
   where m.account_id = my_parent_account_id()
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function mark_message_read(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acct uuid;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  update parent_messages
     set read_at = coalesce(read_at, now())
   where id = p_id and account_id = v_acct;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such message.');
  end if;
  return jsonb_build_object('ok', true);
end $$;


-- ─── 10. Locks ──────────────────────────────────────────────────────────
-- A parent reads their own messages and marks them read. Everything
-- else about these tables belongs to the office. The settings, the
-- broadcasts and the targets are not a parent's business at all, so
-- they get no parent policy — not a narrow one, none.
alter table parent_message_settings enable row level security;
alter table parent_broadcasts        enable row level security;
alter table parent_broadcast_targets enable row level security;
alter table parent_messages          enable row level security;

drop policy if exists pms_office      on parent_message_settings;
drop policy if exists pb_office       on parent_broadcasts;
drop policy if exists pbt_office      on parent_broadcast_targets;
drop policy if exists pmsg_office     on parent_messages;
drop policy if exists pmsg_mine_read  on parent_messages;
drop policy if exists pmsg_mine_write on parent_messages;

create policy pms_office  on parent_message_settings for all
  using (is_website_login()) with check (can_write_office());
create policy pb_office   on parent_broadcasts for all
  using (is_website_login()) with check (can_write_office());
create policy pbt_office  on parent_broadcast_targets for all
  using (is_website_login()) with check (can_write_office());
create policy pmsg_office on parent_messages for all
  using (is_website_login()) with check (can_write_office());

-- The parent's own, read only. Marking read goes through
-- mark_message_read, which is definer and checks the account itself —
-- an update policy here would also let a parent rewrite the body of a
-- message the centre sent them.
create policy pmsg_mine_read on parent_messages for select
  using (account_id = my_parent_account_id());

revoke all on parent_message_settings from anon;
revoke all on parent_broadcasts        from anon;
revoke all on parent_broadcast_targets from anon;
revoke all on parent_messages          from anon;


-- ─── 11. Making it actually run ─────────────────────────────────────────
-- Nothing above runs itself. send_class_reminders() has to be called,
-- and it is written to be called often: every hour is right. It works
-- out whether anything is due from the settings, so the schedule never
-- has to be changed when the office changes the time.
--
-- Supabase ships pg_cron. Enable it once under Database → Extensions,
-- then run this block. It is separate from the rest of the file because
-- it needs that extension and because scheduling is a decision, not a
-- migration.
--
--   create extension if not exists pg_cron;
--
--   select cron.unschedule('star-swim-class-reminders')
--    where exists (select 1 from cron.job
--                   where jobname = 'star-swim-class-reminders');
--
--   -- Hourly, on the hour, UTC. The function itself holds the Malaysian
--   -- clock, the quiet hours and the send time, so an hourly tick is
--   -- enough however the office sets it.
--   select cron.schedule('star-swim-class-reminders', '0 * * * *',
--                        $cron$ select send_class_reminders(); $cron$);
--
-- To see what it has done:
--
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--    order by start_time desc limit 20;
--
-- Running it by hand is safe at any time — a family already reminded
-- about a day is not reminded again:
--
--   select send_class_reminders();
