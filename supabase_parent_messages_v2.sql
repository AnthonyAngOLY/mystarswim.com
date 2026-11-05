-- ════════════════════════════════════════════════════════════════════════
--  The parent messaging ecosystem
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no new table, so there is nothing for the RLS guard to
--  find — but run supabase_rls_guard.sql afterwards anyway, as the habit.
--
--  Requires supabase_parent_messages.sql, which built the inbox, the
--  settings row, the template renderer and the announcement path. This
--  extends all four rather than replacing them.
--
--  SIX THINGS A PARENT HEARS, AND WHO DECIDES
--
--    class reminder      automatic, on a timer. Two days ahead by
--                        default, at a fixed hour, and never inside 24
--                        hours of the class.
--    replacement booked  automatic, the moment a replacement swimmer is
--                        put into a session. Immediate, because the
--                        parent needs the new day and time now.
--    replacement due     automatic, on the same timer as the class
--                        reminder. Skipped silently if the booking was
--                        made after the cut-off had already passed —
--                        the booking message already told them.
--    payment received    automatic, the moment a receipt is written.
--    marked absent       automatic, the moment a coach marks it.
--    outstanding / any   a person writes it and presses send.
--
--  WHY THE AUTOMATIC ONES ARE TRIGGERS
--  A message that depends on the office remembering is a message that
--  will not be sent on the day it matters. The payment note and the
--  absence note fire from the row being written, so it does not matter
--  which screen wrote it, or whether anybody was looking.
--
--  THE 24-HOUR FLOOR IS A FLOOR, NOT A SETTING TO GET RIGHT
--  A reminder's whole purpose is to leave time to tell us. One that
--  arrives inside the notice period cannot be acted on, so it is not
--  sent at all. With the defaults — two days, 4pm — the closest any
--  class comes is 32 hours, so the floor never bites. It is there for
--  the day somebody sets the lead to one day and nobody does the
--  arithmetic.
--
--  NOTHING HERE SENDS ITSELF ON A SCHEDULE
--  send_class_reminders() and send_replacement_reminders() have to be
--  called. The last section of supabase_parent_messages.sql says how,
--  with pg_cron. Both are safe to run as often as you like.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The kinds a message can be ──────────────────────────────────────
do $$
begin
  alter table parent_messages drop constraint if exists parent_messages_kind_check;
  alter table parent_messages add constraint parent_messages_kind_check
    check (kind in ('reminder','announcement','replacement','payment','absence','outstanding'));
end $$;


