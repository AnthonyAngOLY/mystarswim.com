-- ════════════════════════════════════════════════════════════════════════
--  A password, so signing in stops costing a message
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table — supabase_parent_signin_guard.sql made the one
--  this uses — so supabase_rls_guard.sql is not needed with it.
--
--  RUN supabase_parent_signin_guard.sql FIRST. This builds on
--  parent_otp_sends and on parent_message_settings columns that file
--  adds. On its own it will not create them.
--
--  WHY
--  A code by SMS was the only way in, so every sign-in was a message
--  Twilio charged for. That is fine once per parent and ruinous if it
--  happens weekly — and weekly is what iOS Safari produces on its own,
--  because it clears a site's stored data after seven days without a
--  visit unless the app has been added to the home screen. A parent who
--  opens the app each Sunday in a browser tab gets signed out on roughly
--  that cycle, through nothing anybody did wrong.
--
--  A password breaks that link. Being signed out stops meaning "send a
--  message" and starts meaning "type the thing you chose".
--
--  WHAT A PASSWORD IS NOT DOING HERE
--  It is not making the account safer. The way back in when it is
--  forgotten is the same SMS code, so the code remains the real key and
--  the password sits in front of it. That is the correct trade for this:
--  the phone is the thing we have verified, and a parent who loses both
--  is a phone call, not a lockout.
--
--  WHAT IT COSTS US, THOUGH
--  A password is something to guess at, and the anon key is printed in
--  every page we serve. Until now there was nothing to brute force. So
--  attempts are counted here, per number, and after enough of them that
--  number must use a code for its next sign-in — which an attacker
--  cannot read. Nobody is ever locked out; they are moved back to the
--  channel we trust.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The setting ─────────────────────────────────────────────────────
alter table parent_message_settings
  add column if not exists password_max_fails integer not null default 5;

comment on column parent_message_settings.password_max_fails is
  'Wrong passwords for one number, within the hour, before that number '
  'must sign in with a code instead. Not a lockout: the code always '
  'works, and somebody guessing cannot read it.';


-- ─── 2. May this number try a password? ─────────────────────────────────
-- The same gate as the code path — the active number only, on an account
-- with at least one active swimmer — because a password sign-in goes
-- straight to Supabase auth and would otherwise walk around it entirely.
-- An archived family keeps a working password forever without this.
--
-- It does NOT say whether the number has a password, or exists. The
-- login screen asks for a number and a password together and offers a
-- code beside them, so there is never a moment where the app has to
-- reveal that a number is real in order to draw the next screen.
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
  -- One sentence for every refusal that is not about the password being
  -- wrong. An unknown number, an archived account and a number with no
  -- account must be indistinguishable, or trying numbers tells you which
  -- ones are real.
  v_no constant text :=
    'That number and password do not match. If this is your first time, '
    || 'or you have forgotten it, ask us for a code.';
begin
  select * into v_set from parent_message_settings limit 1;
  v_max := coalesce(v_set.password_max_fails, 5);

  if p_phone is null or length(regexp_replace(p_phone, '\D', '', 'g')) < 9 then
    return jsonb_build_object('ok', false, 'error', v_no);
  end if;

  select count(*), min(pa.id) into v_n, v_acct
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

  -- Wrong tries in the last hour. Counted from the log rather than a
  -- counter column, so it ages out on its own and nothing has to
  -- remember to clear it.
  select count(*) into v_fails
    from parent_otp_sends
   where phone = p_phone
     and outcome = 'password_bad'
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

comment on function parent_login_check(text) is
  'May this number attempt a password? Applies the active-number and '
  'archived-account rules and the wrong-password count. Says nothing '
  'about whether the number exists.';


