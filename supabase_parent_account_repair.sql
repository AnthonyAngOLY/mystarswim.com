-- ════════════════════════════════════════════════════════════════════════
--  Children whose account_id points at nothing
-- ════════════════════════════════════════════════════════════════════════
--  STEP 1 changes nothing. Read it, then run STEP 2.
--
--  WHAT THE LAST QUERY TURNED UP
--  Three numbers with two guardian names on them, and in every case one
--  of the two reads "— none —" for its account. Those children are not
--  unattached: account_id holds a value. It points at a row that does
--  not exist.
--
--  Here is how. The intake form used to mint a random account_id for
--  every submission, so two submissions from one household carried two
--  different ids. The backfill groups families by that id first, so they
--  stayed two families — and only one of the two could take the phone
--  number, because an OTP can have exactly one owner. The other got no
--  account at all, while its children kept pointing at the id that was
--  never created.
--
--  WHY THIS MATTERS MORE THAN IT LOOKS
--  A dangling pointer is worse than no pointer. The worklist asks
--  "account_id is null" and these are not null, so they do not appear on
--  it. The parent app asks "which children belong to this account" and
--  these belong to none, so they would not appear there either. The
--  parent signs in, sees one child, and has no way to know the other is
--  missing. Nobody is told anything.
--
--  WHAT THIS DOES
--  Attaches them to the account that already owns their phone number —
--  the same rule as everywhere else, and the rule you set: all children
--  under one number are one family. Where there is no such account, it
--  makes one. Where the number cannot be read at all, it leaves them and
--  names them, because that is a question for a person.
--
--  A PLACEHOLDER IS NOT A FAMILY
--  +60123456789 is a number three different people typed to get past a
--  required field. Joining children to it would put unrelated families
--  in one account that anybody could guess their way into, so numbers
--  of that shape are left alone and named instead.
--
--  THE MERGES ARE LISTED, AND SOME WILL BE WRONG
--  "Muhammad Ali" and "MUHAMMAD ALI BIN HABIBULLAH" are plainly one
--  person. "Lee Oy Yin" and "Seoh (Seoh Zun Ding)" may well not be.
--  STEP 3 lists every family this joined together under one number so
--  Zoe can split the ones that should not have been.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ STEP 0 — what a made-up number looks like ══════════════════════════
-- A placeholder typed to get past a required field is not an identity,
-- and joining children to one herds unrelated families together. The
-- worklist asks the same question, so it asks it through this.
create or replace function ss_phone_looks_fake(p_phone text)
returns boolean
language sql immutable
as $$
  select p_phone is not null
     and (regexp_replace(p_phone, '^\+60', '') ~ '^1?23456789'
       or regexp_replace(p_phone, '[^0-9]', '', 'g') ~ '(.)\1{6,}');
$$;

comment on function ss_phone_looks_fake(text) is
  '123456789, 0111111111 and friends. Not a number anybody owns, so not '
  'a number to group a family by.';


-- ═══ STEP 1 — who is adrift, and where they would go ════════════════════
select s.name                                   as child,
       btrim(s.guardian_name)                   as guardian,
       s.guardian_phone                         as phone_as_typed,
       case when s.account_id is null then 'no account id at all'
            else 'account id points at nothing' end as how,
       case
         when ss_normalise_phone(s.guardian_phone) is null
           then '>>> leave it — the number cannot be read, this needs a person'
         when ss_phone_looks_fake(ss_normalise_phone(s.guardian_phone))
           then '>>> leave it — that is a placeholder, not a family'
         when exists (select 1 from parent_accounts pa
                       where pa.phone_primary = ss_normalise_phone(s.guardian_phone)
                          or pa.phone_secondary = ss_normalise_phone(s.guardian_phone))
           then 'join: ' || (select coalesce(nullif(btrim(pa.display_name), ''), '(unnamed account)')
                               from parent_accounts pa
                              where pa.phone_primary = ss_normalise_phone(s.guardian_phone)
                                 or pa.phone_secondary = ss_normalise_phone(s.guardian_phone)
                              limit 1)
         else 'new account for ' || coalesce(nullif(btrim(s.guardian_name), ''), 'this number')
       end as what_would_happen
  from students s
 where s.account_id is null
    or not exists (select 1 from parent_accounts pa where pa.id = s.account_id)
 order by 4, 2, 1;


