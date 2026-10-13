-- ════════════════════════════════════════════════════════════════════════
--  Administrator is a crew member with one login, not a second manager
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update alongside it: the two halves describe the same
--  rule and running only one leaves the screens and the database
--  disagreeing about who may approve a leave.
--
--  THE CHANGE
--  An Administrator who is also crew was getting both sides of the same
--  system: their own roster and leave, and the power to approve it. The
--  obvious shape of that is somebody approving their own leave.
--
--  So the phone's HR side — leave approvals, rostering, alerts — now
--  belongs to sysadmin and Centre Owner alone. An Administrator on the
--  phone is a crew member and nothing more. What changes for them is the
--  login, not the powers: the account they use for the website is the
--  account they clock in with.
--
--  WHAT AN ADMINISTRATOR KEEPS
--  Everything on the website: crew records, files, probation, vouchers,
--  procurement, the attendance admin screens. attendance_is_admin() is
--  deliberately untouched, because that is what gates those, and none of
--  it is self-dealing — approving your own leave is.
--
--  WHAT THEY LOSE
--  Leave approval, anywhere. Rostering and alerts on the phone.
--
--  LINKING NO LONGER DISPLACES A LOGIN
--  Pointing an office login at a crew record used to overwrite whatever
--  sign-in was already there. Do that to the wrong row and two people
--  break at once: the office person opens the app and sees somebody
--  else's schedule, and that somebody quietly stops having a crew record
--  at all. It is refused now, and says which login is in the way.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. The phone's HR side is sysadmin and Centre Owner ─────────────────
-- Role only. The per-crew is_hr / is_admin flags were taken off the crew
-- form deliberately — two places to grant the same thing is how somebody
-- ends up with a power nobody remembers giving them.
create or replace function attendance_is_hr()
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
  return coalesce(v_role, '') in ('sysadmin', 'center_owner');
end $$;

comment on function attendance_is_hr() is
  'Leave approval, phone rostering and alerts. sysadmin and Centre Owner '
  'only. An Administrator is crew on the phone and keeps the website '
  'admin screens, which attendance_is_admin() gates separately.';

-- ── 2. The profile the phone reads ──────────────────────────────────────
-- Both flags answer the same question now, because on the phone they
-- gate one bundle: roster, alerts, approvals. Keeping two names is for
-- the app that already reads them, not a distinction anybody acts on.
-- The column names are the live ones, to the letter. Postgres refuses to
-- rename an out parameter through create-or-replace, and the phone reads
-- must_change_password by name — renaming it is a forced password change
-- that quietly stops happening.
create or replace function get_my_profile()
returns table (crew_id uuid, full_name text, staff_id text,
               is_admin boolean, is_hr boolean, consented_at timestamptz,
               must_change_password boolean)
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_namecol text; v_found boolean; v_uid text; v_name text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;

  if v_tbl is not null then
    select a.attname into v_namecol from pg_attribute a
     where a.attrelid = format('public.%I', v_tbl)::regclass
       and a.attname in ('full_name','display_name','name')
     order by case a.attname when 'full_name' then 1 when 'display_name' then 2 else 3 end
     limit 1;

    execute format('select exists (select 1 from public.%I where auth_user_id = auth.uid())', v_tbl)
      into v_found;
  end if;

  if v_found then
    return query execute format($q$
      select e.id, e.%I::text, e.staff_id::text,
             attendance_is_hr(), attendance_is_hr(),
             c.consented_at,
             coalesce(p.must_change, false)
      from public.%I e
      left join attendance_consents c       on c.crew_id = e.id
      left join attendance_password_state p on p.crew_id = e.id
      where e.auth_user_id = auth.uid()
      limit 1
    $q$, v_namecol, v_tbl);
    return;
  end if;

  -- No crew record. Only the two seats that still have an HR side get the
  -- office layout; an Administrator without a crew record has nothing to
  -- do in this app, and saying so beats a screen with every button gone.
  if not attendance_is_hr() then
    return;
  end if;

  begin
    v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
  exception when others then
    v_uid := null;
  end;

  if v_uid is not null and to_regclass('public.app_users') is not null then
    begin
      select coalesce(nullif(btrim(u.display_name), ''), u.username)
        into v_name
        from app_users u
       where u.id = v_uid::uuid;
    exception when others then
      v_name := null;
    end;
  end if;

  return query select
    null::uuid,
    coalesce(v_name, 'Office')::text,
    null::text,
    true, true,
    null::timestamptz,
    false;
