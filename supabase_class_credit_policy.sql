-- ════════════════════════════════════════════════════════════════════════
--  Credits and classes: the rules, written down
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Two tables created if missing, several functions
--  replaced, and one backfill that counts what already happened. Nothing
--  is deleted.
--
--  WHAT THIS IS FOR
--  Three rules the centre has been carrying in its head:
--    - whether a missed class may be replaced, and with how much notice
--    - how often a family may call it an emergency before that stops
--      being an emergency
--    - whether a swimmer may attend a class they have not paid for, and
--      what happens when they do
--
--  WHY REPLACEMENTS NEEDED A RECORD BEFORE THEY NEEDED A POLICY
--  Marking a swimmer for replacement deleted their row from the class
--  and wrote a pending row; placing them deleted the pending row too.
--  What survived was one row flagged is_replacement. Nowhere was it
--  written down that a request had been made, by whom, or when — so
--  there was nothing to measure a 24-hour rule against, and nothing to
--  count.
--
--  replacement_requests is that record. It is written when the request
--  is made and kept when the request is fulfilled, cancelled or
--  abandoned. Voided, never deleted.
--
--  THE CLOCK STARTS WHEN THE PARENT TOLD US
--  Not when the office typed it in. The form fills requested_at with
--  the current time, which is right nearly always, and the office
--  corrects it when entering yesterday's phone call. Measuring from the
--  keystroke instead would make the tracker a measure of how promptly
--  the office does its paperwork, and would mark a family who gave a
--  week's notice as an emergency because the note sat in a diary.
--
--  WHAT CANNOT BE BACKDATED
--  Notice was never recorded, so no past replacement can be sorted into
--  emergency or planned. The backfill at the end counts what is real —
--  how many replacements each swimmer has had, and how many classes
--  they have had altogether — and leaves the emergency count at zero
--  with a date from which it is being measured. A rate invented from
--  nothing would be worse than no rate, because somebody would act on
--  it.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The rules ───────────────────────────────────────────────────────
create table if not exists class_policy_settings (
  id boolean primary key default true check (id),

  -- ── Replacements ──
  replacements_enabled boolean not null default true,
  -- Notice at or above this is ordinary; below it is an emergency.
  replacement_notice_hours integer not null default 24
    check (replacement_notice_hours between 0 and 336),
  -- A swimmer calling it an emergency more often than this is, on the
  -- centre's own reading, not having emergencies. Recorded now and
  -- reported on; it refuses nothing until enforce_emergency_limit is on.
  emergency_rate_limit numeric not null default 0.25
    check (emergency_rate_limit > 0 and emergency_rate_limit <= 1),
  enforce_emergency_limit boolean not null default false,
  -- Below this many classes the rate means nothing: one emergency out of
  -- two lessons is 50% and tells you only that they are new.
  emergency_min_classes integer not null default 8 check (emergency_min_classes >= 0),

  -- ── Credits ──
  -- Whether a swimmer's balance may go below zero. Off does not refuse
  -- the attendance — the child was in the water — it stops the balance
  -- at nil and records the class as unpaid instead.
  allow_negative_credits boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by text
);

insert into class_policy_settings (id) values (true) on conflict (id) do nothing;

comment on table class_policy_settings is
  'One row. The centre''s rules about replacements and credits, in the '
  'one place the office can change them.';


-- ─── 2. A replacement request, as a thing that happened ─────────────────
create table if not exists replacement_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  lesson_type_id uuid,

  -- The class being missed.
  original_session_id uuid,
  original_label text,
  original_class_at timestamptz,

  -- When the parent told us. Not when this row was written.
  requested_at timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),
  recorded_by  text,

  -- Settled at the moment of writing, against the policy of that moment,
  -- so changing the rule later does not rewrite history.
  notice_hours numeric,
  is_emergency boolean not null default false,
  policy_hours integer,

  status text not null default 'pending'
         check (status in ('pending','placed','cancelled','expired')),
  placed_session_id uuid,
  placed_at timestamptz,

  is_void boolean not null default false,
  voided_at timestamptz,
  voided_by text,
  void_reason text
);

create index if not exists repl_req_student_idx
  on replacement_requests (student_id, requested_at desc) where not is_void;
create index if not exists repl_req_open_idx
  on replacement_requests (student_id, lesson_type_id)
  where status = 'pending' and not is_void;

comment on column replacement_requests.requested_at is
  'When the parent told us, which is what the notice rule measures. The '
  'form defaults it to now; the office corrects it when entering a call '
  'from yesterday.';
