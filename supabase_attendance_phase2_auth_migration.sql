-- ============================================================================
-- Star Swim — Phase 2 step 1: link scheduler logins to Supabase Auth
-- ----------------------------------------------------------------------------
-- Additive and safe to apply at any time, including before the app change
-- ships: it only adds a nullable column. Nothing reads it until the updated
-- `login` Edge Function is deployed.
--
-- Why this exists
--   Staff sign in against app_users (username + SHA-256 hash, checked server
--   side since Phase 0). The attendance module, and every table we RLS-protect
--   from here on, needs a real Supabase Auth JWT instead of the shared anon
--   key. This column remembers which auth.users row belongs to which
--   app_users row, so the login function can keep the two in step.
--
-- Migration strategy: LAZY, not big-bang.
--   Existing password hashes cannot be reversed, so there is no way to create
--   Auth users for everyone up front without resetting every password. Instead
--   the login function provisions each person's Auth user the first time they
--   sign in successfully, using the password they just typed. Nobody is reset,
--   nobody is locked out, and the migration completes itself as staff log in.
--
-- APPLY ORDER: this file first, then deploy the updated `login` function.
-- Applying it early is harmless; applying it late means logins keep working
-- but without a JWT, so attendance screens stay unavailable.
-- ============================================================================

begin;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'app_users' and c.relkind = 'r'
  ) then
    raise exception
      'Phase 2: public.app_users not found. Are you connected to the scheduler Supabase project?';
  end if;

  alter table public.app_users add column if not exists auth_user_id uuid;

  -- One Auth user per login. Partial, so the many pre-migration NULLs do not
  -- collide with each other.
  create unique index if not exists app_users_auth_user_id_key
    on public.app_users (auth_user_id) where auth_user_id is not null;
end $$;

commit;

-- ============================================================================
-- §VERIFY
--   select count(*) filter (where auth_user_id is not null) as migrated,
--          count(*)                                        as total
--   from app_users;
--
--   -- "migrated" climbs on its own as staff sign in. It does not need to
--   -- reach "total" for anything to work; each person upgrades on their
--   -- next login.
--
-- ROLLBACK
--   drop index if exists app_users_auth_user_id_key;
--   alter table app_users drop column if exists auth_user_id;
--   -- Also delete the provisioned users under Authentication → Users if you
--   -- want a clean slate; leaving them is harmless.
-- ============================================================================
