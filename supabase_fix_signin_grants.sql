-- ════════════════════════════════════════════════════════════════════════
--  Give the Edge Functions back the permission I took off them
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates nothing, so no row-security guard is needed with it.
--
--  THE FAULT
--  "We could not check that just now. Please try again." on asking for a
--  sign-in code.
--
--  supabase_parent_signin_guard.sql and supabase_parent_password.sql each
--  end with a line like
--
--      revoke all on function parent_signin_check(text)
--        from public, anon, authenticated;
--
--  meant to stop a browser holding the anon key from calling the gate
--  directly. It does that. It also removes it from service_role, which is
--  the role the Edge Functions run as — because in Postgres, EXECUTE on a
--  function is granted to PUBLIC by default, and revoking from PUBLIC
--  takes it from everybody who had it only that way. service_role was one
--  of them.
--
--  So parent-signin asked the database whether a number may be sent a
--  code, the database answered "permission denied for function
--  parent_signin_check", and the function reported the only thing it
--  could: that it could not check.
--
--  SECURITY DEFINER DOES NOT HELP HERE, which is the part worth
--  remembering. It decides whose privileges the body runs WITH. It does
--  not decide who may call it. A locked door you own is still a locked
--  door.
--
--  WHAT STAYS REVOKED
--  anon and authenticated, deliberately. The gate is not a thing a
--  browser should be able to call: it writes to the send log and it
--  answers questions about which numbers exist. Only the Edge Functions,
--  holding the service role, go through it.
-- ════════════════════════════════════════════════════════════════════════

-- ─── The four the Edge Functions call ───────────────────────────────────
do $$
begin
  -- Written defensively: supabase_parent_password.sql may not have been
  -- run yet, and a missing function should not fail the two that matter
  -- for getting codes working again.
  if to_regprocedure('public.parent_signin_check(text)') is not null then
    execute 'grant execute on function parent_signin_check(text) to service_role';
  else
    raise notice 'parent_signin_check is not installed — run supabase_parent_signin_guard.sql';
  end if;

  if to_regprocedure('public.parent_signin_sent(uuid,boolean,text,text)') is not null then
    execute 'grant execute on function parent_signin_sent(uuid, boolean, text, text) to service_role';
  end if;

  if to_regprocedure('public.parent_login_check(text)') is not null then
    execute 'grant execute on function parent_login_check(text) to service_role';
  else
    raise notice 'parent_login_check is not installed — run supabase_parent_password.sql';
  end if;

  if to_regprocedure('public.parent_login_record(text,boolean)') is not null then
    execute 'grant execute on function parent_login_record(text, boolean) to service_role';
  end if;
end $$;


-- ─── Did it take? ───────────────────────────────────────────────────────
-- One statement, because the SQL editor shows the last one only. Reading
-- the privilege back rather than reporting that the grant ran: the grant
-- running is not the same claim as the Edge Function being able to call
-- the thing, and the second is what broke.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'parent_signin_check' as thing,
         case when to_regprocedure('public.parent_signin_check(text)') is null
                then 'NOT INSTALLED — run supabase_parent_signin_guard.sql first'
              when has_function_privilege('service_role',
                     'public.parent_signin_check(text)', 'execute')
                then 'the Edge Function can call it — asking for a code works again'
              else 'STILL DENIED — the grant did not take' end as detail
  union all
  select 2, 'parent_signin_sent',
         case when to_regprocedure('public.parent_signin_sent(uuid,boolean,text,text)') is null
                then 'not installed'
              when has_function_privilege('service_role',
                     'public.parent_signin_sent(uuid,boolean,text,text)', 'execute')
                then 'can record whether Twilio took the message'
              else 'STILL DENIED' end
  union all
  select 3, 'parent_login_check',
         case when to_regprocedure('public.parent_login_check(text)') is null
                then 'not installed — run supabase_parent_password.sql'
              when has_function_privilege('service_role',
                     'public.parent_login_check(text)', 'execute')
                then 'signing in with a password works'
              else 'STILL DENIED' end
  union all
  select 4, 'parent_login_record',
         case when to_regprocedure('public.parent_login_record(text,boolean)') is null
                then 'not installed'
              when has_function_privilege('service_role',
                     'public.parent_login_record(text,boolean)', 'execute')
                then 'can count the wrong tries'
              else 'STILL DENIED' end
  union all
  select 5, 'still shut out, on purpose',
         case when has_function_privilege('anon',
                     'public.parent_signin_check(text)', 'execute')
                then 'ANON CAN CALL THE GATE — that is wrong, tell me'
              else 'anon and authenticated cannot call the gate, which is right: '
                || 'it writes the send log and answers which numbers exist' end
  union all
  select 6, 'next',
         'Nothing to redeploy. The Edge Functions pick this up on their '
      || 'next call — try asking for a code again.'
  ) z
 order by z.k;