-- ─── 2. What the office decides ─────────────────────────────────────────
alter table parent_message_settings
  -- How far ahead the class reminder goes. Two days, so a parent has a
  -- working day to arrange something before the notice period starts.
  add column if not exists lead_days integer not null default 2,
  -- The floor. A reminder closer than this is not worth sending.
  add column if not exists min_hours_ahead integer not null default 24,

  add column if not exists replacement_enabled boolean not null default true,
  add column if not exists payment_enabled     boolean not null default true,
  add column if not exists absence_enabled     boolean not null default true,

  add column if not exists notice_hours integer not null default 24,
  add column if not exists replacement_window_days integer not null default 14,

  add column if not exists replacement_title text not null default 'Replacement class',
  add column if not exists payment_title     text not null default 'Payment received — thank you',
  add column if not exists absence_title     text not null default 'We missed you today',
  add column if not exists outstanding_title text not null default 'Outstanding balance';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pms_lead_days_ck') then
    alter table parent_message_settings add constraint pms_lead_days_ck
      check (lead_days between 0 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_min_hours_ck') then
    alter table parent_message_settings add constraint pms_min_hours_ck
      check (min_hours_ahead between 0 and 336);
  end if;
end $$;

-- The wording. Added as columns with defaults so an office that has
-- already rewritten one keeps its own words when this file is re-run.
--
-- Placeholders are the same idea everywhere: {parent_name}, {child},
-- {lesson}, {day_time}, {centre_name}, and whatever each one needs.
alter table parent_message_settings
  add column if not exists replacement_template text not null default
    E'Dear {parent_name},\n\n{child} has a {lesson} replacement session scheduled for {day_time}.\n\nPlease note that a replacement session cannot be rescheduled, so do come along at that time.\n\nWe look forward to seeing {child} in the pool.\n\n{centre_name}',

  add column if not exists payment_template text not null default
    E'Dear {parent_name},\n\nThank you — we have received your payment of {amount}.\n\nYour receipt {receipt_no} is in your account under Payments, together with the invoice it settles.\n\nWe appreciate you keeping your account up to date, and we look forward to seeing you at the pool.\n\n{centre_name}',

  add column if not exists absence_template text not null default
    E'Dear {parent_name},\n\nWe missed {child} at the {time} {lesson} today, and our instructor has marked the session as absent.\n\nIf something came up, do let us know — and a reminder that if you are ever unable to attend, telling us at least {notice_hours} hours before the class lets us arrange a replacement session for you.\n\nWe hope everything is well, and we look forward to seeing {child} next time.\n\n{centre_name}',

  add column if not exists outstanding_template text not null default
    E'Dear {parent_name},\n\nThis is a friendly reminder that your account has an outstanding balance of {amount}.\n\nIf you have already settled this, please accept our thanks and ignore this message. If not, we would be grateful if you could arrange payment at your convenience, or speak to us at reception if you would like to discuss it.\n\nThank you for your continued support.\n\n{centre_name}';

-- The default class reminder, in the wording asked for: what, when, and
-- what to do about it.
update parent_message_settings
   set reminder_template = E'Dear {parent_name},\n\n{class_list}\n\nKindly inform us ahead of time, at least {notice_hours} hours before the class, if you are unable to attend, and let us assist you in finding a replacement session. A replacement session must be scheduled within {replacement_window_days} days of the missed class.\n\nThank you.\n\n{centre_name}',
       reminder_line_template = '{child} has a {lesson} session scheduled on {day_time}.',
       reminder_title = 'Class reminder'
 where id and reminder_template like 'Hi {parent_name}%';   -- only if untouched


-- ─── 2b. Two corrections to the base file ───────────────────────────────
-- FIRST: a swimmer in a replacement session was getting both messages.
-- parent_reminder_rows carried the clause
--     coalesce(wss.is_replacement, false) is not null
-- which is true of every row ever written — a no-op where an exclusion
-- was meant. The comment above it said replacements are left out, and
-- they were, but only while they sat in the pending queue with no
-- session at all. The moment one was placed, they came back in and
-- would have had the ordinary "you have a class" note alongside the
-- replacement one, which says the opposite thing about rescheduling.
--
-- SECOND: the reminder line needs the day as well as the time. "{child}
-- has a {lesson} session scheduled on Friday 8:00 AM" cannot be built
-- from {time} alone, and the outer template's {date} is not in scope
-- inside a line. So the preview now passes {day_time} as well, and the
-- older {time}, {pool} and {coach} still work for anybody who has
-- already written their own wording around them.
create or replace function parent_reminder_rows(p_for_date date)
returns table (
  account_id uuid, parent_name text, child text, class_date date,
  start_time time, lesson text, pool text, coach text)
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
     and coalesce(wss.is_replacement, false) is false      -- the exclusion, meant
   order by s.account_id, 4, 5;
$$;

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
             'day_time', to_char(p_for_date, 'FMDay') || ' '
                         || to_char(r.start_time, 'FMHH12:MI AM'),
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
           'notice_hours', st.notice_hours::text,
           'replacement_window_days', st.replacement_window_days::text,
           'child_names', (select string_agg(distinct x.child, ', ') from lines x
                            where x.account_id = l.account_id),
           'class_list',  string_agg(l.line, E'\n' order by l.line)))::text,
         count(*)::int
    from lines l
   group by l.account_id;
end $$;


