-- ════════════════════════════════════════════════════════════════════════
--  Zoe's list: every parent account that needs a human before launch
-- ════════════════════════════════════════════════════════════════════════
--  Read-only. It creates nothing and changes nothing. Run it as often as
--  you like — it is the list getting shorter that tells you you are done.
--
--  Run it AFTER supabase_parent_phone_international.sql, or it will
--  report the three foreign numbers as broken when they are not.
--
--  Each row is one thing to fix, on the Accounts screen, with the name
--  to search for, what is wrong, and what good looks like. Sorted so the
--  ones that stop a parent signing in come first.
--
--  A NOTE ON "FIX IT ON THE ACCOUNTS SCREEN"
--  Every one of these lives on the student record, in the account
--  holder's phone field. Correcting it there is enough: the number is
--  re-read into the parent account the next time the phone file is run,
--  and nothing has to be re-typed twice.
-- ════════════════════════════════════════════════════════════════════════

with kids as (
  select account_id,
         count(*)                               as n,
         string_agg(name, ', ' order by name)   as who,
         string_agg(distinct nullif(btrim(guardian_phone), ''), ' / ') as typed,
         count(distinct btrim(lower(guardian_name)))
           filter (where nullif(btrim(guardian_name), '') is not null) as names_on_it,
         string_agg(distinct btrim(guardian_name), ' | ') as the_names
    from students
   where account_id is not null
   group by account_id
),

-- ── 1. Cannot sign in: no number this system can read ───────────────────
no_phone as (
  select 1 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name on the account —') as parent,
         coalesce(k.who, '— no children attached —') as children,
         case
           when k.typed is null then 'no phone number at all'
           when length(k.typed) > 60 then 'the phone field holds a whole form, not a number'
           else 'the number is not one we can read: ' || k.typed
         end as what_is_wrong,
         case
           when k.typed is null then 'Ask them for a mobile and put it in the account holder''s phone field.'
           when length(k.typed) > 60 then 'Pull the mobile out of that text and leave only the mobile in the field.'
           else 'Check it against what they actually use. With a country code if it is not Malaysian.'
         end as what_to_do
    from parent_accounts pa
    left join kids k on k.account_id = pa.id
   where pa.phone_primary is null
),

-- ── 2. A number nobody owns: placeholders typed to get past a form ──────
placeholder as (
  select 2 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name —') as parent,
         coalesce(k.who, '— no children attached —') as children,
         'that looks like a placeholder, not a real number: ' || pa.phone_primary as what_is_wrong,
         'Anyone could guess it and sign in as this family. Replace it or clear it.' as what_to_do
    from parent_accounts pa
    left join kids k on k.account_id = pa.id
   where pa.phone_primary is not null
     -- Defined in supabase_parent_account_repair.sql, so the repair and
     -- this list cannot disagree about what a made-up number looks like.
     and ss_phone_looks_fake(pa.phone_primary)
),

-- ── 3. The same child entered twice ─────────────────────────────────────
-- Two rows, one swimmer, differing only in how somebody capitalised the
-- name. On the Accounts screen that is untidy. In the parent app it is
-- their child listed twice with two sets of sessions, and they will ring
-- to ask which one is real.
dup_child as (
  select 3 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name —') as parent,
         string_agg(distinct s.name, ' / ') as children,
         'the same swimmer appears ' || count(*) || ' times' as what_is_wrong,
         'Keep one record and archive the other. Whichever has the sessions '
         || 'and the payments against it is the one to keep.' as what_to_do
    from students s
    join parent_accounts pa on pa.id = s.account_id
   group by pa.id, pa.display_name, btrim(lower(s.name))
  having count(*) > 1
),

-- ── 4. Two different guardian names on one number ───────────────────────
-- Usually the same person spelt two ways, which is fine. Sometimes a
-- child's name in the guardian field, or two families sharing a phone —
-- and this is now the thing that decides who sees whose children.
two_names as (
  select 4 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name —') as parent,
         k.who as children,
         'two names on this number: ' || k.the_names as what_is_wrong,
         'If it is one person spelt twice, nothing to do. If it is a child''s '
         || 'name in the guardian field, or two separate families, split them.' as what_to_do
    from parent_accounts pa
    join kids k on k.account_id = pa.id
   where k.names_on_it > 1
),

-- ── 5. Foreign numbers. Not a fault — WhatsApp reaches them ─────────────
foreign_num as (
  select 5 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name —') as parent,
         coalesce(k.who, '— no children attached —') as children,
         'not a Malaysian number: ' || pa.phone_primary as what_is_wrong,
         'Nothing to fix if that is the phone they carry — WhatsApp reaches it. '
         || 'Worth one check that it is current.' as what_to_do
    from parent_accounts pa
    left join kids k on k.account_id = pa.id
   where pa.phone_primary is not null
     and pa.phone_primary not like '+60%'
),

-- ── 6. An account with nobody under it ──────────────────────────────────
empty_acct as (
  select 6 as rank,
         coalesce(nullif(btrim(pa.display_name), ''), '— no name —') as parent,
         '— none —' as children,
         'this account has no children attached' as what_is_wrong,
         'Harmless, but they would sign in to an empty app. Worth finding out why.' as what_to_do
    from parent_accounts pa
   where not exists (select 1 from students s where s.account_id = pa.id)
),

-- ── 7. A student under no account at all ────────────────────────────────
orphan as (
  select 7 as rank,
         coalesce(nullif(btrim(s.guardian_name), ''), '— no guardian name —') as parent,
         s.name as children,
         'this child is under no parent account' as what_is_wrong,
         case when exists (select 1 from parent_accounts pa
                            where pa.phone_primary = ss_normalise_phone(s.guardian_phone))
              then 'That number already belongs to another account — decide which family they are in.'
              else 'Give the account holder a name and a mobile, then re-run the phone file.' end as what_to_do
    from students s
   where s.account_id is null
)

select rank as priority, parent, children, what_is_wrong, what_to_do
  from (
    select * from no_phone    union all
    select * from placeholder union all
    select * from dup_child   union all
    select * from two_names   union all
    select * from foreign_num union all
    select * from empty_acct  union all
    select * from orphan
  ) all_of_it
 order by priority, parent;


-- ── How long the list is ────────────────────────────────────────────────
-- Run this one separately: the Supabase editor only shows the last
-- result when several queries go together.
--
--   select count(*) as accounts,
--          count(*) filter (where phone_primary is null) as cannot_sign_in,
--          count(*) filter (where phone_secondary is not null) as have_two_numbers
--     from parent_accounts;
