-- ════════════════════════════════════════════════════════════════════════
--  Give an invoice an owner the database can prove
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Adds one column, writes only that column, deletes
--  nothing. Run the whole file; the table it prints at the end is the
--  report.
--
--  WHY
--  invoices carries account_name, account_email and account_phone, all
--  typed by hand. For the admin screens that is enough — a person reads
--  the name and knows who it is. The parent app cannot read. Asked to
--  show a parent "your invoices", the only thing it could match on is
--  that text, and two families with similar names would see each
--  other's bills. That is not a display bug, it is somebody else's
--  money and somebody else's children on screen.
--
--  So invoices gets account_id, filled only where the match is certain.
--
--  WHAT COUNTS AS CERTAIN
--  One of the numbers in the invoice's phone field is exactly one of
--  that parent account's numbers, AND exactly one account answers to
--  it. Failing that, the same test on the email. Nothing else: no name
--  matching, no partial numbers, no "probably". An invoice that cannot
--  be matched stays null and is listed at the end for a person to deal
--  with — a null is invisible in the parent app, which is the safe way
--  to be wrong.
--
--  AFTER THIS
--  New invoices need the column set when they are raised. Until the
--  admin app does that, re-run this file and it will pick them up.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 0. The column ──────────────────────────────────────────────────────
alter table invoices
  add column if not exists account_id uuid references parent_accounts(id);

create index if not exists invoices_account_idx
  on invoices (account_id) where account_id is not null;

comment on column invoices.account_id is
  'Which parent account owns this invoice. The parent app shows an '
  'invoice only through this column — never by matching the name or '
  'phone text, which two families can share.';


-- ─── 1. Fill it where it is certain, and report ─────────────────────────
-- One statement: the update is a CTE so the report below still sees the
-- old rows and can say which ones this run changed.
with
-- Every number each account answers to, one row per number.
acct_phone as (
  select pa.id as account_id, ph as phone
    from parent_accounts pa
    cross join lateral (values (pa.phone_primary), (pa.phone_secondary)) v(ph)
   where ph is not null and btrim(ph) <> ''
),
-- A number is only usable if exactly one account answers to it. Two
-- families sharing a phone is the case this must refuse, not resolve.
phone_owner as (
  select phone, (array_agg(account_id))[1] as account_id
    from acct_phone group by phone having count(distinct account_id) = 1
),
acct_email as (
  select lower(btrim(pa.email)) as email, pa.id as account_id
    from parent_accounts pa
   where nullif(btrim(pa.email), '') is not null
),
email_owner as (
  select email, (array_agg(account_id))[1] as account_id
    from acct_email group by email having count(distinct account_id) = 1
),
-- The invoice's own phone field may hold more than one number; ss_phones
-- pulls them out the same way the parent accounts were built, so the two
-- sides cannot disagree about what a number is.
inv_phone as (
  select i.id as invoice_id, po.account_id
    from invoices i
    cross join lateral unnest(coalesce(ss_phones(i.account_phone), '{}')) as p(num)
    join phone_owner po on po.phone = p.num
   where i.account_id is null
   group by i.id, po.account_id
),
-- And only if that one invoice points at exactly one account.
inv_phone_one as (
  select invoice_id, (array_agg(account_id))[1] as account_id
    from inv_phone group by invoice_id having count(distinct account_id) = 1
),
inv_email_one as (
  select i.id as invoice_id, eo.account_id
    from invoices i
    join email_owner eo on eo.email = lower(btrim(i.account_email))
   where i.account_id is null
     and not exists (select 1 from inv_phone_one x where x.invoice_id = i.id)
),
want as (
  select invoice_id, account_id, 'phone' as how from inv_phone_one
  union all
  select invoice_id, account_id, 'email'      from inv_email_one
),
upd as (
  update invoices i set account_id = w.account_id
    from want w
   where i.id = w.invoice_id and i.account_id is null
  returning i.id, w.account_id
)

-- ─── 2. The report ──────────────────────────────────────────────────────
select * from (
  select 1 as srt, 'matched on this run' as outcome,
         count(*)::text as invoices, '' as example
    from upd
  union all
  select 2, 'already had an owner', count(*)::text, ''
    from invoices where account_id is not null
  union all
  select 3, '>>> STILL UNMATCHED — invisible in the parent app',
         count(*)::text,
         coalesce(string_agg(distinct coalesce(nullif(btrim(i.account_name), ''), '(no name)'),
                             ', ' order by coalesce(nullif(btrim(i.account_name), ''), '(no name)')), '')
    from invoices i
   where i.account_id is null
     and not exists (select 1 from upd where upd.id = i.id)
) r order by srt;
