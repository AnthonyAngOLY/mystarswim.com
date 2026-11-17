-- ════════════════════════════════════════════════════════════════════════
--  Correcting an absence: the notice, and the parent's way of disputing one
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  creates NO TABLE — two columns on parent_messages, three on
--  parent_message_settings, one trigger and one function — so it needs
--  no RLS guard beside it. The policies on both tables already cover
--  every column, including ones added later.
--
--  Run this BEFORE deploying the app changes. The parent app's new
--  button calls flag_message(), and the office screen reads flagged_at;
--  both fail quietly against a database that has neither. The other way
--  round is harmless: this file on its own sends correction notices and
--  simply has nobody flagging anything yet.
--
--  WHY
--  A coach marks a swimmer absent. The parent is told, automatically,
--  within the minute. If the mark was wrong — the family had arranged a
--  replacement and the scheduler was never updated — three things have
--  to happen, and only the first of them worked before now.
--
--    The credit comes back. It already did: mark_attendance moves it
--    both ways and writes the ledger either way. Nothing here changes
--    that.
--
--    The parent is told it was corrected. They were not. The absence
--    notice sat in their inbox with nothing after it, because the only
--    message the system knew how to send about an absence was the one
--    announcing it. That is what the trigger below is for.
--
--    The parent can say it is wrong. They could not. The notice was a
--    statement with no reply to it, so a family who disagreed had to
--    telephone, and the ones who do not telephone simply believe the
--    centre has their attendance wrong. flag_message() is one tap
--    against that.
--
--  WHY A SEPARATE KIND AND KEY
--  parent_say refuses a second message with the same (account, kind,
--  dedupe_key). The absence notice holds 'absent:<row>' under kind
--  'absence'. A correction written as another 'absence' with the same
--  key would be silently dropped — the family would be told they missed
--  a class and never told they had not. So: kind 'correction', key
--  'corrected:<row>'. One correction per row, which is right: a mark
--  flipped back and forth is an office problem, not four messages.
--
--  WHAT THE TRIGGER DOES NOT DO
--  It fires on leaving 'absent', whatever the new mark is — corrected
--  to attended, or returned to pending for a replacement to be booked.
--  It does not fire when a class is cancelled, because mark_attendance
--  refuses to touch a cancelled class at all and the family is told
--  about a cancellation by a different route.
--
--  ONE STATEMENT
--  The SQL editor shows the result of the last statement only, so the
--  confirmation at the end is a single select.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. A correction is its own kind of message ─────────────────────────
do $$
begin
  alter table parent_messages drop constraint if exists parent_messages_kind_check;
  alter table parent_messages add constraint parent_messages_kind_check
    check (kind in ('reminder','announcement','replacement','payment',
                    'absence','outstanding','correction'));
end $$;

-- ─── 2. What the office decides about corrections ───────────────────────
alter table parent_message_settings
  add column if not exists correction_enabled boolean not null default true,
  add column if not exists correction_title   text not null
      default 'That absence has been corrected',
  add column if not exists correction_template text not null default
    'Hi {parent_name}, we have corrected our records: {child} is no longer '
 || 'marked absent from the {time} {lesson} class. Any class credit taken '
 || 'for it has been returned. Our apologies for the confusion, and thank '
 || 'you for your patience. — {centre_name}';

-- ─── 3. The parent's "this isn't right" ─────────────────────────────────
-- On the message rather than in a table of its own: a dispute is about
-- one message, it is answered by a person, and a table would need a
-- lifecycle nobody asked for.
alter table parent_messages
  add column if not exists flagged_at timestamptz,
  add column if not exists flag_note  text;

create index if not exists parent_messages_flagged_idx
  on parent_messages (flagged_at desc) where flagged_at is not null;

comment on column parent_messages.flagged_at is
  'When the parent said this message was wrong. Null is the normal case: '
  'silence means settled, and only the exceptions need anybody''s time.';

