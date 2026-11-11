-- ════════════════════════════════════════════════════════════════════════
--  What the invoice knows about who it is billed to
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It creates nothing,
--  changes nothing and takes no argument. Safe to re-run.
--
--  WHY
--  Both printed layouts — the invoice on its own and the invoice with
--  its receipt — already render the buyer's email:
--
--      ${invoice.account_email ? ... : ''}
--
--  So an invoice printing without one is not a template that forgot. It
--  is an invoice whose account_email is null.
--
--  That column is a SNAPSHOT, written once when the invoice is created
--  from whatever the account held at that moment. An email added to the
--  account afterwards does not travel backwards into invoices already
--  issued. So the question is not "does the layout show it" but "how
--  many invoices were created before their account had an email", and
--  of those, how many could be filled in from the account today.
--
--  Part D answers the second half separately, by asking the database
--  rather than by asserting: there is no IC number anywhere on a
--  customer record — not on parent_accounts, not on students, and the
--  intake form does not collect one. Nothing can print a field that is
--  not captured, so that part is a build, not a fix.
--
--  A NOTE ON FILLING THE GAPS
--  An invoice is a document that was handed to somebody. Writing a
--  missing email into one that has already been issued changes what a
--  reprint says against what the customer was given. For an email that
--  is probably fine and for a figure it would not be, which is why this
--  file only counts and does not change anything. The decision is
--  yours; nothing here takes it for you.
--
--  ONE STATEMENT
--  The SQL editor shows the result of the last statement only, so this
--  is a single select with the parts stacked by union all.
-- ════════════════════════════════════════════════════════════════════════

with inv as (
  select i.id,
         i.invoice_number,
         i.account_id,
         nullif(btrim(i.account_email),'') as snap_email,
         nullif(btrim(i.account_phone),'') as snap_phone
    from invoices i
),
acc as (
  select pa.id, nullif(btrim(pa.email),'') as email
    from parent_accounts pa
),
j as (
  select inv.*, acc.email as live_email
    from inv left join acc on acc.id = inv.account_id
),
tot       as (select count(*) n from j),
has_email as (select count(*) n from j where snap_email is not null),
fixable   as (select count(*) n from j
               where snap_email is null and live_email is not null),
no_acct   as (select count(*) n from j where account_id is null),
never     as (select count(*) n from j
               where snap_email is null and live_email is null
                 and account_id is not null),
ic_col    as (
  select count(*) n from information_schema.columns
   where table_schema = 'public'
     and table_name in ('parent_accounts','students')
     and column_name ~* '(^|_)(ic|nric|ic_no|identity)(_|$)'
)

select z.part, z.item, z.detail
  from (

  -- ── A. the email, as the invoices hold it ────────────────────────────
  select 1 k, 'A. email on the invoice' part, 'invoices in total' item,
         (select n::text from tot) detail
  union all
  select 1, 'A. email on the invoice', 'carry an email, and will print one',
         (select n::text from has_email) || ' of ' || (select n::text from tot)
  union all
  select 1, 'A. email on the invoice', 'carry none, and print no email line',
         ((select n from tot) - (select n from has_email))::text

  -- ── B. of the ones with none, why ────────────────────────────────────
  union all
  select 2, 'B. why an invoice has no email',
         'the account has one now — the invoice was made before it was added',
         (select n::text from fixable)
      || case when (select n from fixable) > 0
              then ' (these are the ones a backfill could fill)' else '' end
  union all
  select 2, 'B. why an invoice has no email',
         'the account still has no email on file',
         (select n::text from never)
      || ' — nothing to copy; the address has to be collected first'
  union all
  select 2, 'B. why an invoice has no email',
         'the invoice is not linked to an account at all',
         (select n::text from no_acct)

  -- ── C. the accounts themselves ───────────────────────────────────────
  union all
  select 3, 'C. the accounts', 'hold an email address',
         (select count(*)::text from acc where email is not null)
      || ' of ' || (select count(*)::text from acc)

  -- ── D. the IC number ─────────────────────────────────────────────────
  union all
  select 4, 'D. the IC number', 'a column for it on a customer record',
         case when (select n from ic_col) > 0
              then (select n::text from ic_col) || ' found'
              else 'none — parent_accounts and students have no IC field, so '
                || 'there is nothing to print. Capturing it comes first: a '
                || 'column, the intake form, and a screen the office can edit '
                || 'it in.' end

  -- ── E. verdict ───────────────────────────────────────────────────────
  union all
  select 5, 'E. verdict', 'email', 
         case
           when (select n from tot) = 0 then 'No invoices yet.'
           when (select n from has_email) = (select n from tot) then
             'Every invoice already carries an email and both layouts already '
          || 'render it. Nothing to do.'
           when (select n from fixable) > 0 then
             (select n::text from fixable) || ' invoices could show an email '
          || 'that their account holds today but that was not there when the '
          || 'invoice was made. Filling them changes what a reprint says '
          || 'against what the customer was handed — your call, not a bug.'
           else
             'The invoices without an email belong to accounts that have no '
          || 'email either. The gap is in what has been collected, not in the '
          || 'invoice or the layout.'
         end

  ) z
 order by z.k, z.item;
