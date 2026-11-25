-- ════════════════════════════════════════════════════════════════════════
--  Why "We could not check that just now"
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It changes nothing except reloading PostgREST's cache, which is itself
--  one of the things being tested.
--
--  WHAT IT IS FOR
--  parent-signin asks the database one question before it sends
--  anything: parent_signin_check(number). When that call fails, the
--  function has nothing useful to tell a parent and says it could not
--  check. The reason is in the Edge Function's log, behind a line that
--  starts "gate failed" — but it is quicker to ask the database the same
--  question here, as the same role, and read the answer directly.
--
--  Four things can be wrong and they look identical from the app:
--
--    The function is not installed. Nothing to call.
--    service_role cannot execute it. Installed, locked.
--    PostgREST has not noticed it. Installed, callable, and still
--      answers "could not find the function in the schema cache",
--      because PostgREST serves RPC from a cache it builds at start and
--      refreshes on a signal. A function created afterwards is invisible
--      until it reloads. This is the one that survives every other fix.
--    It raises on this number. Installed, callable, visible, and the
--      body itself errors.
--
--  IT WILL ADD ONE ROW to parent_otp_sends, because asking the real
--  question runs the real function. One row on a log of attempts is not
--  worth a more elaborate test.
--
--  PUT YOUR OWN MOBILE ON THE MARKED LINE BELOW.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 0. Tell PostgREST to look again ────────────────────────────────────
-- Harmless if it already knows. This alone fixes the third case above.
notify pgrst, 'reload schema';

create temp table if not exists _diag (k int, thing text, detail text);
truncate _diag;

do $$
declare
  -- ───────────────────────────────────────────────────────────────────
  --  ↓↓↓  YOUR MOBILE NUMBER HERE, the way you type it in the app.  ↓↓↓
  v_phone text := '012-524 3477';
  --  ↑↑↑                                                            ↑↑↑
  -- ───────────────────────────────────────────────────────────────────
  v_e164 text;
  v_out  jsonb;
  v_err  text;
begin
  -- The app sends E.164, so the test has to as well: the gate matches on
  -- the stored form, and '012...' would miss every row and look like a
  -- number that is not on file.
  v_e164 := case
    when v_phone like '+%' then '+' || regexp_replace(substr(v_phone, 2), '\D', '', 'g')
    when regexp_replace(v_phone, '\D', '', 'g') like '60%'
      then '+' || regexp_replace(v_phone, '\D', '', 'g')
    when regexp_replace(v_phone, '\D', '', 'g') like '0%'
      then '+60' || substr(regexp_replace(v_phone, '\D', '', 'g'), 2)
    else '+60' || regexp_replace(v_phone, '\D', '', 'g') end;

  insert into _diag values (1, 'the number, as the app sends it', v_e164);

  insert into _diag values (2, 'is the function installed',
    case when to_regprocedure('public.parent_signin_check(text)') is null
         then 'NO — run supabase_parent_signin_guard.sql'
         else 'yes' end);

  insert into _diag values (3, 'may service_role call it',
    case when to_regprocedure('public.parent_signin_check(text)') is null then 'n/a'
         when has_function_privilege('service_role',
                'public.parent_signin_check(text)', 'execute')
         then 'yes'
         else 'NO — run supabase_fix_signin_grants.sql' end);

  -- The real call, as the real role. Anything the body raises is caught
  -- and printed rather than thrown, so the rest of the report survives.
  if to_regprocedure('public.parent_signin_check(text)') is not null then
    begin
      execute 'set local role service_role';
      v_out := parent_signin_check(v_e164);
      execute 'reset role';
      insert into _diag values (4, 'asking it, as the Edge Function does',
        'it answered: ' || v_out::text);
      insert into _diag values (5, 'so',
        case when (v_out->>'ok') = 'true'
             then 'The database is fine. If the app still says it could not '
               || 'check, the Edge Function is calling it under a different '
               || 'name or PostgREST had not reloaded — part 0 has now told '
               || 'it to. Try the app again.'
             else 'The gate refused, which is not an error: the app would '
               || 'show "' || coalesce(v_out->>'error', '(no message)')
               || '" rather than "could not check".' end);
    exception when others then
      begin execute 'reset role'; exception when others then null; end;
      v_err := SQLERRM;
      insert into _diag values (4, 'asking it, as the Edge Function does',
        'IT RAISED: ' || v_err);
      insert into _diag values (5, 'so',
        'This is the error the app is reporting as "could not check". '
        || 'Send me the line above.');
    end;
  end if;

  insert into _diag values (6, 'rows in the send log',
    (select count(*)::text from parent_otp_sends)
    || ' — one of them is this test, if part 4 got that far');
end $$;

-- ─── One result, because the editor shows the last one only ─────────────
select k as "#", thing, detail from _diag order by k;