-- ─── 3. One way in ──────────────────────────────────────────────────────
-- Every message, however it is triggered, arrives through here. The
-- dedupe key is what makes all of this safe to run twice: the same
-- message to the same family is written once, and the second attempt
-- quietly finds it already there.
create or replace function parent_say(
  p_account uuid, p_kind text, p_title text, p_body text, p_key text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_account is null or coalesce(btrim(p_body),'') = '' then return false; end if;
  insert into parent_messages (account_id, kind, title, body, dedupe_key)
  values (p_account, p_kind, p_title, p_body, p_key)
  on conflict (account_id, kind, dedupe_key) where dedupe_key is not null do nothing;
  return found;
end $$;


-- ─── 4. The class reminder, two days out ────────────────────────────────
-- Replaces the version that always meant tomorrow.
create or replace function send_class_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st parent_message_settings;
  v_local timestamp; v_time time; v_for date; v_key text;
  v_sent int := 0; v_skipped int := 0; v_tooclose int := 0;
begin
  select * into st from parent_message_settings where id;
  if st is null or not st.reminders_enabled then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'reminders are switched off');
  end if;

  v_local := (p_now at time zone 'Asia/Kuala_Lumpur');
  v_time  := v_local::time;

  if v_time < st.quiet_start or v_time > st.quiet_end then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'inside quiet hours');
  end if;
  if v_time < st.send_at_time then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'not yet time today');
  end if;

  v_for := (v_local::date) + st.lead_days;
  v_key := 'classes:' || v_for::text;

  -- Count what the floor excludes, so a day that sends nothing says why
  -- rather than looking like a job that did not run.
  select count(*) into v_tooclose
    from parent_reminder_rows(v_for) r
   where (v_for + r.start_time) < v_local + make_interval(hours => st.min_hours_ahead);

  with p as (select * from parent_reminder_preview(v_for)),
  ins as (
    insert into parent_messages (account_id, kind, title, body, dedupe_key)
    select p.account_id, 'reminder', p.title, p.body, v_key from p
    on conflict (account_id, kind, dedupe_key) where dedupe_key is not null do nothing
    returning 1
  )
  select (select count(*) from ins), (select count(*) from p) - (select count(*) from ins)
    into v_sent, v_skipped;

  return jsonb_build_object('ok', true, 'for_date', v_for, 'lead_days', st.lead_days,
                            'sent', v_sent, 'already_had_one', v_skipped,
                            'classes_inside_the_floor', v_tooclose);
end $$;


-- ─── 5. Replacements, which are a different sentence ────────────────────
-- A swimmer placed into a session as a replacement. The session gives
-- the day and the time, which is the whole content of the message.
create or replace function parent_replacement_rows(p_for_date date)
returns table (account_id uuid, parent_name text, child text, lesson text,
               day_time text, session_date date, start_time time)
language sql stable security definer set search_path = public as $$
  select pa.id::uuid,
         coalesce(nullif(btrim(pa.display_name),''), 'there')::text,
         coalesce(nullif(btrim(s.name),''), wss.student_name, 'your swimmer')::text,
         coalesce(lt.name, 'swimming')::text,
         (to_char((ws.week_start_date + (ws.weekday - 1))::date, 'FMDay FMDD FMMonth')
           || ' at ' || to_char((ws.start_minute * interval '1 minute')::time, 'FMHH12:MI AM'))::text,
         (ws.week_start_date + (ws.weekday - 1))::date,
         (ws.start_minute * interval '1 minute')::time
    from weekly_session_students wss
    join weekly_sessions ws on ws.id = wss.session_id
    join students s         on s.id = wss.student_id
    join parent_accounts pa on pa.id = s.account_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where wss.is_replacement is true
     and ws.cancelled_at is null
     and (ws.week_start_date + (ws.weekday - 1))::date = p_for_date;
$$;

create or replace function send_replacement_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st parent_message_settings; r record;
  v_local timestamp; v_for date; v_sent int := 0; v_tooclose int := 0;
