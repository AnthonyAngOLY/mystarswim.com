-- ============================================================================
-- Star Swim Attendance — Phase 4: workers set their own password, once
-- ----------------------------------------------------------------------------
-- The admin hands out a password. The worker signs in with it and may replace
-- it with one of their own — once. After that it is fixed until an admin
-- issues a new one, which re-arms the single change.
--
-- That keeps the support model simple: a forgotten password is always
-- "ask the admin for a new one", never a self-service loop nobody is manning.
--
-- The flag lives in its own table rather than on the worker list, because the
-- worker list is still readable with the anon key by the legacy admin app, and
-- "this person is still on the password their boss gave them" is not something
-- to publish. This table is locked down from the start.
--
-- Additive. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

create table if not exists attendance_password_state (
  crew_id     uuid primary key,
  -- True while they are on an admin-issued password: their one change is
  -- available. False once they have used it.
  must_change boolean not null default true,
  changed_at  timestamptz,
  updated_at  timestamptz not null default now()
);

alter table attendance_password_state enable row level security;

do $$
declare v_tbl text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is not null and not exists (
    select 1 from pg_constraint where conname = 'attendance_password_state_crew_id_fkey'
  ) then
    execute format('alter table attendance_password_state add constraint attendance_password_state_crew_id_fkey foreign key (crew_id) references public.%I(id)', v_tbl);
  end if;
end $$;

-- Readable by the person it describes, and by admins. Never written from the
-- browser: only the staff-auth function, with the service role, sets it.
grant select on attendance_password_state to authenticated;
revoke all on attendance_password_state from anon;

drop policy if exists pwstate_worker_read on attendance_password_state;
create policy pwstate_worker_read on attendance_password_state for select
  using (crew_id = attendance_my_crew_id());
drop policy if exists pwstate_admin_read on attendance_password_state;
create policy pwstate_admin_read on attendance_password_state for select
  using (attendance_is_admin());

-- The worker app needs to know whether the change is still available, so it
-- rides along with the profile it already fetches. The return type changes,
-- which CREATE OR REPLACE cannot do, hence the drop.
drop function if exists get_my_profile();
create or replace function get_my_profile()
returns table (crew_id uuid, full_name text, staff_id text,
               is_admin boolean, consented_at timestamptz,
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
           coalesce(e.is_admin, false), c.consented_at,
           -- No row yet means a login made before this shipped: treat it as
           -- already personal rather than nagging them out of nowhere.
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

commit;

-- ============================================================================
-- §VERIFY
--   select * from attendance_password_state;        -- empty until a login is issued
--   select * from get_my_profile();                 -- now has must_change_password
--
-- TO RE-ARM SOMEONE'S CHANGE BY HAND (the Crew reset button does this for you)
--   update attendance_password_state set must_change = true, updated_at = now()
--    where crew_id = '...';
--
-- ROLLBACK
--   drop table if exists attendance_password_state;
--   -- then re-run the Phase 3 migration to restore the previous get_my_profile
-- ============================================================================
