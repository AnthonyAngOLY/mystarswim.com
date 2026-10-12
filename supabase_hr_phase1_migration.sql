-- ════════════════════════════════════════════════════════════════════════
--  HR phase 1 — one login for office staff, crew files, and probation
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update first or alongside; this file alone changes
--  nothing anyone can see.
--
--  Three unrelated things, shipped together because they are one deploy.
--
--  1. LINKING AN OFFICE LOGIN TO A CREW RECORD
--     Rahimah is an employee — she has a start date, leave, an offer
--     letter — and she is also an Administrator who rosters and approves
--     leave. Those are not two people and must not be two passwords.
--
--     The capability already exists: get_my_profile returns is_hr and
--     is_admin from the ROLE, next to a crew_id, so a crew member whose
--     login is an Administrator gets their own attendance AND the HR
--     side. What was missing is a way to point a crew record at a login
--     that already exists instead of minting a second one.
--
--     Note what this does NOT add: no new role, no new permission, no
--     "is HR" tick box on the crew form. The role decides, as it has
--     since the roles were restructured.
--
--  2. CREW FILES
--     A private bucket for offer letters and the like. Visible only to
--     sysadmin, Centre Owner and Administrator — not to the crew member
--     themselves, who has no business reading the file store even for
--     their own folder, because what gets filed there is correspondence
--     about them rather than to them.
--
--  3. PROBATION
--     Full-time (probation) carries an end date. The roster highlights a
--     row as that date approaches so somebody confirms or extends rather
--     than letting it lapse, which in Malaysia means confirmed by
--     default and nobody intended it.
-- ════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════
--  1. ONE LOGIN FOR SOMEBODY WHO IS BOTH
-- ════════════════════════════════════════════════════════════════════════

alter table admin_employees
  add column if not exists login_is_office boolean not null default false;

comment on column admin_employees.login_is_office is
  'True when auth_user_id points at an existing office (app_users) login '
  'rather than a staff login minted for this crew record. The difference '
  'matters: removing a staff login deletes the auth user, which for an '
  'office login would delete somebody''s scheduler account.';

-- Link. The login must have signed in at least once, because app_users
-- only learns its auth_user_id on first sign-in.
create or replace function link_office_login(p_crew_id uuid, p_username text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_user   record;
  v_clash  text;
  v_name   text;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can link a login.';
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
      'error', 'That login has never been used. Ask them to sign in to the '
            || 'scheduler once, then link it — the sign-in is what creates '
            || 'the account this points at.');
  end if;

  select e.full_name into v_clash
    from admin_employees e
   where e.auth_user_id = v_user.auth_user_id and e.id <> p_crew_id
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false,
      'error', 'That login is already linked to ' || v_clash || '.');
  end if;

  select e.full_name into v_name from admin_employees e where e.id = p_crew_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such crew record.');
  end if;

  update admin_employees
     set auth_user_id    = v_user.auth_user_id,
         staff_id        = v_user.username,
         login_is_office = true
   where id = p_crew_id;

  return jsonb_build_object('ok', true, 'staff_id', v_user.username,
                            'role', v_user.role, 'full_name', v_name);
end $$;