begin
  select * into st from parent_message_settings where id;
  if st is null or not st.reminders_enabled or not st.replacement_enabled then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'replacement reminders are switched off');
  end if;

  v_local := (p_now at time zone 'Asia/Kuala_Lumpur');
  if v_local::time < st.quiet_start or v_local::time > st.quiet_end then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'inside quiet hours');
  end if;
  if v_local::time < st.send_at_time then
    return jsonb_build_object('ok', true, 'sent', 0, 'why', 'not yet time today');
  end if;

  v_for := (v_local::date) + st.lead_days;

  for r in select * from parent_replacement_rows(v_for) loop
    -- The floor applies here too. A replacement booked yesterday for
    -- tomorrow has already had its message, at the moment of booking.
    if (r.session_date + r.start_time) < v_local + make_interval(hours => st.min_hours_ahead) then
      v_tooclose := v_tooclose + 1;
      continue;
    end if;
    if parent_say(r.account_id, 'replacement', st.replacement_title,
         parent_render(st.replacement_template, jsonb_build_object(
           'parent_name', r.parent_name, 'child', r.child, 'lesson', r.lesson,
           'day_time', r.day_time, 'centre_name', st.centre_name)),
         'repl-due:' || r.session_date::text || ':' || r.child)
    then v_sent := v_sent + 1; end if;
  end loop;

  return jsonb_build_object('ok', true, 'for_date', v_for, 'sent', v_sent,
                            'inside_the_floor', v_tooclose);
end $$;


-- ─── 6. The moment a replacement is booked ──────────────────────────────
-- Immediate, and deliberately not subject to the floor or the send
-- hour: a parent whose child has been moved needs the new day and time
-- straight away, and a booking made the night before is exactly when
-- that matters most.
create or replace function parent_replacement_booked()
returns trigger language plpgsql security definer set search_path = public as $$
declare st parent_message_settings; r record;
begin
  if coalesce(new.is_replacement, false) is not true then return new; end if;
  select * into st from parent_message_settings where id;
  if st is null or not st.replacement_enabled then return new; end if;

  select * into r from parent_replacement_rows(
    (select (ws.week_start_date + (ws.weekday - 1))::date
       from weekly_sessions ws where ws.id = new.session_id))
   where child is not null limit 1;

  -- Re-read for this row specifically rather than taking the first of
  -- the day: two swimmers can be placed into the same session.
  select pa.id as account_id,
         coalesce(nullif(btrim(pa.display_name),''),'there') as parent_name,
         coalesce(nullif(btrim(s.name),''), new.student_name,'your swimmer') as child,
         coalesce(lt.name,'swimming') as lesson,
         to_char((ws.week_start_date + (ws.weekday - 1))::date,'FMDay FMDD FMMonth')
           || ' at ' || to_char((ws.start_minute * interval '1 minute')::time,'FMHH12:MI AM') as day_time,
         (ws.week_start_date + (ws.weekday - 1))::date as session_date
    into r
    from weekly_sessions ws
    join students s on s.id = new.student_id
    join parent_accounts pa on pa.id = s.account_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where ws.id = new.session_id;

  if r.account_id is null then return new; end if;

  perform parent_say(r.account_id, 'replacement', st.replacement_title,
    parent_render(st.replacement_template, jsonb_build_object(
      'parent_name', r.parent_name, 'child', r.child, 'lesson', r.lesson,
      'day_time', r.day_time, 'centre_name', st.centre_name)),
    'repl-booked:' || new.id::text);
  return new;
end $$;

drop trigger if exists parent_replacement_booked_trg on weekly_session_students;
create trigger parent_replacement_booked_trg
  after insert on weekly_session_students
  for each row when (new.is_replacement is true)
  execute function parent_replacement_booked();


