-- ════════════════════════════════════════════════════════════════════════
--  Crew onboarding — a link new staff fill in themselves
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--
--  WHAT THIS IS FOR
--  Today a crew record is typed in by hand from a WhatsApp message or a
--  scrap of paper. This gives you a link to send instead. The new hire
--  fills in what only they know — name, IC, phone, emergency contact,
--  bank details — and it arrives as a pending application. Nobody is on
--  the crew list until you approve it, and you can correct anything they
--  typed before you do.
--
--  There is ONE live link at a time. The unique index below enforces
--  that: you cannot end up with three links in circulation and no idea
--  which is which. "Generate new link" revokes the old one in the same
--  breath, so a link that has got out of hand dies the moment you press
--  it.
--
--  WHAT A LEAKED LINK CAN AND CANNOT DO
--  It can submit an application. It CANNOT read anything: there is no
--  function here that returns crew data to an unauthenticated caller,
--  and check_crew_invite deliberately answers yes or no and nothing
--  else. So the worst a stranger with the link can do is put a row in
--  front of you that you decline — which is what the approval step is
--  for. That is the whole security model, and it is why the form is
--  allowed to be public at all.
--
--  WHO CAN GENERATE AND APPROVE
--  attendance_is_admin() — sysadmin, Centre Owner, Administrator. That
--  is Anthony, Clara and Rahimah, with no new permission to maintain.
--
--  WHAT APPROVAL DOES NOT DO
--  It does not create an attendance login. Passwords are handed over in
--  person so each person picks their own, so provisioning stays where it
--  is, on the Crew screen.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. The link ─────────────────────────────────────────────────────────
create table if not exists crew_invites (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  revoked_at  timestamptz,
  revoked_by  uuid
);

-- At most one live link, ever. A partial unique index on a constant is
-- the cheapest way to say "only one row may have revoked_at null".
create unique index if not exists crew_invites_one_live
  on crew_invites ((true)) where revoked_at is null;

-- ── 2. What people send in ──────────────────────────────────────────────
create table if not exists crew_applications (
  id              uuid primary key default gen_random_uuid(),
  invite_id       uuid references crew_invites(id),
  submitted_at    timestamptz not null default now(),
  status          text not null default 'pending',

  -- Theirs to fill.
  full_name       text not null,
  ic_no           text,
  phone           text,
  email           text,
  emergency_name  text,
  emergency_phone text,
  bank_name       text,
  bank_account    text,
  applicant_note  text,

  -- Yours.
  reviewed_at     timestamptz,
  reviewed_by     uuid,
  review_note     text,
  employee_id     uuid,

  constraint crew_applications_status_valid
    check (status in ('pending','approved','rejected'))
);

create index if not exists crew_applications_pending
  on crew_applications (submitted_at desc) where status = 'pending';

-- Nothing reaches these tables except through the functions below.
alter table crew_invites      enable row level security;
alter table crew_applications enable row level security;

do $$
begin
  -- Admins read both directly, which is what the admin screens do.
  if not exists (select 1 from pg_policies
                  where tablename = 'crew_applications' and policyname = 'admins read applications') then
    create policy "admins read applications" on crew_applications
      for select using (attendance_is_admin());
  end if;
  if not exists (select 1 from pg_policies
                  where tablename = 'crew_invites' and policyname = 'admins read invites') then
    create policy "admins read invites" on crew_invites
      for select using (attendance_is_admin());
  end if;
end $$;

-- ── 3. Generating and rotating the link ─────────────────────────────────
-- 32 random hex characters, from gen_random_uuid() rather than pgcrypto's
-- gen_random_bytes. Both draw on the same randomness, but gen_random_uuid
-- is core Postgres, while pgcrypto lives in the "extensions" schema on
-- Supabase — invisible to a function pinned to search_path = public, which
-- is where the first version of this failed with
--   function gen_random_bytes(integer) does not exist
-- 122 bits is far past guessing, and the endpoint it guards can only write.
create or replace function new_invite_token()
returns text
language sql volatile
as $$ select replace(gen_random_uuid()::text, '-', '') $$;