-- Unlink an office login. Clears the link and nothing else: the office
-- account carries on existing, because it was never ours to delete.
create or replace function unlink_office_login(p_crew_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_office boolean;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can unlink a login.';
  end if;

  select login_is_office into v_office from admin_employees where id = p_crew_id;
  if v_office is null then
    return jsonb_build_object('ok', false, 'error', 'No such crew record.');
  end if;
  if not v_office then
    return jsonb_build_object('ok', false,
      'error', 'This is a staff login, not an office one. Remove it from the '
            || 'crew row instead — that deletes the sign-in, which is right '
            || 'for a staff login and wrong for an office one.');
  end if;

  update admin_employees
     set auth_user_id = null, login_is_office = false
   where id = p_crew_id;

  return jsonb_build_object('ok', true);
end $$;

-- The office logins worth offering, with whether each is already spoken
-- for. Names and roles only — no password state, nothing sensitive.
create or replace function office_logins_for_linking()
returns table (username text, display_name text, role text,
               has_signed_in boolean, linked_to text)
language sql security definer set search_path = public stable
as $$
  select u.username::text,
         coalesce(nullif(btrim(u.display_name), ''), u.username)::text,
         u.role::text,
         u.auth_user_id is not null,
         (select e.full_name from admin_employees e
           where e.auth_user_id = u.auth_user_id limit 1)::text
    from app_users u
   where attendance_is_admin()
     and coalesce(u.is_active, true)
   order by u.username;
$$;

-- ════════════════════════════════════════════════════════════════════════
--  2. CREW FILES
-- ════════════════════════════════════════════════════════════════════════

create table if not exists crew_documents (
  id          uuid primary key default gen_random_uuid(),
  crew_id     uuid not null references admin_employees(id),
  kind        text not null default 'offer_letter',
  file_path   text not null,
  file_name   text not null,
  mime        text,
  bytes       integer,
  note        text,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  constraint crew_documents_kind_valid check (kind in
    ('offer_letter','contract','amendment','id_document','certificate',
     'appraisal','warning','resignation','other'))
);

create index if not exists crew_documents_by_crew
  on crew_documents (crew_id, uploaded_at desc);

alter table crew_documents enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename='crew_documents' and policyname='admins read crew files') then
    create policy "admins read crew files" on crew_documents
      for select using (attendance_is_admin());
  end if;
  if not exists (select 1 from pg_policies
                  where tablename='crew_documents' and policyname='admins add crew files') then
    create policy "admins add crew files" on crew_documents
      for insert with check (attendance_is_admin());
  end if;
  if not exists (select 1 from pg_policies
                  where tablename='crew_documents' and policyname='admins remove crew files') then
    create policy "admins remove crew files" on crew_documents
      for delete using (attendance_is_admin());
  end if;