-- ─── 7. Marked absent ───────────────────────────────────────────────────
-- Fires on the transition into 'absent' and not on every save, so
-- correcting a typo in a note does not tell a family twice.
create or replace function parent_marked_absent()
returns trigger language plpgsql security definer set search_path = public as $$
declare st parent_message_settings; r record;
begin
  select * into st from parent_message_settings where id;
  if st is null or not st.absence_enabled then return new; end if;

  select pa.id as account_id,
         coalesce(nullif(btrim(pa.display_name),''),'there') as parent_name,
         coalesce(nullif(btrim(s.name),''), new.student_name,'your swimmer') as child,
         coalesce(lt.name,'swimming') as lesson,
         to_char((ws.start_minute * interval '1 minute')::time,'FMHH12:MI AM') as time
    into r
    from weekly_sessions ws
    join students s on s.id = new.student_id
    join parent_accounts pa on pa.id = s.account_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where ws.id = new.session_id;

  if r.account_id is null then return new; end if;

  perform parent_say(r.account_id, 'absence', st.absence_title,
    parent_render(st.absence_template, jsonb_build_object(
      'parent_name', r.parent_name, 'child', r.child, 'lesson', r.lesson,
      'time', r.time, 'notice_hours', st.notice_hours::text,
      'centre_name', st.centre_name)),
    'absent:' || new.id::text);
  return new;
end $$;

drop trigger if exists parent_marked_absent_trg on weekly_session_students;
create trigger parent_marked_absent_trg
  after update of attendance_status on weekly_session_students
  for each row
  when (new.attendance_status = 'absent' and coalesce(old.attendance_status,'') <> 'absent')
  execute function parent_marked_absent();


-- ─── 8. Payment received ────────────────────────────────────────────────
-- Money in only. A refund is a different conversation and not one to
-- thank somebody for.
create or replace function parent_payment_thanks()
returns trigger language plpgsql security definer set search_path = public as $$
declare st parent_message_settings; v_acct uuid; v_name text;
begin
  if coalesce(new.amount,0) <= 0 then return new; end if;
  select * into st from parent_message_settings where id;
  if st is null or not st.payment_enabled then return new; end if;

  select pa.id, coalesce(nullif(btrim(pa.display_name),''),'there')
    into v_acct, v_name
    from invoices i join parent_accounts pa on pa.id = i.account_id
   where i.id = new.invoice_id;
  if v_acct is null then return new; end if;

  perform parent_say(v_acct, 'payment', st.payment_title,
    parent_render(st.payment_template, jsonb_build_object(
      'parent_name', v_name,
      'amount', 'RM ' || to_char(new.amount, 'FM999999990.00'),
      'receipt_no', coalesce(new.receipt_number, '—'),
      'centre_name', st.centre_name)),
    'paid:' || new.id::text);
  return new;
end $$;

drop trigger if exists parent_payment_thanks_trg on payments;
create trigger parent_payment_thanks_trg
  after insert on payments
  for each row execute function parent_payment_thanks();


-- ─── 9. The outstanding-balance blast, which a person sends ─────────────
-- Not automatic, on purpose. Chasing money is a decision about a
-- particular family at a particular moment, and the office makes it.
-- WHAT COUNTS AS OWED
-- The arithmetic, not the label. An invoice marked 'paid' that has had
-- less than its total paid against it is a contradiction, and leaving
-- those out by status made this disagree with the monthly report, which
-- works from the same two columns. Two screens giving two answers about
-- who owes money is how a family gets chased for a bill they settled.
--
-- A draft is excluded because it is not a bill yet — nobody has been
-- asked for it. Void and refunded are excluded for the obvious reason.
create or replace function outstanding_accounts(p_min numeric default 0.01)
returns table (account_id uuid, parent_name text, phone text, owed numeric, invoices integer)
language sql stable security definer set search_path = public as $$
  select pa.id::uuid,
         coalesce(nullif(btrim(pa.display_name),''),'—')::text,
         coalesce(pa.phone_primary,'')::text,
         sum(greatest(0, coalesce(i.total_amount,0) - coalesce(i.amount_paid,0)))::numeric,
         count(*)::int
    from invoices i
    join parent_accounts pa on pa.id = i.account_id
   where can_write_office()
     and coalesce(i.status,'') not in ('void','refunded','draft')
     and coalesce(i.total_amount,0) - coalesce(i.amount_paid,0) >= 0.005
   group by pa.id
  having sum(greatest(0, coalesce(i.total_amount,0) - coalesce(i.amount_paid,0))) >= p_min
   order by 4 desc;
