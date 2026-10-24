-- ════════════════════════════════════════════════════════════════════════
--  Parent accounts — the thing students.account_id has been gesturing at
-- ════════════════════════════════════════════════════════════════════════
--  STEP 1 and STEP 2 change nothing. Read them both before STEP 3.
--  Nothing here is dropped, and no student row loses a field.
--
--  WHY THIS EXISTS
--  The parent app signs somebody in by phone number and then has to
--  answer one question: which children are yours? Nothing in the
--  database answers that today. students.account_id groups siblings when
--  it is filled in, but it points at nothing — there is no accounts
--  table — and where it is empty the office screens fall back to
--  clustering on email, then phone, then guardian name.
--
--  So this builds the table that pointer was always implying, fills it
--  from the students you already have, and leaves account_id meaning
--  exactly what it looks like it means.
--
--  TWO NUMBERS, ONE OF THEM PRIMARY
--  A family may register two phones. Exactly one is primary at a time
--  and that is the only one an OTP is ever sent to — either, never both.
--  Switching which is primary is a one-field change and the app can
--  offer it; a second number that is not primary cannot sign in.
--
--  PHONE NUMBERS BECOME ONE SHAPE
--  An OTP matches on the number, so "012-345 6789", "0123456789" and
--  "+60123456789" have to become one string or the same parent is three
--  people. They are normalised to E.164 (+60…). STEP 2 lists every
--  number that could not be read, and those families simply cannot sign
--  in until somebody fixes the number on the student record — which is
--  a thing to know now rather than on launch morning.
--
--  HOW FAMILIES ARE GROUPED
--  Exactly as the Accounts screen already groups them, so this does not
--  invent a second opinion: account_id if it is set, else email, else
--  phone, else guardian name. STEP 2 shows you the result before you
--  commit to it, including the ones worth a second look.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 — read a phone number the way a person would ════════════════
-- Malaysian mobiles, written however they were typed. Anything that is
-- not a Malaysian mobile comes back null and is reported, not guessed.
create or replace function ss_normalise_phone(p_raw text)
returns text
language plpgsql immutable
as $$
declare d text;
begin
  if p_raw is null then return null; end if;
  d := regexp_replace(p_raw, '[^0-9]', '', 'g');
  if d = '' then return null; end if;

  -- 60123456789 → +60123456789
  if left(d, 2) = '60' then
    d := substr(d, 3);
  -- 0123456789 → +60123456789
  elsif left(d, 1) = '0' then
    d := substr(d, 2);
  end if;

  -- A Malaysian mobile is 1 followed by 8 or 9 digits. Landlines and
  -- anything foreign fall out here rather than being bent into shape.
  if d ~ '^1[0-9]{8,9}$' then
    return '+60' || d;
  end if;
  return null;
end $$;

comment on function ss_normalise_phone(text) is
  'Malaysian mobile to E.164, or null if it is not one. An OTP matches '
  'on this string, so a number that cannot be read here cannot sign in.';

-- Which family a student belongs to, in one place. Written out three
-- times in the first draft of this file, and two of the three agreed —
-- the third left families with no phone unlinked. A rule used in more
-- than one query is a function.
create or replace function ss_family_key(s students)
returns text language sql immutable
as $$
  select coalesce(
    case when s.account_id is not null then 'id:' || s.account_id::text end,
    case when nullif(btrim(lower(s.guardian_email)), '') is not null
         then 'e:' || btrim(lower(s.guardian_email)) end,
    case when ss_normalise_phone(s.guardian_phone) is not null
         then 'p:' || ss_normalise_phone(s.guardian_phone) end,
    case when nullif(btrim(lower(s.guardian_name)), '') is not null
         then 'n:' || btrim(lower(s.guardian_name)) end,
    'x:' || s.id::text);
$$;

comment on function ss_family_key(students) is
  'The Accounts screen groups siblings by account_id, then email, then '
  'phone, then guardian name. This is that rule, so nothing here forms '
  'a second opinion about who is a family.';


-- ═══ STEP 2 — what STEP 3 would build. Changes nothing. ═════════════════

-- A. The families, as they would come out.
with g as (
  select s.*, ss_family_key(s) as family_key from students s
)
select count(*) filter (where true)                                as families,
       count(*) filter (where phone is not null)                   as can_sign_in,
       count(*) filter (where phone is null)                       as cannot_sign_in
  from (
    select family_key,
           max(ss_normalise_phone(guardian_phone)) as phone
      from g group by family_key
  ) f;

-- B. The ones that cannot sign in, by name, so they can be fixed.
with g as (
  select s.*, ss_family_key(s) as family_key from students s
)
select coalesce(max(nullif(btrim(guardian_name), '')), '— no name —') as guardian,
       max(guardian_phone)                      as phone_as_typed,
       string_agg(distinct name, ', ')          as children,
       'no usable mobile — cannot sign in'      as problem
  from g
 where ss_normalise_phone(guardian_phone) is null
 group by family_key
 order by 1;

