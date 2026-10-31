-- ════════════════════════════════════════════════════════════════════════
--  The swimmers in front of the coach, and marking them off
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  It creates two functions and changes no data.
--
--  Run supabase_instructor_pool_links.sql first — these read the two
--  columns it adds, and without them every coach sees an empty list.
--
--  WHY A FUNCTION AND NOT A POLICY
--  A coach's phone holds a crew token, and a crew token carries no
--  ssb_role. is_website_login() is false for it, so since Stage A the
--  attendance app cannot read students, weekly_sessions or
--  weekly_session_students at all — not a little, not at all.
--
--  That is correct. An instructor should not be able to read the whole
--  timetable or every family in it. What they should see is the
--  swimmers in the classes they are teaching, which is not a row filter
--  anybody would want to write as a policy — it is a join through
--  shifts, pools, locations, sessions and session_instructors.
--
--  So it is a function, security definer, and the join IS the
--  permission. There is no argument a coach can pass that widens it.
--  It answers only "what am I teaching", so an office seat calling it
--  gets nothing — they have the Session modal for that. What the office
--  does share is mark_attendance, which is their fallback for a class
--  whose coach cannot sign in.
--
--  CREDITS MOVE IN ONE PLACE ONLY
--  The office screen already marks attendance and already moves a credit
--  on pending→attended and pending→absent. mark_attendance does exactly
--  the same arithmetic, and the office screen is moved onto it, because
--  two pieces of code with their own opinion about when a credit moves
--  is how a balance ends up being argued about.
--
--  It also fixes three things that code does quietly:
--    · it does nothing at all when the swimmer has no balance row for
--      that lesson type — no error, no credit, nothing
--    · it floors the balance at zero, so a swimmer attending with none
--      left shows no shortfall
--    · it writes no ledger row, so the balance moves and credit_purchases
--      never records why
--  Here the row is created if missing, the balance may go negative so a
--  shortfall is visible, and every movement is a credit_purchases row
--  with source 'attendance'.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ 0. A coach who is office, not crew ════════════════════════════════
-- Clara teaches and so does Anthony, and neither is a crew record: they
-- reach the attendance app through the office route, which has no crew
-- row and therefore no shifts. Keyed to shifts, the roster would show
-- them nothing at all.
--
-- So a coach on the timetable can point at an office login instead. It
-- is not a second way of being crew — there are no shifts, no clock-in
-- and no geofence — it is only "which classes are this person's". For
-- them the shift window does not apply, because there is no shift; they
-- get the classes they are assigned to, on the days they ask for.
alter table scheduler_instructors
  add column if not exists app_user_id uuid;

create index if not exists scheduler_instructors_app_user_idx
  on scheduler_instructors (app_user_id) where app_user_id is not null;

-- Who marked a swimmer, and when. Worth having now that more than one
-- coach may mark the same class: a squad session with three coaches in
-- the water and one name on the timetable would otherwise leave twenty
-- marks and no way to say who made them.
alter table weekly_session_students
  add column if not exists marked_by_crew_id uuid,
  add column if not exists marked_at timestamptz;

comment on column weekly_session_students.marked_by_crew_id is
  'The coach who last set this swimmer''s attendance. Null where the '
  'office set it, which has its own trail in audit_log.';

comment on column scheduler_instructors.app_user_id is
  'For a coach who is office rather than crew — a Centre Owner or '
  'sysadmin who also teaches. Gives them their class roster without a '
  'crew record. crew_id is the usual link; this is the exception.';

-- Link the ones whose timetable name is exactly an office login's name,
-- and only where one login answers to it.
update scheduler_instructors si
   set app_user_id = u.id
  from app_users u
 where si.app_user_id is null
   and si.crew_id is null
   and coalesce(u.is_active, true)
   and btrim(lower(coalesce(nullif(btrim(u.display_name), ''), u.username)))
       = btrim(lower(si.name))
   and (select count(*) from app_users x
         where coalesce(x.is_active, true)
           and btrim(lower(coalesce(nullif(btrim(x.display_name), ''), x.username)))
               = btrim(lower(si.name))) = 1;


