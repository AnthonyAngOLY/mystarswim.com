-- ============================================================================
-- Star Swim — HR on the phone
-- ----------------------------------------------------------------------------
-- An HR person signs into the worker app with their staff ID like everyone
-- else. No second login, no separate app, no Edge Function redeploy — because
-- attendance_is_admin() already recognises two independent routes, and this
-- adds the same pair to attendance_is_hr().
--
--   Route 1  a role claim in the JWT, for someone whose account lives in
--            app_users and who may have no worker row at all.
--   Route 2  a flag on their own worker row, for someone who signs in as
--            staff — which is what the phone does.
--
-- An HR flag also carries attendance-admin rights. Deliberate: the point of
-- this is HR setting a roster and reading alerts from a phone, and making
-- that depend on remembering to tick a second box would mean a half-working
-- account nobody could diagnose.
--
-- Run after the leave migrations.
-- ============================================================================

begin;

set local search_path = public, extensions;

-- ── 1. The flag ─────────────────────────────────────────────────────────────
do $$
declare v_tbl text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then
    raise exception 'No worker table found (looked for crew, admin_employees).';
  end if;
  execute format('alter table public.%I add column if not exists is_hr boolean not null default false', v_tbl);
  raise notice 'is_hr added to public.%', v_tbl;
end $$;

-- ── 2. Who counts as HR ─────────────────────────────────────────────────────
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
  if coalesce(v_role, '') in ('hr_admin','sysadmin') then return true; end if;

  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return false; end if;

  execute format('select coalesce(is_hr,false) from public.%I where auth_user_id = auth.uid() limit 1', v_tbl)
    into v_flag;
  return coalesce(v_flag, false);
end $$;

-- ── 3. HR reaches the roster and the alerts ─────────────────────────────────
-- Unchanged in every other respect; the hr_admin claim and the is_hr flag are
-- simply added to the two routes already here.
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
  if coalesce(v_role, '') in ('sysadmin','schedule_admin','admin','hr_admin') then
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

-- ── 4. The app needs to know which it is talking to ─────────────────────────
-- The return type gains a column, which CREATE OR REPLACE cannot do.
drop function if exists get_my_profile();
create or replace function get_my_profile()
returns table (crew_id uuid, full_name text, staff_id text,
               is_admin boolean, is_hr boolean, consented_at timestamptz,
               must_change_password boolean)
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_namecol text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return; end if;

  select a.attname into v_namecol from pg_attribute a
  where a.attrelid = format('public.%I', v_tbl)::regclass
    and a.attname in ('full_name','display_name','name')
  order by case a.attname when 'full_name' then 1 when 'display_name' then 2 else 3 end
  limit 1;

  return query execute format($q$
    select e.id, e.%I::text, e.staff_id::text,
           coalesce(e.is_admin, false), coalesce(e.is_hr, false),
           c.consented_at,
           coalesce(p.must_change, false)
    from public.%I e
    left join attendance_consents c       on c.crew_id = e.id
    left join attendance_password_state p on p.crew_id = e.id
    where e.auth_user_id = auth.uid()
    limit 1
  $q$, v_namecol, v_tbl);
end $$;

revoke all on function get_my_profile() from public;
grant execute on function get_my_profile() to authenticated;

-- ── 5. The phone needs the crew list to roster with ─────────────────────────
-- Names only, and only for someone who may roster. The worker table carries
-- bank details and IC numbers; none of that belongs in a phone's memory.
create or replace function get_rosterable_crew()
returns table (id uuid, full_name text, staff_id text)
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_namecol text; v_arch text := '';
begin
  if not attendance_is_admin() then return; end if;

  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return; end if;

  select a.attname into v_namecol from pg_attribute a
  where a.attrelid = format('public.%I', v_tbl)::regclass
    and a.attname in ('full_name','display_name','name')
  order by case a.attname when 'full_name' then 1 when 'display_name' then 2 else 3 end
  limit 1;

  -- Archived crew are off the roster, but only if that migration has run.
  if exists (select 1 from pg_attribute
              where attrelid = format('public.%I', v_tbl)::regclass
                and attname = 'archived_at' and not attisdropped) then
    v_arch := ' and e.archived_at is null';
  end if;

  return query execute format(
    'select e.id, e.%I::text, e.staff_id::text from public.%I e where true%s order by e.%I',
    v_namecol, v_tbl, v_arch, v_namecol);
end $$;

revoke all on function get_rosterable_crew() from public;
grant execute on function get_rosterable_crew() to authenticated;

commit;

-- ============================================================================
-- §VERIFY
--   select column_name from information_schema.columns
--    where table_name in ('crew','admin_employees') and column_name='is_hr';   -- 1 row
--
-- MAKE SOMEONE HR ON THE PHONE
--   update admin_employees set is_hr = true where staff_id = 'tony';
--   They must sign out of the worker app and back in.
--
-- WHO HAS IT
--   select full_name, staff_id, is_admin, is_hr from admin_employees
--    where is_hr or is_admin;
--
-- ROLLBACK
--   alter table admin_employees drop column if exists is_hr;
--   -- then re-run phase 1 §9 and phase 4 to restore the two functions
-- ============================================================================