comment on column replacement_requests.is_emergency is
  'Settled when the row is written, against the notice rule as it stood '
  'then. Changing the rule does not re-label what already happened.';


-- ─── 3. Making a request ────────────────────────────────────────────────
-- Called before the swimmer is moved out of the class. It settles the
-- notice against the rule as it stands now, refuses if replacements are
-- switched off, and refuses a swimmer over the emergency limit only when
-- the centre has turned that rule on.
create or replace function request_replacement(
  p_student_id    uuid,
  p_session_id    uuid,
  p_requested_at  timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st        class_policy_settings;
  v_who     text;
  v_lt      uuid;
  v_label   text;
  v_at      timestamptz;
  v_notice  numeric;
  v_emerg   boolean;
  v_id      uuid;
  v_rate    numeric;
  v_classes int;
  v_emcount int;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Replacements are handled by the office.');
  end if;
  select * into st from class_policy_settings where id;
  if st is null then
    return jsonb_build_object('ok', false, 'error', 'No class policy is set up.');
  end if;
  if not st.replacements_enabled then
    return jsonb_build_object('ok', false,
      'error', 'Class replacements are switched off in Settings.');
  end if;

  select ws.lesson_type_id,
         to_char((ws.week_start_date + (ws.weekday - 1))::date, 'Dy DD Mon')
           || ' ' || to_char((ws.start_minute * interval '1 minute'), 'HH24:MI'),
         ((ws.week_start_date + (ws.weekday - 1))::date
            + (ws.start_minute * interval '1 minute')) at time zone 'Asia/Kuala_Lumpur'
    into v_lt, v_label, v_at
    from weekly_sessions ws where ws.id = p_session_id;

  if v_at is null then
    return jsonb_build_object('ok', false, 'error', 'No such class.');
  end if;

  -- Notice is measured from when the parent told us to when the class
  -- starts. Negative means they told us after it had already run.
  v_notice := round(extract(epoch from (v_at - p_requested_at)) / 3600.0, 2);
  v_emerg  := v_notice < st.replacement_notice_hours;

  -- The limit bites only once the centre switches it on, and never on a
  -- swimmer with too little history for the rate to mean anything.
  if v_emerg and st.enforce_emergency_limit then
    select classes, emergency_replacements, emergency_rate
      into v_classes, v_emcount, v_rate
      from replacement_tracker(p_student_id) limit 1;
    if coalesce(v_classes, 0) >= st.emergency_min_classes
       and coalesce(v_rate, 0) >= st.emergency_rate_limit then
      return jsonb_build_object('ok', false, 'over_limit', true,
        'rate', v_rate, 'limit', st.emergency_rate_limit,
        'error', 'This swimmer has asked for a last-minute replacement '
                 || coalesce(v_emcount, 0) || ' times in ' || coalesce(v_classes, 0)
                 || ' classes, which is over the centre''s limit. '
                 || 'This absence counts as an absence.');
    end if;
  end if;

  select coalesce(nullif(btrim(coalesce(
           (select e.full_name from admin_employees e
             where e.id = attendance_my_crew_id()), '')), ''), 'the office')
    into v_who;

  insert into replacement_requests
    (student_id, lesson_type_id, original_session_id, original_label,
     original_class_at, requested_at, recorded_by, notice_hours,
     is_emergency, policy_hours)
  values
    (p_student_id, v_lt, p_session_id, v_label, v_at, p_requested_at,
     v_who, v_notice, v_emerg, st.replacement_notice_hours)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id,
    'notice_hours', v_notice, 'is_emergency', v_emerg,
    'policy_hours', st.replacement_notice_hours, 'class_at', v_at);
end $$;

comment on function request_replacement(uuid, uuid, timestamptz) is
  'Records a replacement request and settles it against the notice rule. '
  'Call before moving the swimmer out of the class.';