end $$;

-- ── 3. Linking must not displace a login ────────────────────────────────
create or replace function link_office_login(p_crew_id uuid, p_username text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_user   record;
  v_clash  text;
  v_name   text;
  v_had    uuid;
  v_hadid  text;
  v_office boolean;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can link a login.';
  end if;

  select e.full_name, e.auth_user_id, e.staff_id, e.login_is_office
    into v_name, v_had, v_hadid, v_office
    from admin_employees e where e.id = p_crew_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such crew record.');
  end if;

  -- The one that bit: linking used to overwrite whatever sign-in was
  -- already on the row. Pointed at the wrong person it breaks two people
  -- at once — the office login opens the app on somebody else's roster,
  -- and that somebody silently stops having a crew record.
  if v_had is not null then
    return jsonb_build_object('ok', false,
      'error', v_name || ' already signs in as "' || coalesce(v_hadid, '?') || '". '
            || case when v_office
                 then 'Unlink that office login first.'
                 else 'Remove that staff login first — and check this is the right row, '
                   || 'because an office login belongs on the office person''s own record.'
               end);
  end if;

  select u.id, u.username, u.auth_user_id, u.role, u.is_active
    into v_user
    from app_users u
   where lower(u.username) = lower(btrim(p_username))
   limit 1;

  if v_user.id is null then
    return jsonb_build_object('ok', false,
      'error', 'There is no office login called "' || btrim(p_username) || '".');
  end if;
  if v_user.is_active is false then
    return jsonb_build_object('ok', false,
      'error', 'That login is switched off. Turn it back on in Users & Logins first.');
  end if;
  if v_user.auth_user_id is null then
    return jsonb_build_object('ok', false,
      'error', 'That login has no sign-in account yet. Ask them to sign in to the '
            || 'scheduler once — signing in is what creates it — then link it.');
  end if;

  select e.full_name into v_clash
    from admin_employees e
   where e.auth_user_id = v_user.auth_user_id and e.id <> p_crew_id
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false,
      'error', 'That login is already linked to ' || v_clash || '.');
  end if;

  update admin_employees
     set auth_user_id    = v_user.auth_user_id,
         staff_id        = v_user.username,
         login_is_office = true
   where id = p_crew_id;

  return jsonb_build_object('ok', true, 'staff_id', v_user.username,
                            'role', v_user.role, 'full_name', v_name);
end $$;

-- ── Who may call what ───────────────────────────────────────────────────
revoke all on function get_my_profile()               from public, anon;
revoke all on function link_office_login(uuid, text)  from public, anon;
grant execute on function get_my_profile()            to authenticated;
grant execute on function link_office_login(uuid, text) to authenticated;

-- ── Who has the HR side now ─────────────────────────────────────────────
select u.username, u.role,
       case when u.role in ('sysadmin','center_owner')
            then 'approves leave, rosters and sees alerts'
            else 'crew on the phone' end as phone_side
  from app_users u
 where coalesce(u.is_active, true)
 order by 3, 1;

-- ── Any crew record answering to an office login ────────────────────────
-- Check the names line up. A row where they do not is the bug this file
-- closes, and it has to be unpicked by hand.
select e.full_name as crew_record,
       e.staff_id  as signs_in_as,
       u.display_name as that_login_belongs_to
  from admin_employees e
  join app_users u on u.auth_user_id = e.auth_user_id
 where e.login_is_office
 order by 1;
