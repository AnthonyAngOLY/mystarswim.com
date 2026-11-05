-- ════════════════════════════════════════════════════════════════════════
--  What the books will show, and what is wrong with it
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--  Nothing is created, changed or deleted.
--
--  WRITTEN FOR AN ACCOUNTANT TO READ, because two faults in the app put
--  wrong things in the ledger and somebody has to be told exactly what,
--  over what period, and whether it can be put back.
--
--  FAULT 1 — EVERY INVOICE PAYMENT SAYS CASH
--  The form that records a payment against an invoice sent its fields as
--  payment_method, payment_date and reference_number. The function that
--  writes them reads paymentMethod, paymentDate and referenceNumber. The
--  names did not match, nothing threw, and all three arrived empty:
--
--    · the method fell to its default, which was 'cash'
--    · the date fell to "today", so a payment received last week was
--      filed on the day it was keyed in
--    · the bank reference was dropped entirely
--
--  Cash is a real method and a believable answer, so nothing ever looked
--  wrong. It surfaced when the accountant asked where all the cash was
--  and the transfer slips did not match the books.
--
--  The shop was never affected: it calls the same function with the
--  names spelled the way the function reads them, which is why product
--  sales show their true method and invoice payments do not.
--
--  CAN IT BE RECOVERED? No, not from this database. The method and the
--  reference were never written. The bank statements, the TNG and
--  DuitNow records and the physical slips are the only source for what
--  actually happened. This report says which rows that applies to.
--
--  FAULT 2 — VOIDING AN INVOICE DELETED ITS RECEIPTS
--  Voiding removed the payments rows outright rather than reversing
--  them. The invoice stayed, marked void, with its number; the receipts
--  went. That leaves holes in the receipt sequence with nothing to say
--  what was in them — which is the exact pattern an audit looks for,
--  and indistinguishable from suppressed income. The gaps are listed
--  below so each can be accounted for.
-- ════════════════════════════════════════════════════════════════════════

with
pay as (
  select p.*,
         (p.created_at at time zone 'Asia/Kuala_Lumpur')::date as keyed_on,
         -- Receipt numbers are formatted text (a prefix and a running
         -- number). Split them so the sequence can be walked.
         regexp_replace(coalesce(p.receipt_number,''), '[0-9]+$', '')      as rprefix,
         nullif(regexp_replace(coalesce(p.receipt_number,''),
                               '^.*?([0-9]+)$', '\1'), '')                as rseq_txt
    from payments p
),
seqd as (
  select *, case when rseq_txt ~ '^[0-9]+$' then rseq_txt::bigint end as rseq from pay
),
-- The footprint of fault 1: says cash, carries no reference, and was
-- filed on the very day it was typed. Each alone is ordinary; together,
-- on an invoice payment, they are the signature of the lost fields.
suspect as (
  select * from seqd
   where coalesce(payment_method,'') = 'cash'
     and coalesce(reference_number,'') = ''
     and payment_date = keyed_on
     and coalesce(kind,'payment') <> 'refund'
),
-- Gaps in each receipt prefix's run. A deleted payment leaves one.
bounds as (
  -- width is carried through so a missing number is written the way the
  -- receipt was written. R-202610-3 matches nothing anybody is holding;
  -- R-202610-0003 is a document somebody can go and look for.
  select rprefix, min(rseq) lo, max(rseq) hi, max(length(rseq_txt)) width
    from seqd where rseq is not null group by rprefix
),
gaps as (
  select b.rprefix, g.n, b.width
    from bounds b
    join lateral generate_series(b.lo, b.hi) g(n) on true
   where b.hi - b.lo < 20000          -- a guard, not a judgement
     and not exists (select 1 from seqd s where s.rprefix = b.rprefix and s.rseq = g.n)
)

select part, line, detail from (

  select 1 as part, 'PAYMENTS ON FILE' as line,
         count(*)::text || ' rows, ' || coalesce(min(payment_date)::text,'—')
           || ' to ' || coalesce(max(payment_date)::text,'—') as detail
    from seqd

  union all
  select 2, 'methods recorded',
         coalesce(string_agg(m || ' × ' || c::text, ',  ' order by c desc), 'none')
    from (select coalesce(nullif(payment_method,''),'(blank)') m, count(*) c
            from seqd group by 1) z

  union all
  -- The headline. If this is most of the ledger, the books say cash and
  -- the bank says otherwise, and only the bank is right.
  select 3, '** LOOKS FORCED TO CASH **',
         (select count(*)::text from suspect) || ' payments, RM '
         || to_char(coalesce((select sum(amount) from suspect),0), 'FM999999990.00')
         || ', ' || coalesce((select min(payment_date)::text from suspect),'—')
         || ' to ' || coalesce((select max(payment_date)::text from suspect),'—')

  union all
  select 4, 'what that means',
         case when (select count(*) from suspect) = 0
              then 'Nothing matches the pattern. Either the fault never reached this data, or every payment really was cash on the day it was keyed.'
              else 'The true method and bank reference were never written and cannot be recovered here. Reconcile these against bank, TNG and DuitNow records.'
         end

  union all
  -- The only thing that survived the lost fields, where anybody typed it.
  select 5, 'of those, with a note that may say how it was paid',
         (select count(*)::text from suspect where coalesce(notes,'') <> '')

  union all
  select 6, 'payments that do carry a real method',
         (select count(*)::text from seqd
           where coalesce(payment_method,'') not in ('','cash'))
         || ' (shop sales and refunds were never affected)'

  union all
  select 7, '** GAPS IN THE RECEIPT SEQUENCE **',
         case when (select count(*) from gaps) = 0 then 'none — every number is accounted for'
              else (select count(*)::text from gaps) || ' missing number'
                   || case when (select count(*) from gaps) = 1 then '' else 's' end
                   || ' — each one was a receipt that has been deleted' end

  union all
  select 8, '   missing',
         g.rprefix || lpad(g.n::text, g.width, '0')
    from gaps g

  union all
  select 9, 'voided invoices',
         (select count(*)::text from invoices where status = 'void')
         || ', RM ' || to_char(coalesce((select sum(total_amount) from invoices where status='void'),0),'FM999999990.00')
         || ' of billed value'

  union all
  select 10, 'voided invoices that still carry payments',
         (select case when count(*) = 0 then 'none'
                      else count(*)::text || ' — these were voided without their receipts being removed' end
            from invoices i
           where i.status = 'void'
             and exists (select 1 from payments p where p.invoice_id = i.id))

  union all
  select 11, 'FOR THE ACCOUNTANT',
         'Treat payment_method and payment_date on invoice payments as unreliable for the period above. '
      || 'Amounts, receipt numbers and which invoice each belongs to were always written correctly and can be trusted.'

) z order by part, detail;
