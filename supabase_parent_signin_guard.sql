-- ════════════════════════════════════════════════════════════════════════
--  Who may ask for a sign-in code, how often, and what it cost
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  IT CREATES A TABLE, SO supabase_rls_guard.sql IS THE SECOND HALF OF
--  THIS JOB. parent_otp_sends is locked below, but run the guard after
--  this and read its last query. The anon key is printed in every page we
--  serve.
--
--  RUN THIS BEFORE REDEPLOYING parent-signin. The function calls
--  parent_signin_check(), and a function that is not there yet answers
--  404 — which the Edge Function reports as "we could not send a code",
--  so nobody could sign in at all. SQL first, function second.
--
--  WHY
--  Every sign-in code is a message Twilio charges for. Three things
--  decided that bill and none of them were under control.
--
--  THE GATE WAS WIDER THAN THE COMMENT SAID
--  parent-signin matched phone_primary OR phone_secondary and then sent
--  to whichever was typed. Its own comment said "only the active one
--  receives the code — that is the rule the database already holds in
--  parent_signin_phone()". The rule was stated and never applied, so a
--  number the office had moved off the account still worked.
--
--  AND IT DID NOT ASK WHETHER THEY WERE STILL CUSTOMERS
--  The admin Accounts screen shows Active and Archived, and archiving a
--  parent switches every one of their swimmers off. The sign-in knew
--  nothing about it: all 16 archived accounts could still ask for codes.
--  Here, an account with no active swimmer is answered exactly as an
--  unknown number is — because to someone trying numbers, those two
--  answers being different is itself the information.
--
--  THE RATE LIMIT DID NOT HOLD
--  Six per hour, counted in the Edge Function's own memory. Supabase
--  recycles those instances and the count goes with them, so the real
--  ceiling was six per hour per instance lifetime, which can be minutes.
--  It is counted here now, where it survives.
--
--  WHAT A SEND COSTS, AND WHY THE LOG EXISTS
--  Roughly RM 0.35 a message to a Malaysian mobile. The difference
--  between parents signing in once and signing in weekly is about
--  twenty-fold on the yearly bill, and nothing recorded which was
--  happening. Every attempt is now a row — sent, blocked, or refused —
--  so the question "why was the bill that" has an answer.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The settings ────────────────────────────────────────────────────
-- On the table that already holds what the parent app says and when.
-- A separate settings table for three integers is a table to forget.
alter table parent_message_settings
  add column if not exists otp_cooldown_sec integer not null default 60,
  add column if not exists otp_max_per_hour integer not null default 6,
  add column if not exists otp_max_per_day  integer not null default 10;

comment on column parent_message_settings.otp_cooldown_sec is
  'Seconds a number must wait between codes. The common accidental spend '
  'is a parent tapping "Send it again" four times in ten seconds.';
comment on column parent_message_settings.otp_max_per_day is
  'Ceiling per number per day. A parent who genuinely cannot receive is '
  'better served by a phone call than by a tenth message.';


-- ─── 2. The log ─────────────────────────────────────────────────────────
-- One row per attempt, including the ones that were refused: a run of
-- refusals against numbers that are not ours is what probing looks like,
-- and it is invisible if only successes are written.
create table if not exists parent_otp_sends (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  account_id  uuid references parent_accounts(id) on delete set null,
  -- allowed | cooldown | hour_cap | day_cap | unknown_number | archived
  --         | two_accounts | bad_number
  outcome     text not null,
  channel     text,
  sent_ok     boolean,
  error_text  text,
  at          timestamptz not null default now()
);

create index if not exists parent_otp_sends_phone_idx on parent_otp_sends (phone, at desc);
create index if not exists parent_otp_sends_at_idx    on parent_otp_sends (at desc);

comment on table parent_otp_sends is
  'Every request for a sign-in code. outcome says whether a message was '
  'sent or why not; sent_ok says whether Twilio took it. The only record '
  'of what the sign-in costs.';

-- A number that was typed into a public form is in here whether or not
-- it belongs to a customer. That is the point — you cannot see probing
-- without it — but it means this table holds numbers of people who are
-- not ours, so it is office-read and nothing else.
alter table parent_otp_sends enable row level security;
revoke all on parent_otp_sends from anon, authenticated;
grant select on parent_otp_sends to authenticated;
drop policy if exists parent_otp_sends_office on parent_otp_sends;
create policy parent_otp_sends_office on parent_otp_sends for select to authenticated
  using (can_write_office());
-- Written only by the Edge Function, which holds the service role and
-- does not pass through policies. Nothing else writes it, ever.