-- ─── 4. Telling the family it was corrected ─────────────────────────────
create or replace function parent_mark_corrected()
returns trigger language plpgsql security definer set search_path = public as $$
declare st parent_message_settings; r record;
begin
  select * into st from parent_message_settings where id;
  if st is null or not st.correction_enabled then return new; end if;

  -- Only worth saying if they were told about the absence in the first
  -- place. Correcting a mark nobody was notified of just confuses.
  if not exists (
    select 1 from parent_messages m
     join students s2 on s2.id = new.student_id
    where m.kind = 'absence'
      and m.dedupe_key = 'absent:' || new.id::text
      and m.account_id = s2.account_id
  ) then
    return new;
  end if;

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

  perform parent_say(r.account_id, 'correction', st.correction_title,
    parent_render(st.correction_template, jsonb_build_object(
      'parent_name', r.parent_name, 'child', r.child, 'lesson', r.lesson,
      'time', r.time, 'centre_name', st.centre_name)),
    'corrected:' || new.id::text);

  return new;
end $$;

drop trigger if exists parent_mark_corrected_trg on weekly_session_students;
create trigger parent_mark_corrected_trg
  after update of attendance_status on weekly_session_students
  for each row
  when (coalesce(old.attendance_status,'') = 'absent'
        and coalesce(new.attendance_status,'') <> 'absent')
  execute function parent_mark_corrected();

-- ─── 5. One tap to say it is wrong ──────────────────────────────────────
-- Definer, like mark_message_read, and for the same reason: a parent
-- may set this one field on their own message and nothing else. An
-- update policy would let them rewrite the body of a message the centre
-- sent them.
create or replace function flag_message(p_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acct uuid;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;

  update parent_messages
     set flagged_at = coalesce(flagged_at, now()),
         flag_note  = coalesce(nullif(btrim(p_note),''), flag_note)
   where id = p_id and account_id = v_acct;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such message.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function unflag_message(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acct uuid;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  update parent_messages set flagged_at = null, flag_note = null
   where id = p_id and account_id = v_acct;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such message.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function flag_message(uuid, text) from public, anon;
revoke all on function unflag_message(uuid)     from public, anon;
grant execute on function flag_message(uuid, text) to authenticated;
grant execute on function unflag_message(uuid)     to authenticated;

-- ─── 6. The inbox has to be able to see the flag ────────────────────────
-- my_messages gains a trailing flagged_at. Postgres will not replace a
-- function whose OUT columns change, so this is a drop and a create —
-- the one moment the published contract is broken on purpose.
--
-- It is safe to do now and would not be later. A PostgREST client reads
-- a row as JSON and ignores keys it does not know, so a phone running
-- the old build keeps working; but between the drop and the create the
-- function does not exist, and a call landing in that gap fails. With
-- no parents onboarded there is nobody in that gap. The same change
-- after launch would need the column added some other way.
--
-- Trailing, and nothing removed or reordered, so the old build reads
-- every field it already knew in the place it already knew it.
drop function if exists my_messages(integer);
create or replace function my_messages(p_limit integer default 50)
returns table (id uuid, kind text, title text, body text,
               created_at timestamptz, read_at timestamptz,
               flagged_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.kind, m.title, m.body, m.created_at, m.read_at, m.flagged_at
    from parent_messages m
   where m.account_id = my_parent_account_id()
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function my_messages(integer) from public, anon;
grant execute on function my_messages(integer) to authenticated;


-- ─── 7. What is now in place ────────────────────────────────────────────
select z.thing, z.detail
  from (
  select 1 k, 'correction notice' as thing,
         (select case when correction_enabled
                      then 'on — sent when a mark leaves ''absent'', but only '
                        || 'to families who were told about the absence'
                      else 'switched off' end
            from parent_message_settings where id) as detail
  union all
  select 2, 'the message they will get',
         (select correction_title from parent_message_settings where id)
  union all
  select 3, 'absences notified so far',
         (select count(*)::text from parent_messages where kind = 'absence')
      || ' — each one can now be followed by a correction'
  union all
  select 4, 'corrections sent so far',
         (select count(*)::text from parent_messages where kind = 'correction')
  union all
  select 5, 'messages flagged by a parent',
         (select count(*)::text from parent_messages where flagged_at is not null)
      || ' — none until the parent app ships the button'
  union all
  select 6, 'read receipts already held',
         (select count(*)::text from parent_messages where read_at is not null)
      || ' of ' || (select count(*)::text from parent_messages)
      || ' messages have been opened. That was always recorded; the office '
      || 'screen just never showed it.'
  union all
  select 8, 'still to do',
         'The office correction screen and the parent''s button ship with '
      || 'the app build. Until then this file sends correction notices for '
      || 'marks changed any other way, and nothing can be flagged yet.'
  ) z
 order by z.k;
