-- ════════════════════════════════════════════════════════════════════════
--  Two more seats: Timetable (view only), and Customer Service
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update alongside it: the screens and these policies
--  describe the same two seats, and running only one leaves them
--  disagreeing about who may do what.
--
--  THE TWO SEATS
--    Timetable (view only)   The weekly Schedule screen and nothing
--                            else. Reads it, cannot change a thing —
--                            not a session, not a swimmer, not an
--                            invoice. No Accounts, Shop, Messages,
--                            Explore or Intake. No system side.
--    Customer Service        The scheduling side as a Scheduler has it,
--                            minus the session slots themselves and
--                            minus replacement handling. Accounts,
--                            invoices, receipts, the shop, messages,
--                            and enrolling a swimmer into a class.
--
--  WHY STAGE A IS NOT ENOUGH ON ITS OWN
--  Stage A drew one line, between the office and the open internet, and
--  gave every website seat the same reach behind it: one policy, all
--  four verbs, is_website_login(). That was the right line to draw
--  first and it is the wrong line to stop at, because a view-only seat
--  that can write is not view-only — it is a screen that happens not to
--  show the buttons.
--
--  So each table's policy splits in two. Reading stays open to every
--  seat. Writing asks a narrower question.
--
--    can_write_office()    every seat except the viewer
--    can_edit_sessions()   the seats that may create, move, retime or
--                          delete a class: sysadmin, Centre Owner,
--                          Administrator, Scheduler. Not CS.
--
--  THE ONE PLACE THE LINE IS SUBTLE
--  weekly_sessions is the class. weekly_session_students is who is in
--  it. Customer Service may write the second and not the first, which
--  is exactly "enrol a swimmer, do not move the class". They are
--  separate tables, so that is a line the database can hold rather than
--  a rule the screen merely observes.
-- ════════════════════════════════════════════════════════════════════════


-- ── 1. The role names exist ─────────────────────────────────────────────
do $$
declare v_con record;
begin
  for v_con in
    select conname from pg_constraint
     where conrelid = 'public.app_users'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table app_users drop constraint %I', v_con.conname);
  end loop;

  alter table app_users
    add constraint app_users_role_valid
    check (role in ('sysadmin','center_owner','administrator','scheduler',
                    'customer_service','timetable_viewer',
                    'schedule_admin','admin','hr_admin','staff'));
end $$;


-- ── 2. Who may write, and who may move a class ──────────────────────────
create or replace function can_write_office()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  -- Every website seat except the viewer. Written as "not the viewer"
  -- rather than as a list, so a seat added later can write by default
  -- and has to be taken away deliberately — the opposite would mean a
  -- new seat silently loses the ability to do its job.
  return coalesce(btrim(v_role), '') <> ''
     and coalesce(v_role, '') <> 'timetable_viewer';
end $$;

comment on function can_write_office() is
  'Any website seat that may change anything at all. The Timetable '
  '(view only) seat is the one that may not.';

create or replace function can_edit_sessions()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  -- A list, not an exclusion: moving a class is the thing Customer
  -- Service was created not to do, so a seat added later should have to
  -- be named here before it can.
  return coalesce(v_role, '') in
    ('sysadmin', 'center_owner', 'administrator', 'scheduler',
     'admin', 'hr_admin', 'schedule_admin');
end $$;

comment on function can_edit_sessions() is
  'May create, move, retime or delete a class, and handle replacements. '
  'Customer Service may not; they enrol swimmers into classes that '
  'already exist.';

revoke all on function can_write_office()  from public, anon;
revoke all on function can_edit_sessions() from public, anon;
grant execute on function can_write_office()  to authenticated;
grant execute on function can_edit_sessions() to authenticated;


-- ── 3. Split every office policy into read and write ────────────────────
do $$
declare
  t text;
  -- The class itself, and replacement handling. Writing these is the
  -- Scheduler's job, not Customer Service's.
  v_sessions text[] := array[
    'weekly_sessions', 'session_instructors', 'replacement_pending'
  ];
  -- Everything else on the scheduling side, plus the two Stage B tables
  -- the office owns. Reading is open to every seat; writing is not.
  v_office text[] := array[
    'billing_terms','calendar_remarks','code_redemptions','credit_purchases',
    'family_group_members','family_groups','invoice_lines','invoice_settings',
    'invoices','operating_hours','packages','payments','pending_credits',
    'pools','products','programme_categories','programme_sessions',
    'scheduler_codes','scheduler_durations','scheduler_instructors',
    'scheduler_lesson_types','student_credit_balances','student_enrollments',
    'weekly_session_students','students','tc_acceptances',
    'promos','branches','contact_messages'
  ];
  v_n int := 0;
begin
  foreach t in array v_sessions || v_office loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'skipped %, which is not in this database', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- The single all-verbs policy Stage A and Stage B left behind.
    execute format('drop policy if exists %I on public.%I', t || '_office', t);
    execute format('drop policy if exists %I on public.%I', t || '_read',  t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);

    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (is_website_login())', t || '_read', t);

    if t = any(v_sessions) then
      execute format(
        'create policy %I on public.%I for all to authenticated '
        'using (can_edit_sessions()) with check (can_edit_sessions())',
        t || '_write', t);
    else
      execute format(
        'create policy %I on public.%I for all to authenticated '
        'using (can_write_office()) with check (can_write_office())',
        t || '_write', t);
    end if;

    v_n := v_n + 1;
  end loop;
  raise notice 'Split % tables into read and write.', v_n;
end $$;

-- The public key's three doors are untouched by the loop above, which
-- only drops policies named _office, _read and _write. Stated here so
-- nobody has to go and check.


-- ═══ Confirm ════════════════════════════════════════════════════════════

-- Every office table should now show one SELECT policy and one ALL
-- policy. A table with only an ALL policy was missed.
-- The parentheses matter, and the first draft of this query did not have
-- them: `a and b or c` is `(a and b) or c`, so it reached outside the
-- schema entirely. It also counted the anon read on promos and branches
-- as one of ours, and reported two healthy tables as broken.
select tablename,
       count(*) filter (where cmd = 'SELECT') as read_policies,
       count(*) filter (where cmd = 'ALL')    as write_policies,
       string_agg(distinct policyname, ', ' order by policyname) as named
  from pg_policies
 where schemaname = 'public'
   and (policyname like '%\_read' or policyname like '%\_write')
   and policyname not like '%\_public\_read'
 group by tablename
having count(*) filter (where cmd = 'SELECT') <> 1
    or count(*) filter (where cmd = 'ALL')    <> 1
 order by 1;
-- Nothing should come back.

-- The seats, as they now stand.
select u.username, u.display_name, u.role,
       case u.role
         when 'timetable_viewer' then 'the Schedule screen, read only'
         when 'customer_service' then 'scheduling side, no session changes'
         when 'scheduler'        then 'scheduling side in full'
         when 'administrator'    then 'both website sides'
         else 'everything' end as reach
  from app_users u
 where coalesce(u.is_active, true)
 order by case u.role when 'sysadmin' then 1 when 'center_owner' then 2
                      when 'administrator' then 3 when 'scheduler' then 4
                      when 'customer_service' then 5 else 6 end, u.username;