$$;

-- Takes the accounts the office picked, so what was reviewed on screen
-- is exactly what goes out. A key per month means the same chase is not
-- sent twice in one month by two different people.
create or replace function send_outstanding_reminders(
  p_accounts uuid[], p_title text default null, p_body text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare st parent_message_settings; r record; v_sent int := 0; v_key text;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not your seat to send this.');
  end if;
  select * into st from parent_message_settings where id;
  v_key := 'owing:' || to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM');

  for r in select * from outstanding_accounts(0.01)
            where account_id = any(coalesce(p_accounts, '{}'::uuid[])) loop
    if parent_say(r.account_id, 'outstanding',
         coalesce(nullif(btrim(p_title),''), st.outstanding_title),
         parent_render(coalesce(nullif(btrim(p_body),''), st.outstanding_template),
           jsonb_build_object(
             'parent_name', r.parent_name,
             'amount', 'RM ' || to_char(r.owed, 'FM999999990.00'),
             'invoices', r.invoices::text,
             'centre_name', st.centre_name)),
         v_key)
    then v_sent := v_sent + 1; end if;
  end loop;

  return jsonb_build_object('ok', true, 'sent', v_sent,
                            'asked_for', coalesce(array_length(p_accounts,1),0));
end $$;


-- ─── 10. Locks ──────────────────────────────────────────────────────────
revoke all on function parent_say(uuid,text,text,text,text)     from public, anon;
revoke all on function parent_replacement_rows(date)            from public, anon;
revoke all on function send_replacement_reminders(timestamptz)  from public, anon;
revoke all on function outstanding_accounts(numeric)            from public, anon;
revoke all on function send_outstanding_reminders(uuid[],text,text) from public, anon;
grant execute on function parent_replacement_rows(date)            to authenticated;
grant execute on function send_replacement_reminders(timestamptz)  to authenticated;
grant execute on function outstanding_accounts(numeric)            to authenticated;
grant execute on function send_outstanding_reminders(uuid[],text,text) to authenticated;


-- ─── 11. What is now in place ───────────────────────────────────────────
select thing, detail from (
  select 1 as sort, 'class reminder' as thing,
         case when st.reminders_enabled
              then st.lead_days || ' day' || case when st.lead_days = 1 then '' else 's' end
                   || ' ahead, sent from ' || to_char(st.send_at_time,'FMHH12:MI AM')
                   || ', never inside ' || st.min_hours_ahead || ' hours of the class'
              else 'switched off' end as detail
    from parent_message_settings st where st.id
  union all
  select 2, 'replacement', (select case when replacement_enabled
         then 'on booking, and again ' || lead_days || ' days before' else 'switched off' end
         from parent_message_settings where id)
  union all
  select 3, 'payment received', (select case when payment_enabled then 'automatic, on every receipt' else 'switched off' end
         from parent_message_settings where id)
  union all
  select 4, 'marked absent', (select case when absence_enabled then 'automatic, when a coach marks it' else 'switched off' end
         from parent_message_settings where id)
  union all
  select 5, 'outstanding balances', (select count(*)::text || ' accounts owe something' from outstanding_accounts(0.01))
  union all
  select 6, 'messages in parents'' inboxes', (select count(*)::text from parent_messages)
  union all
  select 7, 'still to do', 'Nothing here runs itself. Schedule send_class_reminders() and '
       || 'send_replacement_reminders() hourly with pg_cron — see the last section of '
       || 'supabase_parent_messages.sql. Both are safe to run as often as you like.'
) z order by sort;
