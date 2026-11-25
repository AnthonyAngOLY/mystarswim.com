-- ════════════════════════════════════════════════════════════════════════
--  An archived family is signed out, not left holding the door
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  WHY
--  Archiving a family already stops them signing in: parent_signin_check
--  refuses to send a code and parent_login_check refuses a password,
--  both answering exactly as they would for a number we do not hold.
--
--  Neither of those runs for somebody who is ALREADY signed in. A phone
--  that signed in last month keeps its session, renews it quietly, and
--  goes on opening the app. What it showed after the family was archived
--  was the worst of both: the shell of the app, the parent's own name at
--  the top, and nothing underneath -- no children, no classes, no
--  progress. That reads as the system having lost their family, not as
--  an account that has been closed.
--
--  my_family() is what the app asks on the way in, so it is the right
--  place to say so. It answered ok:true with an empty children list,
--  which the app could only draw as an empty app.
--
--  WHAT ARCHIVING MEANS NOW, IN ONE PLACE
--    No code. No password. No app.
--    Everything kept: invoices, receipts, attendance, progress notes and
--    milestones all stay exactly where they are.
--    The office can still read and re-issue all of it. An ex-customer
--    who wants a receipt rings the centre, and somebody sends it.
--
--  That is deliberately not a deletion. A family that leaves is still a
--  family that swam here, and the record of it is the point of the
--  system.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. Is this family still with us? ───────────────────────────────────
-- The same question the sign-in gate asks, written once so the two
-- cannot drift: at least one swimmer still active.
create or replace function parent_account_is_live(p_account uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from students s
     where s.account_id = p_account
       and s.is_active is not false);
$$;

comment on function parent_account_is_live(uuid) is
  'Has this account any active swimmer? The one definition of "not '
  'archived", shared by the sign-in gate and the app itself.';


-- ─── 2. The app is told, rather than shown an empty shell ───────────────
-- Restated whole. The only change from supabase_parent_app_reads.sql is
-- the archived branch, and the message it carries -- which the app
-- prints verbatim, so the words a parent reads live here beside the rule
-- rather than in a build on somebody's phone.
create or replace function my_family()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_acct uuid; v_out jsonb;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;

  if not parent_account_is_live(v_acct) then
    -- Not "your account was deleted", because it was not. Nothing is
    -- gone and the office can send them any of it.
    return jsonb_build_object(
      'ok', false,
      'archived', true,
      'error', 'This account is no longer active. Nothing has been lost — '
            || 'call the centre and we can send you invoices, receipts or '
            || 'your child''s progress whenever you need them.');
  end if;

  select jsonb_build_object(
    'ok', true,
    'account_id', pa.id,
    'name', coalesce(nullif(btrim(pa.display_name), ''), 'there'),
    'phone', parent_signin_phone(pa),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                        order by s.name)
        from students s
       where s.account_id = pa.id and s.is_active is not false), '[]'::jsonb),
    'unread', (select count(*) from parent_messages m
                where m.account_id = pa.id and m.read_at is null))
    into v_out
    from parent_accounts pa where pa.id = v_acct;
  return v_out;
end $$;


-- ─── 3. Who may ask ─────────────────────────────────────────────────────
revoke all on function parent_account_is_live(uuid) from public, anon;
grant execute on function parent_account_is_live(uuid) to authenticated, service_role;
grant execute on function my_family() to authenticated;


-- ─── 4. What is now true ────────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'archived means' as thing,
         'no code, no password, and no app — the same answer at all three '
      || 'doors, and the same words a number we do not hold would get' as detail
  union all
  select 2, 'families this applies to now',
         (select count(*)::text from parent_accounts pa
           where not exists (select 1 from students s
                              where s.account_id = pa.id
                                and s.is_active is not false))
      || ' of ' || (select count(*)::text from parent_accounts)
      || ' accounts have no active swimmer'
  union all
  select 3, 'of those, already signed in somewhere',
         (select count(*)::text from parent_accounts pa
           where pa.auth_user_id is not null
             and not exists (select 1 from students s
                              where s.account_id = pa.id
                                and s.is_active is not false))
      || ' — they are signed out the next time their app asks, which is '
      || 'when it is opened or brought back to the front'
  union all
  select 4, 'what they keep',
         'Everything. Invoices, receipts, attendance, progress notes and '
      || 'milestones are untouched, and the office can read and re-issue '
      || 'all of it on request.'
  union all
  select 5, 'getting back in',
         'Un-archive the family in Admin → Accounts. The next sign-in '
      || 'works again with nothing else to do.'
  union all
  select 6, 'next',
         'Deploy the parent app (BUILD 9). Until then an archived family '
      || 'sees an empty app rather than the message above.'
  ) z
 order by z.k;
