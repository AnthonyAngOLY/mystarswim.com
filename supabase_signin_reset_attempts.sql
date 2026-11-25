-- ════════════════════════════════════════════════════════════════════════
--  Clearing one number's sign-in attempts, for a demonstration
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  PUT THE NUMBER TO CLEAR ON THE MARKED LINE NEAR THE BOTTOM.
--
--  WHY
--  Showing the front desk how a new parent signs in means walking the
--  whole thing several times in one sitting: ask for a code, set a
--  password, sign out, sign back in. The caps are per number per hour
--  and per day, and they do not care that it is a demonstration. Six
--  codes in and the demonstration stops.
--
--  CLEARED, NOT DELETED
--  Every message in that log really was sent and really was charged for.
--  Deleting the rows would reset the caps and also quietly reduce what
--  Accounts → Sign-in codes says the month cost, which is the one
--  question that screen exists to answer. So a row gets a cleared_at
--  instead: the caps stop counting it, the spend report still does.
--
--  WHAT IT DOES NOT DO
--  It does not remove the password. It does not need to — the screen
--  that asks a parent to choose one appears after EVERY code sign-in,
--  because that is also the way back from a forgotten password. So the
--  new-customer walkthrough is the same walkthrough either way.
--
--  AND IT REMOVES A PROTECTION, BRIEFLY
--  The caps are what stops a number being used to spray messages. Clear
--  them and the next six are free to go. That is fine for a counter demo
--  on your own phone; it is not a thing to run on a customer's number
--  because they rang up about a code.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Somewhere to mark a row spent ───────────────────────────────────
alter table parent_otp_sends
  add column if not exists cleared_at timestamptz;

comment on column parent_otp_sends.cleared_at is
  'Set when a row should stop counting towards the caps -- a cleared '
  'demonstration, or a wrong password forgiven by a later good one. The '
  'row stays, and the spend report still counts it: it was sent and it '
  'was charged for.';

create index if not exists parent_otp_sends_live_idx
  on parent_otp_sends (phone, outcome, at desc) where cleared_at is null;


-- ─── 2. The caps stop counting a cleared row ────────────────────────────
-- Restated whole, because this function has to be read as a unit. The
-- only differences from supabase_parent_signin_guard.sql are the three
-- "and cleared_at is null" clauses in the cap queries.
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

  -- array_agg, not min: Postgres has no min(uuid).
  select count(*), (array_agg(pa.id))[1] into v_n, v_acct
    from parent_accounts pa
   where parent_signin_phone(pa) = p_phone;

  if v_n = 0 then
    insert into parent_otp_sends (phone, outcome) values (p_phone, 'unknown_number');
    return jsonb_build_object('ok', false, 'known', false, 'error', v_unknown);
  end if;

  if v_n > 1 then
    insert into parent_otp_sends (phone, outcome) values (p_phone, 'two_accounts');
    return jsonb_build_object('ok', false, 'known', false,
      'error', 'That number is on two accounts, so we cannot tell which '
            || 'family it is. Call the centre and we will sort it out.');
  end if;

  select count(*) into v_live
    from students s
   where s.account_id = v_acct and s.is_active is not false;

  if v_live = 0 then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'archived');
    return jsonb_build_object('ok', false, 'known', false, 'error', v_unknown);
  end if;

  select max(at) into v_last
    from parent_otp_sends
   where phone = p_phone and outcome = 'allowed' and cleared_at is null;

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
   where phone = p_phone and outcome = 'allowed' and cleared_at is null;

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

  insert into parent_otp_sends (phone, account_id, outcome)
  values (p_phone, v_acct, 'allowed')
  returning id into v_log;

  return jsonb_build_object('ok', true, 'known', true,
    'phone', p_phone, 'account_id', v_acct, 'log_id', v_log,
    'cooldown_sec', v_cool);
end $$;


-- ─── 3. And so does the wrong-password count ────────────────────────────
create or replace function parent_login_check(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set   parent_message_settings%rowtype;
  v_acct  uuid;
  v_n     integer;
  v_live  integer;
  v_fails integer;
  v_max   integer;
  v_no constant text :=
    'That number and password do not match. If this is your first time, '
    || 'or you have forgotten it, ask us for a code.';
begin
  select * into v_set from parent_message_settings limit 1;
  v_max := coalesce(v_set.password_max_fails, 5);

  if p_phone is null or length(regexp_replace(p_phone, '\D', '', 'g')) < 9 then
    return jsonb_build_object('ok', false, 'error', v_no);
  end if;

  select count(*), (array_agg(pa.id))[1] into v_n, v_acct
    from parent_accounts pa
   where parent_signin_phone(pa) = p_phone;

  if v_n <> 1 then
    insert into parent_otp_sends (phone, outcome) values (p_phone, 'password_no_account');
    return jsonb_build_object('ok', false, 'error', v_no);
  end if;

  select count(*) into v_live
    from students s
   where s.account_id = v_acct and s.is_active is not false;

  if v_live = 0 then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'password_archived');
    return jsonb_build_object('ok', false, 'error', v_no);
  end if;

  select count(*) into v_fails
    from parent_otp_sends
   where phone = p_phone
     and outcome = 'password_bad'
     and cleared_at is null
     and at > now() - interval '1 hour';

  if v_fails >= v_max then
    insert into parent_otp_sends (phone, account_id, outcome)
    values (p_phone, v_acct, 'password_locked');
    return jsonb_build_object('ok', false, 'must_use_code', true,
      'error', 'Too many tries. Ask us for a code instead — '
            || 'you can set a new password once you are in.');
  end if;

  return jsonb_build_object('ok', true, 'account_id', v_acct,
    'phone', p_phone, 'fails', v_fails, 'max_fails', v_max);
