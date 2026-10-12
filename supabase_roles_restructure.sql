-- ============================================================================
-- Star Swim — roles, renamed around what people actually do
-- ----------------------------------------------------------------------------
-- Four roles instead of the three-plus-one that had grown up by accident:
--
--   sysadmin        Everything. Lands on the scheduling side.
--   center_owner    Everything, but lands on the system side with a button
--                   back to scheduling.
--   administrator   As the owner, minus the scheduler's Settings module.
--                   This is the HR seat: leave approvals and staff records.
--   scheduler       Lessons and invoices only. No Settings, and no way
--                   across to the system side.
--
-- The old names are kept valid so nobody is locked out between this running
-- and the roles being reassigned. They map on sight:
--
--   schedule_admin → scheduler
--   admin          → administrator
--   hr_admin       → administrator
--
-- Both apps read the role the same way, so a person's seat is one value in
-- one place rather than a set of flags to keep in step.
-- ============================================================================

begin;

set local search_path = public, extensions;

do $$
declare
  v_con   record;
  v_stray text;
begin
  select string_agg(distinct role, ', ') into v_stray
    from app_users
   where role is not null
     and role not in ('sysadmin','center_owner','administrator','scheduler',
                      'schedule_admin','admin','hr_admin','staff');
  if v_stray is not null then
    raise exception
      'app_users holds roles this migration does not know about: %. Add them to the list in this file and re-run.',
      v_stray;
  end if;

  for v_con in
    select con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con join pg_class c on c.oid = con.conrelid
     where c.relname = 'app_users' and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table app_users drop constraint %I', v_con.conname);
  end loop;

  alter table app_users
    add constraint app_users_role_valid
    check (role in ('sysadmin','center_owner','administrator','scheduler',
                    'schedule_admin','admin','hr_admin','staff'));
  raise notice 'app_users.role now accepts the four new names, old ones still valid.';
end $$;

-- ── The attendance side reads the same role ─────────────────────────────────
create or replace function attendance_is_hr()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_flag boolean; v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  -- hr_admin is the old name for administrator; both answer here.
  if coalesce(v_role, '') in ('sysadmin','center_owner','administrator','hr_admin') then
    return true;
  end if;

  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return false; end if;

  execute format('select coalesce(is_hr,false) from public.%I where auth_user_id = auth.uid() limit 1', v_tbl)
    into v_flag;
  return coalesce(v_flag, false);
end $$;

create or replace function attendance_is_admin()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_flag boolean; v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  -- A scheduler has no business on the attendance side, by either name.
  if coalesce(v_role, '') in ('sysadmin','center_owner','administrator',
                              'admin','hr_admin') then
    return true;
  end if;

  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return false; end if;

  execute format('select coalesce(is_admin,false) or coalesce(is_hr,false) from public.%I where auth_user_id = auth.uid() limit 1', v_tbl)
    into v_flag;
  return coalesce(v_flag, false);
end $$;

-- ── One rule, read the same way on both paths ───────────────────────────────
-- get_my_profile() used to hand back the crew record's own is_admin / is_hr
-- columns for a crew member, while an office caller got the answer from the
-- helper functions. Two sources for one question, and they could disagree:
-- somebody whose ROLE grants leave approval would lose it the moment they
-- signed in with a staff ID instead of their username.
--
-- Both branches now ask the same functions. The columns remain, and the
-- functions still read them, so anything already granted that way keeps
-- working — but nothing sets them any more. Management access is a property
-- of the person's role, decided in one place.
drop function if exists get_my_profile();
create or replace function get_my_profile()
returns table (crew_id uuid, full_name text, staff_id text,
               is_admin boolean, is_hr boolean, consented_at timestamptz,
               must_change_password boolean)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_tbl     text;
  v_namecol text;
  v_found   boolean := false;
  v_name    text;
  v_uid     text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
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
             attendance_is_admin(), attendance_is_hr(),
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

  if not (attendance_is_admin() or attendance_is_hr()) then
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
    attendance_is_admin(),
    attendance_is_hr(),
    null::timestamptz,
    false;
end $$;

revoke all on function get_my_profile() from public;
grant execute on function get_my_profile() to authenticated;

commit;

-- ============================================================================
-- §SET THE FIVE SEATS — run after the apps have been redeployed, then have
-- each person sign out and back in. The claim is minted at login.
--
--   update app_users set role = 'sysadmin'      where username = 'admin';
--   update app_users set role = 'center_owner'  where username = 'clara';
--   update app_users set role = 'administrator' where username = 'rahimah';
--   update app_users set role = 'scheduler'     where username in ('tony','zoe');
--
-- §VERIFY
--   select username, display_name, role from app_users order by role, username;
--
-- NOTE schedule_admin was never allowed on the attendance side and still is
-- not. A scheduler who needs to punch in needs a crew record and a staff ID,
-- like any other instructor.
-- ============================================================================