-- C. Worth a second look: one phone, more than one guardian name. Either
--    a family with two spellings, or two families sharing a number.
select ss_normalise_phone(guardian_phone) as phone,
       string_agg(distinct btrim(guardian_name), ' | ') as names_on_it,
       count(distinct btrim(lower(guardian_name))) as how_many
  from students
 where ss_normalise_phone(guardian_phone) is not null
   and nullif(btrim(guardian_name), '') is not null
 group by 1
having count(distinct btrim(lower(guardian_name))) > 1
 order by 3 desc, 1;


-- ═══ STEP 3 — build it. ═════════════════════════════════════════════════
begin;

create table if not exists parent_accounts (
  id              uuid primary key default gen_random_uuid(),
  display_name    text,
  -- E.164. The primary is the only number an OTP is sent to.
  phone_primary   text,
  phone_secondary text,
  active_phone    text not null default 'primary'
                  check (active_phone in ('primary','secondary')),
  email           text,
  -- Set the first time they sign in. Null until then.
  auth_user_id    uuid unique,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now()
);

-- The number an OTP goes to, as one value, so nothing has to remember
-- the rule. A parent with no usable number has none, and is not a row
-- anybody can sign in as.
create or replace function parent_signin_phone(p parent_accounts)
returns text language sql immutable as $$
  select case when p.active_phone = 'secondary' then p.phone_secondary
              else p.phone_primary end;
$$;

-- Two accounts cannot answer to the same sign-in number, or an OTP has
-- two possible owners. Partial, because null is not a claim on anything.
create unique index if not exists parent_accounts_primary_phone_key
  on parent_accounts (phone_primary) where phone_primary is not null;
create unique index if not exists parent_accounts_secondary_phone_key
  on parent_accounts (phone_secondary) where phone_secondary is not null;

alter table parent_accounts enable row level security;

-- Office staff only, for now. The parent app's own policy arrives with
-- the app, so nothing can read this table from a browser until then.
drop policy if exists parent_accounts_office on parent_accounts;
create policy parent_accounts_office on parent_accounts
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all on parent_accounts from anon;
grant select, insert, update, delete on parent_accounts to authenticated;

-- ── The backfill ────────────────────────────────────────────────────────
-- One account per family. Every family gets its id up front, so linking
-- the students afterwards does not depend on matching a phone number —
-- which is how the first draft left the two families who have no phone
-- with no account at all, while cheerfully creating accounts for them.
create temporary table ss_family on commit drop as
with g as (
  select s.*, ss_family_key(s) as family_key from students s
)
select family_key,
       -- Keep the id account_id already held, where it held one, so every
       -- screen that groups on it keeps working unchanged.
       coalesce((array_agg(account_id) filter (where account_id is not null))[1],
                gen_random_uuid())                                as account_id,
       max(btrim(guardian_name))                                  as display_name,
       max(nullif(btrim(lower(guardian_email)), ''))              as email,
       max(ss_normalise_phone(guardian_phone))                    as phone_primary
  from g
 group by family_key;

-- on conflict do nothing covers both unique indexes. A family whose
-- number is already spoken for by another family gets no account rather
-- than quietly taking the number over — STEP 4 lists them.
insert into parent_accounts (id, display_name, email, phone_primary)
select account_id, display_name, email, phone_primary from ss_family
on conflict do nothing;

create temporary table ss_student on commit drop as
select s.id as student_id, ss_family_key(s) as family_key from students s;

update students s
   set account_id = f.account_id
  from ss_student sf
  join ss_family f on f.family_key = sf.family_key
 where s.id = sf.student_id
   and s.account_id is distinct from f.account_id
   and exists (select 1 from parent_accounts pa where pa.id = f.account_id);

commit;


-- ═══ STEP 4 — confirm ═══════════════════════════════════════════════════
select count(*)                                              as accounts,
       count(*) filter (where phone_primary is not null)     as can_sign_in,
       count(*) filter (where phone_primary is null)         as cannot_sign_in
  from parent_accounts;

-- Every student should have an account now. Anything listed here could
-- not be placed — almost always because another family already owns the
-- same phone number, which only one account can.
select s.name, s.guardian_name, s.guardian_phone,
       case when exists (select 1 from parent_accounts pa
                          where pa.phone_primary = ss_normalise_phone(s.guardian_phone))
            then 'that number belongs to another account'
            else 'no account — look at this one' end as why
  from students s
 where s.account_id is null
 order by 1;

-- Families the grouping merged because they share a phone number. This
-- is what the Accounts screen already shows, so it is not new — but it
-- is now the thing that decides who sees whose children, so read it.
select pa.display_name, pa.phone_primary,
       count(s.id) as children,
       string_agg(distinct btrim(s.guardian_name), ' | ') as guardian_names_merged
  from parent_accounts pa
  join students s on s.account_id = pa.id
 group by pa.id, pa.display_name, pa.phone_primary
having count(distinct btrim(lower(s.guardian_name))) > 1
 order by 1;

-- A sample to eyeball. Children should sit under the right parent.
select pa.display_name, pa.phone_primary, pa.active_phone,
       count(s.id) as children,
       string_agg(s.name, ', ' order by s.name) as who
  from parent_accounts pa
  left join students s on s.account_id = pa.id
 group by pa.id, pa.display_name, pa.phone_primary, pa.active_phone
 order by 4 desc, 1
 limit 20;