-- ═══ 0b. May this coach mark this class? ════════════════════════════════
-- Being named on the session is one way. Standing beside the water while
-- it runs is the other, and it is the honest one: a squad session may
-- have three coaches in it and room on the timetable for one name, and
-- the two who are not named are no less there.
--
-- The geometry is deliberately the same as the roster view above, so
-- what a coach can see is what a coach can mark. Anything else produces
-- a card on the screen that refuses when tapped, which reads as a fault.
--
-- This widens who may mark. It does not widen what is recorded: every
-- mark now carries the crew id of whoever made it.
create or replace function coach_can_mark_session(p_session_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid; v_named boolean; v_there boolean;
begin
  v_me := attendance_my_crew_id();
  if v_me is null or p_session_id is null then return false; end if;

  select exists (
    select 1 from session_instructors si
      join scheduler_instructors sc on sc.id = si.instructor_id
     where si.session_id = p_session_id and sc.crew_id = v_me
  ) into v_named;
  if coalesce(v_named, false) then return true; end if;

  -- Rostered to the water this class is in, at the hour it runs, on a
  -- week somebody has published.
  select exists (
    select 1
      from weekly_sessions ws
      join pools p  on p.id = ws.pool_id
      join shifts s on s.location_id = p.location_id
     where ws.id = p_session_id
       and s.crew_id = v_me
       and not s.is_void
       and roster_week_is_live(s.shift_date)
       and s.shift_date = (ws.week_start_date + (ws.weekday - 1))::date
       and (ws.start_minute * interval '1 minute')::time >= s.start_time
       and (ws.start_minute * interval '1 minute')::time <  s.end_time
  ) into v_there;

  return coalesce(v_there, false);
end $$;

comment on function coach_can_mark_session(uuid) is
  'True where the coach is named on the session, or is rostered to that '
  'pool''s location while the session runs. The second is what makes a '
  'three-coach squad session markable by all three.';


-- ═══ 1. What this coach is teaching, and who is in it ═══════════════════
-- One row per swimmer. A class with nobody in it still returns one row,
-- with the student columns null, so an empty class is visibly empty
-- rather than missing.
--
-- WHEN A CLASS HAPPENS
-- week_start_date is the Monday, and weekday counts from 1 for Monday,
-- not from 0. The app writes it as day + 1 and reads it back as
-- weekday - 1; this has to subtract the same 1 or every class lands a
-- day late and no shift ever covers one. That is not hypothetical: it
-- is what the first roster of real shifts found, nine windows and not
-- one class in any of them.
-- The return type gains a column, and create-or-replace cannot do that,
-- so it is dropped first. Safe: nothing depends on it but the app.
drop function if exists get_my_session_roster(date, date, boolean);

create or replace function get_my_session_roster(
  p_from date,
  p_to   date,
  p_include_others boolean default false
)
returns table (
  session_id      uuid,
  session_date    date,
  start_time      time,
  end_time        time,
  pool_name       text,
  lesson_type     text,
  coach_names     text,
  is_mine         boolean,
  is_cancelled    boolean,
  row_id          uuid,
  student_id      uuid,
  student_name    text,
  is_replacement  boolean,
  replacement_from text,
  attendance_status text,
  remark          text,
  -- What is left for this class's lesson type. Negative means a class
  -- already owed. The coach marks them either way; they just see it.
  credits_left    numeric,
  -- Who marked this swimmer. Shown because a squad session may have
  -- three coaches marking into it, and "already marked" is a different
  -- thing from "already marked by me".
  marked_by       text,
  -- Whether it was this coach. The note pad is offered on exactly this,
  -- because it is exactly what can_note_on_student will accept.
  marked_by_me    boolean
)
language plpgsql stable security definer set search_path = public
as $$
declare v_me uuid; v_uid text; v_inst uuid;
begin
  v_me := attendance_my_crew_id();

  -- An office seat that teaches: resolved through app_user_id instead,
  -- and with no shift window, because they have no shifts.
  if v_me is null then
    begin
      v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
    exception when others then
      v_uid := null;
    end;
    if v_uid is not null then
      select si.id into v_inst
        from scheduler_instructors si
       where si.app_user_id = v_uid::uuid
         and si.is_active is not false
       limit 1;
    end if;
    if v_inst is null then
      return;   -- not a coach at all; the Session modal is their screen
    end if;
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    return;
  end if;
  -- A coach asks for a week. Anything wider is not a screen, it is a
  -- download of the centre.
  if p_to - p_from > 31 then
    return;
  end if;

  return query
  with my_shifts as (
    select s.id, s.shift_date, s.start_time, s.end_time, s.location_id
      from shifts s
     where s.crew_id = v_me
       and s.is_void = false
       -- A draft week is a roster nobody has been asked to work yet, so
       -- it puts no coach beside any water. See
       -- supabase_roster_draft_live.sql.
       and roster_week_is_live(s.shift_date)
       and s.shift_date between p_from and p_to
  ),
  -- Crew: every class in the water they are standing beside, during the
  -- hours they are rostered for. Office coach: no shift to stand in, so
  -- the classes they are assigned to in the range, and nothing else —
  -- there is no "others at this pool" for somebody who is not at a pool.
  overlapping as (
    select distinct
           ws.id                                            as session_id,
           (ws.week_start_date + (ws.weekday - 1))::date          as session_date,
           (ws.start_minute * interval '1 minute')::time    as start_time,
           ((ws.start_minute + coalesce(ws.duration_minutes, 60))
              * interval '1 minute')::time                  as end_time,
           p.name::text                                     as pool_name,
           coalesce(lt.name, '—')::text                     as lesson_type,
           ws.cancelled_at is not null                      as is_cancelled
      from my_shifts sh
      join pools p                      on p.location_id = sh.location_id
      join weekly_sessions ws           on ws.pool_id = p.id
                                       and (ws.week_start_date + (ws.weekday - 1))::date = sh.shift_date
      left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
     where v_me is not null
       and (ws.start_minute * interval '1 minute')::time >= sh.start_time
       and (ws.start_minute * interval '1 minute')::time <  sh.end_time

    union

    select distinct
           ws.id,
           (ws.week_start_date + (ws.weekday - 1))::date,
           (ws.start_minute * interval '1 minute')::time,
           ((ws.start_minute + coalesce(ws.duration_minutes, 60))
              * interval '1 minute')::time,
           p.name::text,
           coalesce(lt.name, '—')::text,
           ws.cancelled_at is not null
      from weekly_sessions ws
      join session_instructors si        on si.session_id = ws.id
      join pools p                       on p.id = ws.pool_id
      left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
     where v_inst is not null
       and si.instructor_id = v_inst
       and (ws.week_start_date + (ws.weekday - 1))::date between p_from and p_to
  ),
  -- Aliased to sid on purpose: session_id is also one of this
  -- function's out parameters, and an unqualified reference to it
  -- inside the body is ambiguous between the two.
  mine as (
    select o.session_id as sid
      from overlapping o
      join session_instructors si      on si.session_id = o.session_id
      join scheduler_instructors sc    on sc.id = si.instructor_id
     where (v_me is not null and sc.crew_id = v_me)
        or (v_inst is not null and sc.id = v_inst)
  )
  select o.session_id, o.session_date, o.start_time, o.end_time,
         o.pool_name, o.lesson_type,
         coalesce((select string_agg(sc2.name, ', ' order by sc2.name)
                     from session_instructors si2
                     join scheduler_instructors sc2 on sc2.id = si2.instructor_id
                    where si2.session_id = o.session_id), '—')::text,
         (o.session_id in (select sid from mine)),
         o.is_cancelled,
         wss.id, wss.student_id, wss.student_name::text,
         coalesce(wss.is_replacement, false),
         wss.replacement_from::text,
         coalesce(wss.attendance_status, 'pending')::text,
         wss.remark::text,
         bal.remaining_balance,
         mk.full_name::text,
         (wss.marked_by_crew_id is not null and wss.marked_by_crew_id = v_me)
    from overlapping o
    left join weekly_session_students wss on wss.session_id = o.session_id
    left join weekly_sessions ws2         on ws2.id = o.session_id
    left join student_credit_balances bal on bal.student_id = wss.student_id
                                         and bal.lesson_type_id = ws2.lesson_type_id
    left join admin_employees mk          on mk.id = wss.marked_by_crew_id
   where p_include_others
      or o.session_id in (select sid from mine)
   order by o.session_date, o.start_time, o.pool_name,
            coalesce(wss.is_replacement, false), wss.student_name;
end $$;

comment on function get_my_session_roster(date, date, boolean) is
  'The classes a coach is assigned to inside their rostered shifts, and '
  'the swimmers in them. With p_include_others, every class in the same '
  'water during the same hours — for cover.';


-- ═══ 2. Marking one swimmer ═════════════════════════════════════════════
-- attended and absent both consume a credit; pending consumes none.
-- Moving between attended and absent moves no credit, because one has
-- already been taken. That is the rule the office screen already
-- applies, written once here instead of twice.
-- Dropped first, not replaced: adding a parameter with a default makes
-- a second function rather than changing this one, and then every
-- two-argument call is ambiguous between them and fails.
drop function if exists mark_attendance(uuid, text);

-- p_confirm: the caller has seen the no-credit warning and is marking
-- anyway. Without it, a swimmer with nothing left comes back as a
-- question rather than a deduction — see supabase_class_credit_policy.sql.
create or replace function mark_attendance(
  p_row_id uuid, p_state text, p_confirm boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  st          class_policy_settings;
  v_before    numeric;
  v_child     text;
  v_me        uuid;
  v_office    boolean;
  v_old       text;
  v_sid       uuid;
  v_session   uuid;
  v_lt        uuid;
  v_date      date;
  v_cancelled boolean;
  v_mine      boolean;
  v_delta     int;
  v_moved     int := 0;
  v_bal       numeric;
  v_who       text;
begin
  if p_state not in ('pending', 'attended', 'absent') then
    return jsonb_build_object('ok', false, 'error', 'Not a state this can be set to.');
  end if;

  v_me     := attendance_my_crew_id();
  v_office := can_write_office();
  if v_me is null and not v_office then
    return jsonb_build_object('ok', false, 'error', 'Not signed in to mark anybody.');
  end if;

  select wss.attendance_status, wss.student_id, wss.session_id,
         ws.lesson_type_id, (ws.week_start_date + (ws.weekday - 1))::date,
         ws.cancelled_at is not null
    into v_old, v_sid, v_session, v_lt, v_date, v_cancelled
    from weekly_session_students wss
    join weekly_sessions ws on ws.id = wss.session_id
   where wss.id = p_row_id;

  if v_session is null then
    return jsonb_build_object('ok', false, 'error', 'That swimmer is no longer in this class.');
  end if;
  if v_cancelled then
    return jsonb_build_object('ok', false,
      'error', 'This class is cancelled. Nobody is marked and no credit moves.');
  end if;

  -- A coach may mark a class they are named on, or one running in water
  -- they are rostered to at that hour — see coach_can_mark_session. And
  -- only on the day it happened: after midnight it is the office's to
  -- correct, so that a mistake reaches somebody rather than being
  -- quietly rewritten a week later.
  if not v_office then
    v_mine := coach_can_mark_session(v_session);
    if not coalesce(v_mine, false) then
      return jsonb_build_object('ok', false,
        'error', 'You are not rostered to this class.');
    end if;
    if v_date <> (now() at time zone 'Asia/Kuala_Lumpur')::date then
      return jsonb_build_object('ok', false,
        'error', case when v_date > (now() at time zone 'Asia/Kuala_Lumpur')::date
                      then 'This class has not happened yet.'
                      else 'That day has closed. Ask the office to change it.' end);
    end if;
  end if;

  v_old := coalesce(v_old, 'pending');
  if v_old = p_state then
    return jsonb_build_object('ok', true, 'state', p_state, 'credit_moved', 0);
  end if;

  -- ── The no-credit question ──
  -- Asked whether or not the centre allows a balance below nil: a
  -- swimmer in the water who has not paid is the same fact either way,
  -- and the person marking them is the one placed to say something.
  select * into st from class_policy_settings where id;
  if v_old = 'pending' and p_state in ('attended', 'absent')
     and v_sid is not null and v_lt is not null then
    select coalesce(b.remaining_balance, 0) into v_before
      from student_credit_balances b
     where b.student_id = v_sid and b.lesson_type_id = v_lt;
    v_before := coalesce(v_before, 0);

    if v_before <= 0 and not coalesce(p_confirm, false) then
      select wss.student_name into v_child
        from weekly_session_students wss where wss.id = p_row_id;
      return jsonb_build_object(
        'ok', false, 'needs_confirm', true,
        'balance', v_before,
        'child', coalesce(v_child, 'This swimmer'),
        'allow_negative', coalesce(st.allow_negative_credits, true),
        'error', coalesce(v_child, 'This swimmer')
          || (case when v_before = 0 then ' has no credits left.'
                   else ' is already ' || abs(v_before) || ' class'
                        || (case when abs(v_before) = 1 then '' else 'es' end)
                        || ' in arrears.' end)
          || ' Billing or a renewal is needed.'
          || (case when coalesce(st.allow_negative_credits, true)
                   then ' Marking them records the class as unpaid.'
                   else ' Marking them records the class as unpaid; the balance stays at nil.' end));
    end if;
  end if;

  -- attended and absent both consume; pending does not.
  v_delta := case
    when v_old = 'pending' and p_state in ('attended','absent') then -1
    when v_old in ('attended','absent') and p_state = 'pending'  then  1
    else 0 end;

  update weekly_session_students
     set attendance_status = p_state,
         marked_by_crew_id = v_me,          -- null when the office marked it
         marked_at = now()
   where id = p_row_id;

  if v_delta <> 0 and v_sid is not null and v_lt is not null then
    -- The ledger first, because it is the record. The balance is a cache
    -- of it, and a cache that moves without the record behind it is how
    -- nobody can say why a swimmer is short a class.
    --
    -- A class taken with nothing in hand is written as attendance_unpaid
    -- rather than attendance, so the defaulters report can find it
    -- whichever way the negative-balance rule is set.
    insert into credit_purchases
      (student_id, lesson_type_id, purchase_date, credits_added, source, notes)
    values
      (v_sid, v_lt, v_date,
       -- With negatives switched off the balance does not move, so the
       -- ledger must not claim it did, or the two drift apart and
       -- nobody can say which is right.
       case when v_delta < 0 and coalesce(v_before, 1) <= 0
                 and not coalesce(st.allow_negative_credits, true)
            then 0 else v_delta end,
       case when v_delta < 0 and coalesce(v_before, 1) <= 0
            then 'attendance_unpaid' else 'attendance' end,
       case when v_delta < 0 then 'Marked ' || p_state else 'Un-marked, was ' || v_old end);

    -- Whether a balance may go below nil is the centre's rule. Allowed,
    -- it reads −1 and the office sees a class owed. Not allowed, it
    -- stops at nil and the unpaid class is counted in the ledger
    -- instead — the debt is recorded either way, only differently.
    insert into student_credit_balances
      (student_id, lesson_type_id, initial_balance, remaining_balance)
    values (v_sid, v_lt, 0,
            case when v_delta < 0 and not coalesce(st.allow_negative_credits, true)
                 then 0 else v_delta end)
    on conflict (student_id, lesson_type_id) do update
      set remaining_balance =
            case when not coalesce(st.allow_negative_credits, true)
                 then greatest(0, student_credit_balances.remaining_balance + v_delta)
                 else student_credit_balances.remaining_balance + v_delta end,
          updated_at = now();

    select remaining_balance into v_bal
      from student_credit_balances
     where student_id = v_sid and lesson_type_id = v_lt;

    v_moved := case when v_delta < 0 and coalesce(v_before, 1) <= 0
                         and not coalesce(st.allow_negative_credits, true)
                    then 0 else v_delta end;
  end if;

  -- The phone patches its row rather than refetching the week after
  -- every tap, so the name has to come back with the answer or a squad
  -- session shows "marked" with no idea by whom until the next load.
  if v_me is not null then
    select e.full_name into v_who from admin_employees e where e.id = v_me;
  end if;

  -- What actually moved, not what was intended. With negatives switched
  -- off the balance holds at nil, and saying a credit was taken when
  -- none was is how a coach and the office end up with two different
  -- accounts of the same class.
  return jsonb_build_object('ok', true, 'state', p_state,
                            'credit_moved', v_moved,
                            -- Taken with nothing in hand. True whichever
                            -- way the negative rule is set: the class was
                            -- unpaid either way, and only the balance
                            -- behaves differently. Matches the ledger row.
                            'unpaid', (v_delta < 0 and coalesce(v_before, 1) <= 0),
                            'balance', v_bal,
                            'marked_by', case when p_state = 'pending' then null else v_who end);
end $$;

comment on function mark_attendance(uuid, text, boolean) is
  'The only place an attendance credit moves. attended and absent each '
  'consume one; returning to pending gives it back. Writes the ledger '
  'row as well as the balance, and lets the balance go negative.';


-- ═══ 3. Cancelling a class from poolside ════════════════════════════════
-- Nobody is marked and no credit moves for a class that did not happen.
-- Reversible on the same day, by the same coach, for the same reason a
-- mis-tap should be.
create or replace function set_session_cancelled(p_session_id uuid, p_cancelled boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid; v_office boolean; v_mine boolean; v_date date; v_reason text;
begin
  v_me := attendance_my_crew_id();
  v_office := can_write_office();
  if v_me is null and not v_office then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;

  select (ws.week_start_date + (ws.weekday - 1))::date, ws.cancelled_reason
    into v_date, v_reason
    from weekly_sessions ws where ws.id = p_session_id;
  if v_date is null then
    return jsonb_build_object('ok', false, 'error', 'No such class.');
  end if;

  -- A class cancelled because it was forwarded or rescheduled is the
  -- office's business, and a coach undoing one from poolside would
  -- resurrect a class that was deliberately moved.
  if v_reason is not null and v_reason <> 'not_held' and not v_office then
    return jsonb_build_object('ok', false,
      'error', 'This class was moved by the office. Speak to them.');
  end if;

  -- The same rule as marking. A coach who may mark the swimmers may say
  -- the class did not happen; splitting the two would mean standing at a
  -- cancelled poolside able to do neither one thing nor the other.
  if not v_office then
    v_mine := coach_can_mark_session(p_session_id);
    if not coalesce(v_mine, false) then
      return jsonb_build_object('ok', false,
        'error', 'You are not rostered to this class.');
    end if;
    if v_date <> (now() at time zone 'Asia/Kuala_Lumpur')::date then
      return jsonb_build_object('ok', false, 'error', 'Only today''s class can be marked.');
    end if;
  end if;

  if p_cancelled then
    -- Anything already marked gives its credit back: the class did not
    -- happen, so nobody consumed anything.
    perform mark_attendance(wss.id, 'pending')
       from weekly_session_students wss
      where wss.session_id = p_session_id
        and coalesce(wss.attendance_status, 'pending') <> 'pending';
    update weekly_sessions
       set cancelled_at = now(), cancelled_reason = 'not_held'
     where id = p_session_id;
  else
    update weekly_sessions
       set cancelled_at = null, cancelled_reason = null
     where id = p_session_id and cancelled_reason = 'not_held';
  end if;

  return jsonb_build_object('ok', true, 'cancelled', p_cancelled);
end $$;


revoke all on function coach_can_mark_session(uuid)                  from public, anon;
grant execute on function coach_can_mark_session(uuid)               to authenticated;
revoke all on function get_my_session_roster(date, date, boolean) from public, anon;
revoke all on function mark_attendance(uuid, text, boolean)       from public, anon;
revoke all on function set_session_cancelled(uuid, boolean)       from public, anon;
grant execute on function get_my_session_roster(date, date, boolean) to authenticated;
grant execute on function mark_attendance(uuid, text, boolean)       to authenticated;
grant execute on function set_session_cancelled(uuid, boolean)       to authenticated;


-- ═══ Confirm ════════════════════════════════════════════════════════════
select 'coaches linked to a crew record' as thing, count(*) as n
  from scheduler_instructors where crew_id is not null
union all
select 'of those, able to sign in', count(*)
  from scheduler_instructors si join admin_employees e on e.id = si.crew_id
 where e.auth_user_id is not null
union all
select 'pools linked to a location', count(*) from pools where location_id is not null
union all
select 'shifts on the roster right now', count(*) from shifts where is_void = false
order by 1;