create or replace function get_crew_invite()
returns table (token text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare v_token text;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can see the onboarding link.';
  end if;

  select ci.token into v_token from crew_invites ci where ci.revoked_at is null limit 1;
  if v_token is null then
    v_token := new_invite_token();
    insert into crew_invites (token, created_by) values (v_token, auth.uid());
  end if;

  return query
    select ci.token, ci.created_at from crew_invites ci where ci.revoked_at is null limit 1;
end $$;

create or replace function rotate_crew_invite()
returns table (token text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare v_token text;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can change the onboarding link.';
  end if;

  -- Revoked, not deleted: applications keep pointing at the link they
  -- arrived through, so you can see which batch a person came from.
  update crew_invites
     set revoked_at = now(), revoked_by = auth.uid()
   where revoked_at is null;

  v_token := new_invite_token();
  insert into crew_invites (token, created_by) values (v_token, auth.uid());

  return query
    select ci.token, ci.created_at from crew_invites ci where ci.revoked_at is null limit 1;
end $$;

-- ── 4. What the public form may ask ─────────────────────────────────────
-- Yes or no, and nothing else. The form calls this on load so an expired
-- link says so up front instead of letting somebody type for five
-- minutes and then fail. It must never grow a second return value.
create or replace function check_crew_invite(p_token text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from crew_invites
     where token = p_token and revoked_at is null
  );
$$;

create or replace function submit_crew_application(p_token text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_invite uuid;
  v_name   text;
  v_ic     text;
  v_phone  text;
  v_email  text;
  v_id     uuid;
  v_open   int;
begin
  select id into v_invite from crew_invites
   where token = p_token and revoked_at is null limit 1;
  if v_invite is null then
    return jsonb_build_object('ok', false,
      'error', 'This link is no longer in use. Ask your manager for the current one.');
  end if;

  -- Trim everything, and cap every field. A public endpoint that stores
  -- whatever arrives is how a table fills with megabytes of nonsense.
  v_name  := left(btrim(coalesce(p_data->>'full_name',  '')), 120);
  v_ic    := left(btrim(coalesce(p_data->>'ic_no',      '')), 40);
  v_phone := left(btrim(coalesce(p_data->>'phone',      '')), 40);
  v_email := left(btrim(coalesce(p_data->>'email',      '')), 120);

  if length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Please enter your full name.');
  end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    return jsonb_build_object('ok', false, 'error', 'Please enter a phone number we can reach you on.');
  end if;
  if length(regexp_replace(v_ic, '\D', '', 'g')) < 6 then
    return jsonb_build_object('ok', false, 'error', 'Please enter your IC number.');
  end if;
  if v_email <> '' and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'That email address does not look right.');
  end if;

  -- The same person filling it in twice is the likeliest thing that will
  -- happen to this form, by some margin. Say so kindly rather than
  -- leaving two half-identical rows to reconcile.
  if exists (select 1 from crew_applications
              where status = 'pending'
                and regexp_replace(coalesce(ic_no,''), '\D', '', 'g')
                  = regexp_replace(v_ic, '\D', '', 'g')) then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'message', 'We already have your details. There is nothing more to do.');
  end if;

  -- A link that gets out should not be able to fill the table overnight.
  select count(*) into v_open from crew_applications where status = 'pending';
  if v_open >= 100 then
    return jsonb_build_object('ok', false,
      'error', 'The form is not accepting entries right now. Please speak to your manager.');
  end if;

  insert into crew_applications (
    invite_id, full_name, ic_no, phone, email,
    emergency_name, emergency_phone, bank_name, bank_account, applicant_note
  ) values (
    v_invite, v_name, v_ic, v_phone, nullif(v_email, ''),
    left(btrim(coalesce(p_data->>'emergency_name',  '')), 120),
    left(btrim(coalesce(p_data->>'emergency_phone', '')), 40),
    left(btrim(coalesce(p_data->>'bank_name',       '')), 80),
    left(btrim(coalesce(p_data->>'bank_account',    '')), 40),
    left(btrim(coalesce(p_data->>'applicant_note',  '')), 500)
  ) returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ── 5. Approving ────────────────────────────────────────────────────────
-- The applicant's fields can be corrected here; the employment fields are
-- yours alone and were never on the public form.
create or replace function decide_crew_application(
  p_id      uuid,
  p_approve boolean,
  p_fields  jsonb default '{}'::jsonb,
  p_note    text  default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a crew_applications%rowtype;
  v_emp uuid;
begin
  if not attendance_is_admin() then
    raise exception 'Only an administrator can decide an application.';
  end if;

  select * into a from crew_applications where id = p_id for update;
  if a.id is null then
    return jsonb_build_object('ok', false, 'error', 'That application no longer exists.');
  end if;
  if a.status <> 'pending' then
    return jsonb_build_object('ok', false,
      'error', 'This one was already ' || a.status || '.');
  end if;

  if not p_approve then
    update crew_applications
       set status = 'rejected', reviewed_at = now(),
           reviewed_by = auth.uid(), review_note = p_note
     where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  -- Columns named one at a time on purpose. A public form feeding a
  -- dynamic column list is how status, is_admin or auth_user_id end up
  -- settable by whoever holds the link.
  insert into admin_employees (
    full_name, ic_no, phone, email,
    emergency_name, emergency_phone, bank_name, bank_account,
    emp_no, position, department, employment_type, start_date, status, notes
  ) values (
    coalesce(nullif(btrim(p_fields->>'full_name'       ), ''), a.full_name),
    coalesce(nullif(btrim(p_fields->>'ic_no'           ), ''), a.ic_no),
    coalesce(nullif(btrim(p_fields->>'phone'           ), ''), a.phone),
    coalesce(nullif(btrim(p_fields->>'email'           ), ''), a.email),
    coalesce(nullif(btrim(p_fields->>'emergency_name'  ), ''), a.emergency_name),
    coalesce(nullif(btrim(p_fields->>'emergency_phone' ), ''), a.emergency_phone),
    coalesce(nullif(btrim(p_fields->>'bank_name'       ), ''), a.bank_name),
    coalesce(nullif(btrim(p_fields->>'bank_account'    ), ''), a.bank_account),
    nullif(btrim(coalesce(p_fields->>'emp_no',          '')), ''),
    nullif(btrim(coalesce(p_fields->>'position',        '')), ''),
    nullif(btrim(coalesce(p_fields->>'department',      '')), ''),
    nullif(btrim(coalesce(p_fields->>'employment_type', '')), ''),
    nullif(btrim(coalesce(p_fields->>'start_date',      '')), '')::date,
    coalesce(nullif(btrim(coalesce(p_fields->>'status', '')), ''), 'active'),
    nullif(btrim(coalesce(p_fields->>'notes',           '')), '')
  ) returning id into v_emp;

  update crew_applications
     set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(),
         review_note = p_note, employee_id = v_emp
   where id = p_id;

  return jsonb_build_object('ok', true, 'status', 'approved', 'employee_id', v_emp);
end $$;

-- ── 6. Who may call what ────────────────────────────────────────────────
-- anon reaches only the two the public form needs. Both are written to
-- give nothing away: one answers a boolean, the other writes a row.
revoke all on function get_crew_invite()                   from public, anon;
revoke all on function rotate_crew_invite()                from public, anon;
revoke all on function decide_crew_application(uuid, boolean, jsonb, text) from public, anon;

grant execute on function check_crew_invite(text)               to anon, authenticated;
grant execute on function submit_crew_application(text, jsonb)  to anon, authenticated;
grant execute on function get_crew_invite()                     to authenticated;
grant execute on function rotate_crew_invite()                  to authenticated;
grant execute on function decide_crew_application(uuid, boolean, jsonb, text) to authenticated;

-- ── What you should see ─────────────────────────────────────────────────
select 'crew_invites'      as table_name, count(*) as rows from crew_invites
union all
select 'crew_applications',                count(*)        from crew_applications;
