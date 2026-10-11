-- ============================================================================
-- Star Swim — one credential per person
-- ----------------------------------------------------------------------------
-- Scheduler logins and staff logins are already the same Supabase Auth
-- accounts: both are minted as <name>@staff.mystarswim.internal. A coordinator
-- who signs into the scheduler therefore already has an Auth identity the
-- phone app can accept — the only thing stopping it was get_my_profile(),
-- which looks the caller up in the crew table and gives up when they are not
-- in it.
--
-- So: a caller with no crew row but an admin or HR claim gets a profile with
-- crew_id null. The app reads that as "this person does not teach" and opens
-- straight into the HR side, with no shifts of their own to show.
--
-- Nobody needs a second password, and nobody needs a crew record invented for
-- them so that a lookup can succeed.
--
-- Run after supabase_leave_phase4_hr_on_phone.sql.
-- ============================================================================

begin;

set local search_path = public, extensions;

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
             coalesce(e.is_admin, false), coalesce(e.is_hr, false),
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

  -- No worker row. Only someone the system already trusts gets a profile at
  -- all — an unknown account still gets nothing, exactly as before.
  if not (attendance_is_admin() or attendance_is_hr()) then
    return;
  end if;

  begin
    v_uid := auth.jwt() -> 'app_metadata' ->> 'app_user_id';
  exception when others then
    v_uid := null;
  end;

  -- Their name from the scheduler account, so the header says who they are
  -- rather than nothing.
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

  -- crew_id null is the signal: no sessions of their own, so no consent to
  -- ask for and no punching to offer.
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
-- §VERIFY — as a scheduler user with no crew row, the phone app should now
-- get a profile with crew_id null and is_hr true.
--   select * from get_my_profile();
--
-- WHO WOULD COLLIDE — a staff ID equal to a scheduler username is the same
-- Auth account. Check before issuing one:
--   select u.username
--     from app_users u
--     join admin_employees e
--       on lower(e.staff_id) = lower(u.username)
--    where e.staff_id is not null;
--
-- ROLLBACK
--   re-run supabase_leave_phase4_hr_on_phone.sql
-- ============================================================================
