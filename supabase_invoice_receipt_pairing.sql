-- ════════════════════════════════════════════════════════════════════════
--  Does every invoice have exactly one receipt?
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--
--  WHY
--  The monthly statement prints an invoice number beside every receipt,
--  and the month totals show invoices and receipts arriving in almost
--  equal numbers — 154 and 154 in October, 127 and 127 in September. It
--  is natural to conclude that one invoice means one receipt.
--
--  Equal counts do not establish that. Two invoices paid in two
--  instalments and two invoices never paid at all also give equal
--  counts, and read identically from a distance. So this pairs them up
--  one by one instead of counting them.
--
--  WHAT THE LINK IS
--  Every payments row carries the id of the invoice it was taken
--  against, written at the moment the payment is recorded. It is not
--  inferred from a name, a date or an amount, so the pairing below is
--  the real relationship and not a guess at one.
--
--  WHAT EACH ANSWER MEANS
--    one receipt, one invoice   the ordinary case: billed, then paid in
--                               full, once
--    more than one receipt      an invoice settled in instalments — or
--                               the same payment entered twice, which
--                               looks the same here and is separated by
--                               the amounts
--    no receipt at all          billed and not yet paid. Should agree
--                               with the outstanding figure
--    a receipt with no invoice  should not exist at all
-- ════════════════════════════════════════════════════════════════════════

with
ask as (select '2026-10'::text as ym),           -- ← the month to examine

inv as (
  select i.* from invoices i, ask
   where to_char(i.issue_date,'YYYY-MM') = ask.ym
     and coalesce(i.status,'') <> 'void'
),
rec as (
  select p.*, i.id iid, i.invoice_number, i.total_amount, i.status istatus
    from payments p
    left join invoices i on i.id = p.invoice_id, ask
   where to_char(p.payment_date,'YYYY-MM') = ask.ym
),
-- How many receipts each of the month's invoices has, whenever they
-- were issued: an invoice raised on the 30th may be settled on the 2nd.
paired as (
  select inv.id, inv.invoice_number, inv.total_amount,
         (select count(*) from payments p where p.invoice_id = inv.id)            as n_rec,
         (select coalesce(sum(p.amount),0) from payments p where p.invoice_id = inv.id) as paid
    from inv
)

select part, line, detail from (

  select 0 as sort, 'MONTH' as part, (select ym from ask) as line, '' as detail

  union all
  select 1, 'counts', (select count(*)::text from inv) || ' invoices raised, '
         || (select count(*)::text from rec) || ' receipts issued', ''

  union all
  select 2, 'one invoice, one receipt',
         (select count(*)::text from paired where n_rec = 1), 'the ordinary case'

  union all
  select 3, 'invoices with more than one receipt',
         (select count(*)::text from paired where n_rec > 1),
         'instalments, or the same money entered twice'

  union all
  select 4, '   which they are',
         'INV ' || p.invoice_number || ' — ' || p.n_rec::text || ' receipts',
         'billed RM ' || to_char(coalesce(p.total_amount,0),'FM999999990.00')
         || ', received RM ' || to_char(p.paid,'FM999999990.00')
         || case when abs(p.paid - coalesce(p.total_amount,0)) < 0.005
                 then '  → adds up to the bill'
                 else '  ** does not add up to the bill **' end
    from paired p where p.n_rec > 1

  union all
  select 5, 'invoices with no receipt at all',
         (select count(*)::text from paired where n_rec = 0),
         'RM ' || to_char(coalesce((select sum(total_amount) from paired where n_rec = 0),0),'FM999999990.00')
         || ' billed and not paid'

  union all
  select 6, '   which they are',
         'INV ' || p.invoice_number,
         'RM ' || to_char(coalesce(p.total_amount,0),'FM999999990.00') || ' outstanding'
    from paired p where p.n_rec = 0

  union all
  -- Would mean a receipt issued against nothing. The app always writes
  -- an invoice id, so a row here is a sign something else wrote one.
  select 7, '** receipts with no invoice behind them **',
         (select count(*)::text from rec where iid is null),
         'should be zero'

  union all
  select 8, 'receipts that do not match their invoice exactly',
         (select count(*)::text from rec r
           where r.iid is not null and r.amount > 0
             and abs(r.amount - coalesce(r.total_amount,0)) >= 0.005),
         'part payments, or a bill settled across two months'

  union all
  select 9, 'so, for this month',
         case
           when (select count(*) from rec where iid is null) > 0
             then '** there are receipts with no invoice — look at those first **'
           when (select count(*) from paired where n_rec > 1) = 0
            and (select count(*) from paired where n_rec = 0) = 0
             then 'Yes. Every invoice has exactly one receipt and every receipt has an invoice.'
           else 'Mostly. The exceptions are listed above and each has a figure beside it.'
         end, ''

) z order by sort, line;
