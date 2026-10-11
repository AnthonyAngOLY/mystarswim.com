-- ============================================================================
-- Star Swim — Leave management, part 3: the HR Admin role
-- ----------------------------------------------------------------------------
-- The login function already mints ssb_role straight from app_users.role and
-- refreshes it on every sign-in, so a role added here reaches the JWT by
-- itself. No Edge Function needs redeploying.
--
-- All this file does is make sure the column will accept the new value, and
-- say so plainly if it finds a constraint it is not willing to rewrite.
-- ============================================================================

begin;

set local search_path = public, extensions;

do $$
declare
  v_con   record;
  v_stray text;
begin
  -- Anything already in use that the new constraint would reject.
  select string_agg(distinct role, ', ') into v_stray
    from app_users
   where role is not null
     and role not in ('sysadmin','admin','schedule_admin','hr_admin','staff');

  if v_stray is not null then
    raise exception
      'app_users holds roles this migration does not know about: %. Add them to the list in this file and re-run.',
      v_stray;
  end if;

  for v_con in
    select con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
     where c.relname = 'app_users'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table app_users drop constraint %I', v_con.conname);
    raise notice 'Replaced %: %', v_con.conname, v_con.def;
  end loop;

  alter table app_users
    add constraint app_users_role_valid
    check (role in ('sysadmin','admin','schedule_admin','hr_admin','staff'));

  raise notice 'app_users.role now accepts hr_admin.';
end $$;

commit;

-- ============================================================================
-- §VERIFY
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'app_users_role_valid';          -- includes hr_admin
--
-- GIVE SOMEONE THE ROLE
--   Settings → Users & Logins → set their role to HR Admin. They must sign
--   out and back in: the claim is refreshed at login, not on the fly.
--
--   Or directly:
--     update app_users set role = 'hr_admin' where username = 'someone';
--
-- ROLLBACK
--   alter table app_users drop constraint if exists app_users_role_valid;
-- ============================================================================