-- ─── 3. And how the attempt went ────────────────────────────────────────
-- A success clears the slate: the count is of consecutive trouble, not
-- of a parent who mistyped once last Tuesday.
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

  select min(pa.id) into v_acct
    from parent_accounts pa
   where parent_signin_phone(pa) = p_phone;

  insert into parent_otp_sends (phone, account_id, outcome)
  values (p_phone, v_acct, case when p_ok then 'password_ok' else 'password_bad' end);

  if p_ok then
    -- Mark the earlier failures spent, so one good sign-in does not
    -- leave a parent one mistype away from being pushed to a code.
    update parent_otp_sends
       set outcome = 'password_bad_cleared'
     where phone = p_phone
       and outcome = 'password_bad'
       and at > now() - interval '1 hour';
    return jsonb_build_object('ok', true, 'fails', 0);
  end if;

  select count(*) into v_fails
    from parent_otp_sends
   where phone = p_phone
     and outcome = 'password_bad'
     and at > now() - interval '1 hour';

  return jsonb_build_object('ok', true, 'fails', v_fails,
    'must_use_code', v_fails >= v_max,
    'left', greatest(0, v_max - v_fails));
end $$;

revoke all on function parent_login_check(text)          from public, anon, authenticated;
revoke all on function parent_login_record(text, boolean) from public, anon, authenticated;


-- ─── 4. Who has one ─────────────────────────────────────────────────────
-- For the admin screen, and for knowing whether this is working. Counts
-- only; no screen of ours ever shows whether one NUMBER has a password,
-- because that answers "is this number real".
create or replace function parent_password_uptake()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not can_write_office() then jsonb_build_object('ok', false)
  else jsonb_build_object(
    'ok', true,
    'accounts_live', (select count(*) from parent_accounts pa
                       where parent_signin_phone(pa) is not null
                         and exists (select 1 from students s
                                      where s.account_id = pa.id
                                        and s.is_active is not false)),
    'signed_in_ever', (select count(*) from parent_accounts where last_login_at is not null),
    'passwords_set',  (case when has_table_privilege('auth.users', 'select')
                            then (select count(*) from auth.users u
                                   where u.encrypted_password is not null
                                     and u.encrypted_password <> ''
                                     and u.phone is not null)
                            else null end),
    'codes_30d',      (select count(*) from parent_otp_sends
                        where outcome = 'allowed' and at > now() - interval '30 days'),
    'passwords_30d',  (select count(*) from parent_otp_sends
                        where outcome = 'password_ok' and at > now() - interval '30 days'))
  end;
$$;

revoke all on function parent_password_uptake() from public, anon;
grant execute on function parent_password_uptake() to authenticated;

comment on function parent_password_uptake() is
  'How many parents have a password, and how many sign-ins in the last '
  '30 days used one instead of a code. The ratio is what the whole '
  'exercise was for.';


-- ─── 5. What is now true ────────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the password gate' as thing,
         case when to_regprocedure('public.parent_login_check(text)') is null
              then 'MISSING — read the errors above'
              else 'parent_login_check() — the active number only, on an '
                || 'account with an active swimmer, same as the code path' end as detail
  union all
  select 2, 'wrong tries allowed',
         coalesce((select password_max_fails::text from parent_message_settings limit 1), '5')
      || ' an hour, then that number must use a code. Never a lockout: '
      || 'the code always works and a guesser cannot read it.'
  union all
  select 3, 'parents who have set one',
         coalesce((case when has_table_privilege('auth.users', 'select')
                   then (select count(*)::text from auth.users
                          where encrypted_password is not null
                            and encrypted_password <> '' and phone is not null)
                   end), 'cannot read auth.users from here, which is fine')
      || ' of ' || (select count(*)::text from parent_accounts pa
                     where parent_signin_phone(pa) is not null
                       and exists (select 1 from students s
                                    where s.account_id = pa.id
                                      and s.is_active is not false))
      || ' accounts that can sign in. Nobody has one yet on the first run, '
      || 'and that is expected — it is set the first time each parent signs in.'
  union all
  select 4, 'what it saves',
         'A sign-in with a password sends nothing. At roughly RM 0.35 a '
      || 'message, the difference between parents signing in once and '
      || 'signing in weekly is about twentyfold on the year.'
  union all
  select 5, 'next, in this order',
         '1. Deploy the parent app (BUILD 7). '
      || '2. Redeploy parent-signin. '
      || '3. Deploy the new parent-login function. '
      || 'The app falls back to codes alone until 3 is done, so no step '
      || 'leaves anybody locked out.'
  ) z
 order by z.k;