-- ─── 3. Is this a number we will send to? ───────────────────────────────
-- Everything the old function decided in TypeScript, decided here
-- instead: the gate, the caps, and the row that records the answer. One
-- round trip, and one place to read the rule.
--
-- It returns the SAME shape of refusal for an unknown number and for an
-- archived account, deliberately. Telling the two apart tells somebody
-- trying numbers which ones are real.
create or replace function parent_signin_check(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set    parent_message_settings%rowtype;
  v_acct   uuid;
  v_n      integer;
  v_live   integer;
  v_last   timestamptz;
  v_hour   integer;
  v_day    integer;
  v_log    uuid;
  v_wait   integer;
  v_cool   integer;
  v_maxh   integer;
  v_maxd   integer;
  v_unknown constant text :=
    'We do not have that number on file. Call the centre and we will add it.';
begin
  select * into v_set from parent_message_settings limit 1;
  v_cool := coalesce(v_set.otp_cooldown_sec, 60);
  v_maxh := coalesce(v_set.otp_max_per_hour, 6);
  v_maxd := coalesce(v_set.otp_max_per_day, 10);

  if p_phone is null or length(regexp_replace(p_phone, '\D', '', 'g')) < 9 then
    insert into parent_otp_sends (phone, outcome)
    values (coalesce(p_phone, ''), 'bad_number');
    return jsonb_build_object('ok', false, 'known', false,
      'error', 'That does not look like a mobile number.');
  end if;

  -- THE ACTIVE NUMBER ONLY. parent_signin_phone() is the one place that
  -- knows which of the two an account currently signs in with, and this
  -- now matches on it rather than on either column.
  select count(*), min(pa.id) into v_n, v_acct
    from parent_accounts pa
   where parent_signin_phone(pa) = p_phone;

  if v_n = 0 then
    insert into parent_otp_sends (phone, outcome) values (p_phone, 'unknown_number');
    return jsonb_build_object('ok', false, 'known', false, 'error', v_unknown);
  end if;

  -- Two accounts answering to one number is a data fault, not a sign-in
  -- problem, and signing either in would be a guess about whose children
  -- to show.
  if v_n > 1 then
    insert into parent_otp_sends (phone, outcome) values (p_phone, 'two_accounts');
    return jsonb_build_object('ok', false, 'known', false,
      'error', 'That number is on two accounts, so we cannot tell which '
            || 'family it is. Call the centre and we will sort it out.');
  end if;

  -- Archived, in the sense the admin Accounts screen means it: archiving
  -- a parent switches every swimmer off, and this asks the same question
  -- back. Answered as an unknown number, on purpose.
  select count(*) into v_live
    from students s
   where s.account_id = v_acct and s.is_active is not false;

  if v_live = 0 then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'archived');
    return jsonb_build_object('ok', false, 'known', false, 'error', v_unknown);
  end if;

  -- ── The caps ──────────────────────────────────────────────────────
  -- Counted over sends that actually went out. A refusal costs nothing
  -- and must not use up the allowance that a real parent needs.
  select max(at) into v_last
    from parent_otp_sends
   where phone = p_phone and outcome = 'allowed';

  if v_last is not null and now() < v_last + make_interval(secs => v_cool) then
    v_wait := ceil(extract(epoch from (v_last + make_interval(secs => v_cool) - now())))::int;
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'cooldown');
    return jsonb_build_object('ok', false, 'known', true, 'wait_sec', v_wait,
      'error', 'We have just sent one. Give it ' || v_wait
            || ' more second' || case when v_wait = 1 then '' else 's' end || '.');
  end if;

  select count(*) filter (where at > now() - interval '1 hour'),
         count(*) filter (where at > now() - interval '24 hours')
    into v_hour, v_day
    from parent_otp_sends
   where phone = p_phone and outcome = 'allowed';

  if v_hour >= v_maxh then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'hour_cap');
    return jsonb_build_object('ok', false, 'known', true,
      'error', 'That is a lot of codes. Wait an hour, or call the centre.');
  end if;

  if v_day >= v_maxd then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'day_cap');
    return jsonb_build_object('ok', false, 'known', true,
      'error', 'We have sent as many codes as we can to that number today. '
            || 'Call the centre and we will sign you in.');
  end if;

  -- Allowed. The row is written NOW, before the message is sent, so two
  -- requests arriving together cannot both read a count below the cap.
  -- parent_signin_sent() fills in how it went.
  insert into parent_otp_sends (phone, account_id, outcome)
  values (p_phone, v_acct, 'allowed')
  returning id into v_log;

  -- cooldown_sec travels with the permission, so the app holds the
  -- resend button for exactly as long as this database will refuse it.
  -- The number was hardcoded in the app, which meant two copies of one
  -- setting and the office changing it in only one of them.
  return jsonb_build_object('ok', true, 'known', true,
    'phone', p_phone, 'account_id', v_acct, 'log_id', v_log,
    'cooldown_sec', v_cool);
end $$;

comment on function parent_signin_check(text) is
  'May this number be sent a sign-in code? Applies the active-number '
  'rule, the archived-account rule and the three caps, and records the '
  'attempt either way. Called by the parent-signin Edge Function.';