end $$;

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No storage schema here — skipping the bucket (expected outside Supabase).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('crew-docs', 'crew-docs', false, 10485760,
          array['application/pdf','image/jpeg','image/png'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Unlike leave-docs, there is no "own folder" rule here. A crew member
  -- reading their own folder would be reading the file the office keeps
  -- about them, which is a different thing from a certificate they sent.
  execute $p$ drop policy if exists crew_docs_admin_insert on storage.objects $p$;
  execute $p$
    create policy crew_docs_admin_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'crew-docs' and attendance_is_admin()) $p$;

  execute $p$ drop policy if exists crew_docs_admin_read on storage.objects $p$;
  execute $p$
    create policy crew_docs_admin_read on storage.objects for select to authenticated
    using (bucket_id = 'crew-docs' and attendance_is_admin()) $p$;

  execute $p$ drop policy if exists crew_docs_admin_delete on storage.objects $p$;
  execute $p$
    create policy crew_docs_admin_delete on storage.objects for delete to authenticated
    using (bucket_id = 'crew-docs' and attendance_is_admin()) $p$;

  raise notice 'crew-docs bucket ready (private, 10 MB, PDF and images).';
end $$;

-- Removing the row removes the file. Done here rather than in the app so
-- a delete from anywhere cannot leave the object behind — "unreachable"
-- is not what anybody means by deleted.
create or replace function delete_crew_document(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_path text;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can remove a crew file.';
  end if;
  select file_path into v_path from crew_documents where id = p_id;
  if v_path is null then
    return jsonb_build_object('ok', false, 'error', 'That file is already gone.');
  end if;
  delete from crew_documents where id = p_id;
  return jsonb_build_object('ok', true, 'file_path', v_path);
end $$;

-- ════════════════════════════════════════════════════════════════════════
--  3. PROBATION
-- ════════════════════════════════════════════════════════════════════════

alter table admin_employees
  add column if not exists probation_until date;

comment on column admin_employees.probation_until is
  'The day probation ends. Set only while employment_type is '
  '"Full-time (probation)". Null means there is nothing to decide.';

-- Every move on a probation, kept. An extension is a thing somebody
-- decided and may later have to account for.
create table if not exists crew_probation_log (
  id         uuid primary key default gen_random_uuid(),
  crew_id    uuid not null references admin_employees(id),
  action     text not null,
  until      date,
  note       text,
  decided_by uuid,
  decided_at timestamptz not null default now(),
  constraint crew_probation_log_action_valid
    check (action in ('started','extended','confirmed','ended'))
);

create index if not exists crew_probation_log_by_crew
  on crew_probation_log (crew_id, decided_at desc);

alter table crew_probation_log enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename='crew_probation_log' and policyname='admins read probation log') then
    create policy "admins read probation log" on crew_probation_log
      for select using (attendance_is_admin());
  end if;
end $$;

-- Start or extend. One function, because the only difference is whether
-- there was already a date, and the log records which it was.
create or replace function set_probation(
  p_crew_id uuid,
  p_until   date,
  p_note    text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_had date; v_name text;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can set a probation period.';
  end if;
  select full_name, probation_until into v_name, v_had
    from admin_employees where id = p_crew_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such crew record.');
  end if;
  if p_until is null then
    return jsonb_build_object('ok', false, 'error', 'Choose how long the probation runs.');
  end if;
  if v_had is not null and p_until <= v_had then
    return jsonb_build_object('ok', false,
      'error', 'An extension has to end later than the date it is replacing ('
            || to_char(v_had, 'DD Mon YYYY') || ').');
  end if;

  update admin_employees
     set probation_until = p_until,
         employment_type = 'Full-time (probation)'
   where id = p_crew_id;

  insert into crew_probation_log (crew_id, action, until, note, decided_by)
  values (p_crew_id, case when v_had is null then 'started' else 'extended' end,
          p_until, nullif(btrim(coalesce(p_note,'')),''), auth.uid());

  return jsonb_build_object('ok', true, 'until', p_until,
    'action', case when v_had is null then 'started' else 'extended' end);
end $$;

-- Confirm. The probation ends today and the contract becomes full-time.
create or replace function confirm_probation(p_crew_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_name text; v_until date;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can confirm somebody.';
  end if;
  select full_name, probation_until into v_name, v_until
    from admin_employees where id = p_crew_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such crew record.');
  end if;

  update admin_employees
     set probation_until = null,
         employment_type = 'Full-time'
   where id = p_crew_id;

  insert into crew_probation_log (crew_id, action, until, note, decided_by)
  values (p_crew_id, 'confirmed', v_until,
          nullif(btrim(coalesce(p_note,'')),''), auth.uid());

  return jsonb_build_object('ok', true, 'full_name', v_name);
end $$;

-- ── Who may call what ───────────────────────────────────────────────────
revoke all on function link_office_login(uuid, text)      from public, anon;
revoke all on function unlink_office_login(uuid)          from public, anon;
revoke all on function office_logins_for_linking()        from public, anon;
revoke all on function delete_crew_document(uuid)         from public, anon;
revoke all on function set_probation(uuid, date, text)    from public, anon;
revoke all on function confirm_probation(uuid, text)      from public, anon;

grant execute on function link_office_login(uuid, text)   to authenticated;
grant execute on function unlink_office_login(uuid)       to authenticated;
grant execute on function office_logins_for_linking()     to authenticated;
grant execute on function delete_crew_document(uuid)      to authenticated;
grant execute on function set_probation(uuid, date, text) to authenticated;
grant execute on function confirm_probation(uuid, text)   to authenticated;

-- ── What you should see ─────────────────────────────────────────────────
select 'crew_documents'     as table_name, count(*) as rows from crew_documents
union all
select 'crew_probation_log',                count(*)        from crew_probation_log;