-- ═══ STEP 2 — put them where they belong ════════════════════════════════
begin;

-- 2a. Join the ones whose number already has an account.
update students s
   set account_id = pa.id
  from parent_accounts pa
 where (s.account_id is null
        or not exists (select 1 from parent_accounts x where x.id = s.account_id))
   and ss_normalise_phone(s.guardian_phone) is not null
   and not ss_phone_looks_fake(ss_normalise_phone(s.guardian_phone))
   and (pa.phone_primary   = ss_normalise_phone(s.guardian_phone)
     or pa.phone_secondary = ss_normalise_phone(s.guardian_phone));

-- 2b. Make an account for the rest that have a readable number. One per
--     number, not one per child, or siblings split again.
insert into parent_accounts (display_name, phone_primary)
select max(btrim(s.guardian_name)) filter (where nullif(btrim(s.guardian_name), '') is not null),
       ss_normalise_phone(s.guardian_phone)
  from students s
 where (s.account_id is null
        or not exists (select 1 from parent_accounts x where x.id = s.account_id))
   and ss_normalise_phone(s.guardian_phone) is not null
   and not ss_phone_looks_fake(ss_normalise_phone(s.guardian_phone))
 group by ss_normalise_phone(s.guardian_phone)
on conflict do nothing;

-- 2c. And join them to it.
update students s
   set account_id = pa.id
  from parent_accounts pa
 where (s.account_id is null
        or not exists (select 1 from parent_accounts x where x.id = s.account_id))
   and ss_normalise_phone(s.guardian_phone) is not null
   and not ss_phone_looks_fake(ss_normalise_phone(s.guardian_phone))
   and pa.phone_primary = ss_normalise_phone(s.guardian_phone);

-- 2d. Anything still adrift has no readable number, so there is nothing
--     to attach it to. Clearing the dangling pointer at least makes it
--     visible: the worklist asks for account_id is null, and a pointer
--     to nothing was slipping past that question.
update students s
   set account_id = null
 where s.account_id is not null
   and not exists (select 1 from parent_accounts x where x.id = s.account_id);

commit;


-- ═══ STEP 3 — confirm, and read the merges ══════════════════════════════
select count(*) filter (where account_id is null)        as still_adrift,
       count(*) filter (where account_id is not null
         and not exists (select 1 from parent_accounts pa where pa.id = students.account_id))
                                                          as still_dangling
  from students;

-- Still adrift, and why. Each of these is a question for a person.
select s.name as child, btrim(s.guardian_name) as guardian,
       coalesce(s.guardian_phone, '— none —') as phone_as_typed,
       case when ss_phone_looks_fake(ss_normalise_phone(s.guardian_phone))
            then 'that is a placeholder — replace it, then re-run this file'
            else 'no readable number — give them one, then re-run this file' end as what_to_do
  from students s
 where s.account_id is null
 order by 2, 1;

-- Families now sharing one account because they share one number. Read
-- this: some are one person spelt twice, and some are two households
-- that should be split on the Accounts screen.
select pa.display_name                                   as account,
       pa.phone_primary                                  as number,
       string_agg(distinct btrim(s.guardian_name), ' | ') as guardian_names_under_it,
       string_agg(distinct s.name, ', ')                  as children
  from parent_accounts pa
  join students s on s.account_id = pa.id
 group by pa.id, pa.display_name, pa.phone_primary
having count(distinct btrim(lower(s.guardian_name))) > 1
 order by 1;