-- ─── 4. And how it went ─────────────────────────────────────────────────
create or replace function parent_signin_sent(
  p_log uuid, p_ok boolean, p_channel text default null, p_error text default null)
returns void
language sql security definer set search_path = public as $$
  update parent_otp_sends
     set sent_ok = p_ok, channel = p_channel, error_text = left(p_error, 500)
   where id = p_log;
$$;

-- The Edge Function holds the service role and reaches these regardless;
-- nothing with the anon key should be able to call either.
revoke all on function parent_signin_check(text)                 from public, anon, authenticated;
revoke all on function parent_signin_sent(uuid, boolean, text, text) from public, anon, authenticated;
-- And granted back to the role the Edge Function actually runs as.
-- EXECUTE is granted to PUBLIC by default, so revoking from PUBLIC takes
-- it from everybody who held it only that way -- service_role among
-- them. Without these two lines parent-signin asks the gate a question,
-- is told "permission denied", and reports that it could not check.
--
-- SECURITY DEFINER does not cover this. It decides whose privileges the
-- body runs WITH, not who may call it.
grant execute on function parent_signin_check(text)                 to service_role;
grant execute on function parent_signin_sent(uuid, boolean, text, text) to service_role;


-- ─── 5. What it cost ────────────────────────────────────────────────────
-- For the admin screen. One row per day, plus the refusals, so the shape
-- of a bill is readable without exporting anything.
create or replace function parent_otp_spend(p_from date default null,
                                            p_to   date default null)
returns table (
  day          date,
  sent         integer,
  failed       integer,
  cooldown     integer,
  capped       integer,
  unknown      integer,
  archived     integer,
  numbers      integer
)
language sql stable security definer set search_path = public as $$
  select (s.at at time zone 'Asia/Kuala_Lumpur')::date as day,
         count(*) filter (where s.outcome = 'allowed' and s.sent_ok is not false)::int,
         count(*) filter (where s.outcome = 'allowed' and s.sent_ok is false)::int,
         count(*) filter (where s.outcome = 'cooldown')::int,
         count(*) filter (where s.outcome in ('hour_cap','day_cap'))::int,
         count(*) filter (where s.outcome in ('unknown_number','bad_number'))::int,
         count(*) filter (where s.outcome = 'archived')::int,
         count(distinct s.phone) filter (where s.outcome = 'allowed')::int
    from parent_otp_sends s
   where can_write_office()
     and (p_from is null or (s.at at time zone 'Asia/Kuala_Lumpur')::date >= p_from)
     and (p_to   is null or (s.at at time zone 'Asia/Kuala_Lumpur')::date <= p_to)
   group by 1
   order by 1 desc;
$$;

revoke all on function parent_otp_spend(date, date) from public, anon;
grant execute on function parent_otp_spend(date, date) to authenticated;

comment on function parent_otp_spend(date, date) is
  'Sign-in codes by day: sent, failed, and the refusals. Office only. '
  'A run of unknown-number refusals is what probing looks like.';


-- ─── 6. What is now in place ────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the gate' as thing,
         'The ACTIVE number only, on an account with at least one active '
      || 'swimmer. Everything else is answered "we do not have that '
      || 'number on file" — the same words, on purpose.' as detail
  union all
  select 2, 'accounts that can sign in',
         (select count(*)::text from parent_accounts pa
           where parent_signin_phone(pa) is not null
             and exists (select 1 from students s
                          where s.account_id = pa.id and s.is_active is not false))
      || ' of ' || (select count(*)::text from parent_accounts)
      || ' accounts. The rest are archived, have no swimmer, or have no number.'
  union all
  select 3, 'numbers that stopped working',
         (select count(*)::text from parent_accounts pa
           where pa.phone_secondary is not null
             and parent_signin_phone(pa) <> pa.phone_secondary)
      || ' dormant second numbers, which used to get a code and no longer do.'
  union all
  select 4, 'the caps',
         (select coalesce(otp_cooldown_sec,60)::text from parent_message_settings limit 1)
      || 's between codes · '
      || (select coalesce(otp_max_per_hour,6)::text from parent_message_settings limit 1)
      || ' an hour · '
      || (select coalesce(otp_max_per_day,10)::text from parent_message_settings limit 1)
      || ' a day, per number. Counted in this database, so recycling an '
      || 'Edge Function no longer resets them.'
  union all
  select 5, 'the log',
         (select count(*)::text from parent_otp_sends) || ' rows so far. '
      || 'Every attempt, refusals included. Admin → Parents → Sign-in codes.'
  union all
  select 6, 'next, in this order',
         '1. Run supabase_rls_guard.sql — this file created a table. '
      || '2. Redeploy parent-signin, which calls the function above. '
      || 'Doing 2 before this file is run locks everybody out.'
  ) z
 order by z.k;
