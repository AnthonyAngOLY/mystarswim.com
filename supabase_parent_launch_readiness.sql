-- ════════════════════════════════════════════════════════════════════════
--  Before a single parent is invited: how many of them can actually get in?
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It creates nothing,
--  changes nothing and takes no argument. Safe to re-run.
--
--  WHY THIS IS THE FIRST QUESTION
--  A parent signs in with their phone and a one-time code. parent-signin
--  normalises what they type to E.164 and then looks for that exact
--  string in parent_accounts:
--
--      phone_primary.eq.+60123456789  or  phone_secondary.eq.+60123456789
--
--  It is an equality, not a fuzzy match. A number stored as 012-3456789
--  or 0123456789 will never equal +60123456789, so that family types
--  their own number correctly and is told we do not have it. They cannot
--  get in, they cannot be helped by trying again, and the message tells
--  them to call the centre.
--
--  The backfill ran every number through ss_normalise_phone(), so most
--  should be in shape. Two things escape it. A number edited or added
--  since then never passed through it — the office has no screen that
--  writes this column, so anything changed was changed by hand. And
--  ss_normalise_phone() returns NULL for anything that is not a
--  Malaysian mobile: a landline, a foreign number, a mistyped one. A
--  family whose only contact was a landline has no sign-in number at
--  all and no amount of trying will produce one.
--
--  Sending the invite before knowing these counts means finding out
--  from the parents, one phone call at a time, on launch day.
--
--  NO NUMBERS ARE PRINTED
--  Part C shows the SHAPE of what is stored, with every digit replaced
--  by #, so a wrong format is visible without a customer's number
--  appearing in a report that gets pasted around. Counts only elsewhere.
--
--  ONE STATEMENT
--  The SQL editor shows the result of the last statement only, so this
--  is a single select with the parts stacked by union all.
-- ════════════════════════════════════════════════════════════════════════

with acc as (
  select pa.id,
         nullif(btrim(pa.phone_primary),'')   as p1,
         nullif(btrim(pa.phone_secondary),'') as p2
    from parent_accounts pa
),
flagged as (
  select acc.*,
         -- Exactly what parent-signin will compare against: +60, then a
         -- Malaysian mobile, which is 1 followed by 8 or 9 digits.
         (p1 ~ '^\+601[0-9]{8,9}$') as p1_ok,
         (p2 ~ '^\+601[0-9]{8,9}$') as p2_ok
    from acc
),
j as (
  select flagged.*,
         (p1_ok or p2_ok)                       as can_sign_in,
         (p1 is null and p2 is null)            as no_number,
         (coalesce(p1_ok,false) = false and coalesce(p2_ok,false) = false
          and (p1 is not null or p2 is not null)) as wrong_shape
    from flagged
),
-- Two accounts whose numbers normalise to the same thing. The unique
-- index is on the literal string, so +60123456789 and 0123456789 sit
-- side by side happily and lock both families out.
dupe as (
  select ss_normalise_phone(coalesce(p1,p2)) as norm, count(*) n
    from acc
   where coalesce(p1,p2) is not null
   group by 1
  having ss_normalise_phone(coalesce(p1,p2)) is not null
     and count(*) > 1
),
kids as (
  select pa.id, count(s.id) n
    from parent_accounts pa
    left join students s on s.account_id = pa.id
   group by pa.id
),
tot as (select count(*) n from j),
ok  as (select count(*) n from j where can_sign_in)

select z.part, z.item, z.detail
  from (

  -- ── A. the families ──────────────────────────────────────────────────
  select 1 k, 'A. the families' part, 'accounts in total' item,
         (select n::text from tot) detail
  union all
  select 1, 'A. the families', 'can sign in today',
         (select n::text from ok) || ' of ' || (select n::text from tot)
  union all
  select 1, 'A. the families', 'have no number at all — cannot ever sign in',
         (select count(*)::text from j where no_number)
  union all
  select 1, 'A. the families', 'have a number stored in a shape that will not match',
         (select count(*)::text from j where wrong_shape)

  -- ── B. what a mismatch costs ─────────────────────────────────────────
  union all
  select 2, 'B. what that means on launch day',
         'parents who will be told "we do not have that number"',
         (select (count(*))::text from j where not can_sign_in)
      || ' — each one a phone call to the office, and nothing they can do '
      || 'from their end'

  -- ── C. the shapes found (digits masked) ──────────────────────────────
  union all
  select 3, 'C. shapes stored (every digit shown as #)',
         coalesce(regexp_replace(coalesce(j.p1, j.p2), '[0-9]', '#', 'g'),
                  '(no number)')
           || case when j.can_sign_in then '   ✓ matches' else '   ✗ will not match' end,
         count(*)::text || ' account' || case when count(*) = 1 then '' else 's' end
    from j group by 3

  -- ── D. two families, one number ──────────────────────────────────────
  union all
  select 4, 'D. one number on two accounts',
         'numbers that normalise to the same thing',
         (select coalesce(count(*),0)::text from dupe)
      || case when (select coalesce(count(*),0) from dupe) = 0
              then ' — none' else
              ' — parent-signin refuses these outright, so BOTH families are '
           || 'locked out until the office picks one' end

  -- ── E. families with nothing to see ──────────────────────────────────
  union all
  select 5, 'E. accounts with no children attached',
         'would sign in to an empty app',
         (select count(*)::text from kids where kids.n = 0)

  -- ── F. verdict ───────────────────────────────────────────────────────
  union all
  select 6, 'F. verdict', 'is this list ready to invite',
         case
           when (select n from tot) = 0 then
             'There are no parent accounts at all. Nothing to invite yet.'
           when (select n from ok) = (select n from tot) then
             'Yes. Every account holds a number in the exact shape parent-signin '
          || 'compares against. Sign-in failures on launch day will be about '
          || 'message delivery, not about the data.'
           else
             (select (tot.n - ok.n)::text from tot, ok) || ' of '
          || (select n::text from tot) || ' families cannot sign in as the data '
          || 'stands, and would each find that out by failing. Fix the numbers '
          || 'before the invites go out, not after.'
         end

  ) z
 order by z.k, z.item;