end $$;


-- ─── 4. One good sign-in forgives the earlier fumbles ───────────────────
-- This used to rewrite outcome to 'password_bad_cleared', which lost the
-- fact that they were wrong passwords at all. cleared_at says the same
-- thing without editing history, and is now the one mechanism rather
-- than the second of two.
create or replace function parent_login_record(p_phone text, p_ok boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set   parent_message_settings%rowtype;
  v_acct  uuid;
  v_fails integer;
  v_max   integer;
begin
  select * into v_set from parent_message_settings limit 1;
  v_max := coalesce(v_set.password_max_fails, 5);

  select pa.id into v_acct
    from parent_accounts pa
   where parent_signin_phone(pa) = p_phone
   limit 1;

  insert into parent_otp_sends (phone, account_id, outcome)
  values (p_phone, v_acct, case when p_ok then 'password_ok' else 'password_bad' end);

  if p_ok then
    update parent_otp_sends
       set cleared_at = now()
     where phone = p_phone
       and outcome = 'password_bad'
       and cleared_at is null
       and at > now() - interval '1 hour';
    return jsonb_build_object('ok', true, 'fails', 0);
  end if;

  select count(*) into v_fails
    from parent_otp_sends
   where phone = p_phone
     and outcome = 'password_bad'
     and cleared_at is null
     and at > now() - interval '1 hour';

  return jsonb_build_object('ok', true, 'fails', v_fails,
    'must_use_code', v_fails >= v_max,
    'left', greatest(0, v_max - v_fails));
end $$;

revoke all on function parent_signin_check(text)          from public, anon, authenticated;
revoke all on function parent_login_check(text)           from public, anon, authenticated;
revoke all on function parent_login_record(text, boolean) from public, anon, authenticated;
grant execute on function parent_signin_check(text)          to service_role;
grant execute on function parent_login_check(text)           to service_role;
grant execute on function parent_login_record(text, boolean) to service_role;


-- ─── 5. The reset itself ────────────────────────────────────────────────
-- A function rather than a bare update, so it can be given a button on
-- the admin screen later and so it refuses a seat that should not have
-- it. Office only: clearing a number's caps is removing a protection.
create or replace function reset_signin_attempts(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_e164 text; v_n integer;
begin
  if not can_write_office() then
    raise exception 'reset_signin_attempts: this seat may not clear sign-in attempts'
      using errcode = '42501';
  end if;

  v_e164 := ss_normalise_phone(p_phone);
  if v_e164 is null then
    return jsonb_build_object('ok', false, 'error', 'That is not a mobile number.');
  end if;

  update parent_otp_sends
     set cleared_at = now()
   where phone = v_e164 and cleared_at is null;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'phone', v_e164, 'cleared', v_n);
end $$;

revoke all on function reset_signin_attempts(text) from public, anon;
grant execute on function reset_signin_attempts(text) to authenticated, service_role;

comment on function reset_signin_attempts(text) is
  'Stops one number''s past attempts counting towards the caps, for a '
  'demonstration. The rows stay and the spend report still counts them: '
  'those messages were sent and were charged for.';


-- ─── 6. Do it, and say what it did ──────────────────────────────────────
do $$
declare
  -- ───────────────────────────────────────────────────────────────────
  --  ↓↓↓  THE NUMBER TO CLEAR. Any way you normally write it.  ↓↓↓
  v_phone text := '012-524 3477';
  --  ↑↑↑                                                      ↑↑↑
  -- ───────────────────────────────────────────────────────────────────
  v_e164 text;
  v_n    integer;
begin
  v_e164 := ss_normalise_phone(v_phone);
  update parent_otp_sends
     set cleared_at = now()
   where phone = v_e164 and cleared_at is null;
  get diagnostics v_n = row_count;
  raise notice 'cleared % row(s) for %', v_n, v_e164;
end $$;

select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the number' as thing,
         coalesce(ss_normalise_phone('012-524 3477'), 'NOT A MOBILE NUMBER') as detail
  union all
  select 2, 'codes it may still ask for, this hour',
         (select coalesce(otp_max_per_hour, 6)::text from parent_message_settings limit 1)
      || ' — none of its past attempts count any more'
  union all
  select 3, 'rows cleared so far',
         (select count(*)::text from parent_otp_sends where cleared_at is not null)
  union all
  select 4, 'what the spend report still shows',
         (select count(*)::text from parent_otp_sends where outcome = 'allowed')
      || ' codes sent, all of them — clearing a row stops it counting '
      || 'towards the caps, never towards the bill'
  union all
  select 5, 'doing it again',
         'select reset_signin_attempts(''012-524 3477''); — same thing, one line.'
  union all
  select 6, 'the walkthrough',
         'Send me a code instead → number → code → choose a password → '
      || 'sign out → number + password. The password screen appears after '
      || 'every code, so there is nothing to undo between runs.'
  ) z
 order by z.k;