-- ─── 4. Closing one out ─────────────────────────────────────────────────
create or replace function mark_replacement_placed(
  p_student_id uuid, p_lesson_type_id uuid, p_placed_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to place.');
  end if;
  -- The oldest open request for this swimmer and lesson type: a parent
  -- with two outstanding misses has the first one settled first.
  select id into v_id from replacement_requests
   where student_id = p_student_id
     and (p_lesson_type_id is null or lesson_type_id = p_lesson_type_id)
     and status = 'pending' and not is_void
   order by requested_at
   limit 1;
  if v_id is null then
    -- Not an error. A replacement placed before this file existed, or
    -- one the office arranged outside the flow, still happened.
    return jsonb_build_object('ok', true, 'matched', false);
  end if;
  update replacement_requests
     set status = 'placed', placed_session_id = p_placed_session_id, placed_at = now()
   where id = v_id;
  return jsonb_build_object('ok', true, 'matched', true, 'id', v_id);
end $$;

create or replace function cancel_replacement_request(
  p_student_id uuid, p_lesson_type_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to cancel.');
  end if;
  select id into v_id from replacement_requests
   where student_id = p_student_id
     and (p_lesson_type_id is null or lesson_type_id = p_lesson_type_id)
     and status = 'pending' and not is_void
   order by requested_at limit 1;
  if v_id is null then return jsonb_build_object('ok', true, 'matched', false); end if;
  -- Cancelled, not voided: the family did ask, and that is part of the
  -- pattern the tracker is for. Voiding is for a request entered in
  -- error, which is a different thing and has its own column.
  update replacement_requests
     set status = 'cancelled', void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = v_id;
  return jsonb_build_object('ok', true, 'matched', true);
end $$;


-- ─── 5. The tracker ─────────────────────────────────────────────────────
-- One row per swimmer. Pass a student id for just that one.
--
-- "Classes" is every class the swimmer has been put in, which is the
-- denominator the centre described: missing one lesson in four. A
-- swimmer with eight classes and two last-minute replacements is at
-- 0.25, and that is the number the rule is about.
--
-- emergency_tracked_from is the honest part. Notice was never recorded
-- before this file ran, so no replacement from before then can be
-- sorted into emergency or planned. Replacements are counted anyway,
-- because that number is real.
create or replace function replacement_tracker(p_student_id uuid default null)
returns table (
  student_id uuid,
  child text,
  parent text,
  enrolled_on date,
  classes int,
  replacements int,
  replacement_rate numeric,
  emergency_replacements int,
  emergency_rate numeric,
  emergency_tracked_from date,
  enough_history boolean,
  over_limit boolean,
  last_emergency_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare st class_policy_settings; v_from date;
begin
  if not is_website_login() then return; end if;
  select * into st from class_policy_settings where id;

  -- The day the recording started: the first request ever written, or
  -- today if none has been.
  select coalesce(min(requested_at)::date, (now() at time zone 'Asia/Kuala_Lumpur')::date)
    into v_from from replacement_requests;

  return query
  with mine as (
    select s.id, s.name, s.account_id, s.created_at
      from students s
     where (p_student_id is null or s.id = p_student_id)
       and s.is_active is not false
  ),
  cls as (
    select wss.student_id, count(*)::int as n,
           min((ws.week_start_date + (ws.weekday - 1))::date) as first_class
      from weekly_session_students wss
      join weekly_sessions ws on ws.id = wss.session_id
     group by wss.student_id
  ),
  rep as (
    -- Replacements that happened, counted from the class rows, so the
    -- history before this file is included.
    select wss.student_id, count(*)::int as n
      from weekly_session_students wss
     where coalesce(wss.is_replacement, false)
     group by wss.student_id
  ),
  em as (
    select r.student_id, count(*)::int as n, max(r.requested_at) as last_at
      from replacement_requests r
     where r.is_emergency and not r.is_void and r.status <> 'cancelled'
     group by r.student_id
  )
  select m.id,
         m.name::text,
         coalesce(nullif(btrim(pa.display_name), ''), '—')::text,
         coalesce(m.created_at::date, c.first_class),
         coalesce(c.n, 0),
         coalesce(rp.n, 0),
         case when coalesce(c.n, 0) > 0
              then round(coalesce(rp.n, 0)::numeric / c.n, 3) else 0 end,
         coalesce(e.n, 0),
         case when coalesce(c.n, 0) > 0
              then round(coalesce(e.n, 0)::numeric / c.n, 3) else 0 end,
         v_from,
         (coalesce(c.n, 0) >= coalesce(st.emergency_min_classes, 8)),
         (coalesce(c.n, 0) >= coalesce(st.emergency_min_classes, 8)
          and coalesce(c.n, 0) > 0
          and (coalesce(e.n, 0)::numeric / nullif(c.n, 0))
              >= coalesce(st.emergency_rate_limit, 0.25)),
         e.last_at
    from mine m
    left join parent_accounts pa on pa.id = m.account_id
    left join cls c  on c.student_id  = m.id
    left join rep rp on rp.student_id = m.id
    left join em e   on e.student_id  = m.id
   order by
     (coalesce(c.n,0) >= coalesce(st.emergency_min_classes,8)
      and coalesce(c.n,0) > 0
      and (coalesce(e.n,0)::numeric / nullif(c.n,0)) >= coalesce(st.emergency_rate_limit,0.25)) desc,
     coalesce(e.n, 0) desc, coalesce(rp.n, 0) desc, m.name;
end $$;

comment on function replacement_tracker(uuid) is
  'Per swimmer: classes, replacements, last-minute replacements and the '
  'rate. Replacement counts include history; the emergency rate only '
  'counts from the day notice began being recorded.';


-- ─── 6. Who has attended without paying ─────────────────────────────────
-- Read from the ledger, not the balance, so it is right whether or not
-- the centre lets a balance go below zero. With negatives allowed the
-- balance is the number; with them switched off the balance stops at
-- nil and the unpaid classes are still counted here.
create or replace function credit_defaulters()
returns table (
  student_id uuid,
  child text,
  parent text,
  parent_phone text,
  lesson text,
  balance numeric,
  unpaid_classes int,
  last_unpaid_on date
)
language sql stable security definer set search_path = public as $$
  with unpaid as (
    select cp.student_id, cp.lesson_type_id,
           count(*)::int as n, max(cp.purchase_date) as last_on
      from credit_purchases cp
     where cp.source = 'attendance_unpaid'
     group by cp.student_id, cp.lesson_type_id
  ),
  neg as (
    select b.student_id, b.lesson_type_id, b.remaining_balance
      from student_credit_balances b
     where b.remaining_balance < 0
  )
  select s.id, s.name::text,
         coalesce(nullif(btrim(pa.display_name), ''), '—')::text,
         coalesce(parent_signin_phone(pa), '')::text,
         coalesce(lt.name, 'Class')::text,
         coalesce(n.remaining_balance, b2.remaining_balance, 0),
         coalesce(u.n, 0),
         u.last_on
    from students s
    left join parent_accounts pa on pa.id = s.account_id
    full join unpaid u on u.student_id = s.id
    left join neg n on n.student_id = s.id and n.lesson_type_id = u.lesson_type_id
    left join student_credit_balances b2
           on b2.student_id = s.id and b2.lesson_type_id = u.lesson_type_id
    left join scheduler_lesson_types lt on lt.id = u.lesson_type_id
   where is_website_login()
     and (u.n is not null or n.student_id is not null)
   order by coalesce(u.n, 0) desc, coalesce(n.remaining_balance, 0), s.name;
$$;

comment on function credit_defaulters() is
  'Swimmers who have attended classes they had no credit for. Read from '
  'the ledger so it is right whether or not negative balances are '
  'allowed.';


-- ─── 6b. The office's way in ────────────────────────────────────────────
-- The scheduler marks attendance from the Session modal, which works a
-- student at a time and has no weekly_session_students row id to hand,
-- so mark_attendance does not fit. Rather than write the credit rule a
-- second time in the browser — which is how an office screen and a
-- poolside screen end up disagreeing about the same class — the rule
-- stays here and both call into it.
create or replace function adjust_credit(
  p_student_id uuid, p_lesson_type_id uuid, p_delta int,
  p_confirm boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st class_policy_settings; v_before numeric; v_child text; v_moved int; v_bal numeric;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to change.');
  end if;
  if p_delta = 0 or p_student_id is null or p_lesson_type_id is null then
    return jsonb_build_object('ok', true, 'credit_moved', 0);
  end if;
  select * into st from class_policy_settings where id;

  select coalesce(remaining_balance, 0) into v_before
    from student_credit_balances
   where student_id = p_student_id and lesson_type_id = p_lesson_type_id;
  v_before := coalesce(v_before, 0);

  if p_delta < 0 and v_before <= 0 and not coalesce(p_confirm, false) then
    select name into v_child from students where id = p_student_id;
    return jsonb_build_object('ok', false, 'needs_confirm', true,
      'balance', v_before, 'child', coalesce(v_child, 'This swimmer'),
      'allow_negative', coalesce(st.allow_negative_credits, true),
      'error', coalesce(v_child, 'This swimmer')
        || (case when v_before = 0 then ' has no credits left.'
                 else ' is already ' || abs(v_before) || ' class'
                      || (case when abs(v_before) = 1 then '' else 'es' end)
                      || ' in arrears.' end)
        || ' Billing or a renewal is needed.');
  end if;

  v_moved := case when p_delta < 0 and v_before <= 0
                       and not coalesce(st.allow_negative_credits, true)
                  then 0 else p_delta end;

  insert into credit_purchases
    (student_id, lesson_type_id, purchase_date, credits_added, source, notes)
  values
    (p_student_id, p_lesson_type_id,
     (now() at time zone 'Asia/Kuala_Lumpur')::date, v_moved,
     case when p_delta < 0 and v_before <= 0 then 'attendance_unpaid' else 'attendance' end,
     case when p_delta < 0 then 'Marked from the office' else 'Credit returned' end);

  -- The row is created if it is missing. adjustCredit in the browser
  -- used to give up silently when a swimmer had no balance row at all,
  -- so the very first class never cost anything.
  insert into student_credit_balances
    (student_id, lesson_type_id, initial_balance, remaining_balance)
  values (p_student_id, p_lesson_type_id, 0, v_moved)
  on conflict (student_id, lesson_type_id) do update
    set remaining_balance =
          case when not coalesce(st.allow_negative_credits, true)
               then greatest(0, student_credit_balances.remaining_balance + p_delta)
               else student_credit_balances.remaining_balance + p_delta end,
        updated_at = now();

  select remaining_balance into v_bal from student_credit_balances
   where student_id = p_student_id and lesson_type_id = p_lesson_type_id;

  return jsonb_build_object('ok', true, 'credit_moved', v_moved, 'balance', v_bal,
                            'unpaid', (p_delta < 0 and v_before <= 0));
end $$;

comment on function adjust_credit(uuid, uuid, int, boolean) is
  'The office''s path to the same credit rule mark_attendance applies. '
  'Asks before taking a credit a swimmer does not have, writes the '
  'ledger, and creates the balance row if it is missing.';


-- ─── 7. Locks ───────────────────────────────────────────────────────────
alter table class_policy_settings enable row level security;
alter table replacement_requests  enable row level security;

drop policy if exists cps_office on class_policy_settings;
drop policy if exists rr_office  on replacement_requests;

-- Readable by anybody signed in to the website so the screens can show
-- the rules; changeable only by a seat that may change things.
create policy cps_office on class_policy_settings for all
  using (is_website_login()) with check (can_write_office());
create policy rr_office on replacement_requests for all
  using (is_website_login()) with check (can_write_office());

revoke all on class_policy_settings from anon;
revoke all on replacement_requests  from anon;


-- ─── 8. What is already true ────────────────────────────────────────────
-- No backfill of requests: notice was never recorded, so there is
-- nothing to recover and anything written here would be invented. The
-- counts the tracker shows for history come from the class rows
-- themselves, which are real.
--
-- This is the report, not a migration. It says what the tracker will
-- show on its first morning.
--
-- It reads the tables, not replacement_tracker() and credit_defaulters().
-- Those two begin with is_website_login(), and the SQL editor is not a
-- website login — it is the postgres role with no JWT at all. Asking
-- them here returns no rows, and a report of six zeros reads as "this
-- centre has no history" when it means "you are not signed in to the
-- website". The first version of this block did exactly that.
with
 trk as (select count(*) n from students where is_active is not false),
 rep as (select count(*) n, count(distinct student_id) kids
           from weekly_session_students where coalesce(is_replacement, false)),
 emg as (select count(*) n, min(requested_at)::date from_date
           from replacement_requests
          where is_emergency and not is_void and status <> 'cancelled'),
 unp as (select count(distinct student_id) n from credit_purchases
          where source = 'attendance_unpaid'),
 neg as (select count(distinct student_id) n from student_credit_balances
          where remaining_balance < 0)
select 'swimmers being tracked' as thing, (select n from trk)::text as n
union all
select 'of those, with a replacement in their history', (select kids from rep)::text
union all
select 'replacements on record (all time)', (select n from rep)::text
union all
select 'last-minute replacements recorded so far', (select n from emg)::text
union all
select 'measuring notice from',
       coalesce((select from_date from emg)::text,
                (now() at time zone 'Asia/Kuala_Lumpur')::date::text)
union all
select 'swimmers who have attended without credit',
       ((select n from unp) + (select n from neg))::text
union all
select 'the rules, as they now stand',
       'replacements ' || case when replacements_enabled then 'on' else 'off' end
         || ', notice ' || replacement_notice_hours || 'h'
         || ', emergency limit ' || emergency_rate_limit
         || case when enforce_emergency_limit then ' (enforced)' else ' (watched only)' end
         || ', negative credits ' || case when allow_negative_credits then 'allowed' else 'not allowed' end
  from class_policy_settings where id;
