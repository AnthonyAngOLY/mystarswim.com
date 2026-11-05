-- ════════════════════════════════════════════════════════════════════════
--  Where the Revenue figure comes from, line by line
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--
--  CHANGE THE MONTH ON THE NEXT LINE OF SQL AND RUN IT AGAIN.
--
--  WHY
--  "The number looks off" is not something to settle by argument. The
--  Revenue screen applies one rule, and this applies the same rule in
--  the database and then takes it apart, so the figure can be followed
--  to whichever line disagrees with what you expected.
--
--  WHAT THE SCREEN DOES, EXACTLY
--  Every row in payments whose payment_date falls in the month, whose
--  invoice is not voided, added up. Nothing else is filtered.
--
--  That means, and these are the usual surprises:
--
--    · REFUNDS ARE IN IT. A refund is a payments row with a negative
--      amount, so the total is net, not takings. Both are below.
--
--    · SHOP SALES ARE IN IT. The till creates an invoice for a pair of
--      goggles exactly as it does for a term of lessons, and records a
--      payment against it. At the payments table they are the same
--      thing. If "revenue" to you means lesson fees, the product line
--      below is what to subtract.
--
--    · A PART PAYMENT IS IN IT, IN THE MONTH IT ARRIVED. The screen
--      follows money, not billing. An invoice raised in September and
--      settled in two instalments shows in October and November, not in
--      September, and never at its invoice total.
--
--    · IT IS NOT INVOICED VALUE. Anything billed and unpaid is absent,
--      which is the point, but it is the commonest reason a figure
--      looks low against an expectation taken from invoices.
-- ════════════════════════════════════════════════════════════════════════

with
ask as (select '2026-11'::text as ym),          -- ← the month to examine

pay as (
  select p.id, p.amount::numeric amt, p.payment_date, p.payment_method,
         coalesce(p.kind,'payment') kind,
         i.id inv_id, i.status inv_status, i.branch_id, i.invoice_number
    from payments p
    left join invoices i on i.id = p.invoice_id, ask
   where to_char(p.payment_date,'YYYY-MM') = ask.ym
),
-- What the invoice was for. An invoice can carry both, so it is three
-- buckets and not two.
kindof as (
  select y.*,
         case
           when y.inv_id is null then 'no invoice'
           when not exists (select 1 from invoice_lines l where l.invoice_id = y.inv_id) then 'invoice with no lines'
           when not exists (select 1 from invoice_lines l where l.invoice_id = y.inv_id and coalesce(l.line_type,'package') <> 'product') then 'shop / products'
           when not exists (select 1 from invoice_lines l where l.invoice_id = y.inv_id and coalesce(l.line_type,'package')  = 'product') then 'lessons / packages'
           else 'mixed (lessons and products)'
         end as what
    from pay y
),
live as (select * from kindof where coalesce(inv_status,'') <> 'void')

select line, amount, note from (

  select 0 as sort, 'MONTH' as line, (select ym from ask) as amount, '' as note

  union all
  select 1, '=== WHAT THE REVENUE SCREEN SHOWS ===',
         'RM ' || to_char(coalesce(sum(amt),0),'FM999999990.00'),
         count(*)::text || ' payments' from live

  union all
  select 2, '   takings before refunds',
         'RM ' || to_char(coalesce(sum(amt) filter (where amt > 0),0),'FM999999990.00'),
         (count(*) filter (where amt > 0))::text || ' receipts' from live

  union all
  select 3, '   refunds, already subtracted above',
         'RM ' || to_char(coalesce(sum(amt) filter (where amt < 0),0),'FM999999990.00'),
         (count(*) filter (where amt < 0))::text || ' refunded' from live

  union all
  select 4, '=== WHAT IT WAS FOR ===', '', 'these add up to the figure above'

  union all
  select 5, '   ' || what,
         'RM ' || to_char(sum(amt),'FM999999990.00'),
         count(*)::text || ' payments'
    from live group by what

  union all
  select 6, '=== IF YOU MEANT LESSON FEES ONLY ===',
         'RM ' || to_char(coalesce(sum(amt) filter (where what = 'lessons / packages'),0),'FM999999990.00'),
         'subtract the shop and mixed lines above' from live

  union all
  select 7, '=== LEFT OUT ON PURPOSE ===', '', ''

  union all
  select 8, '   payments against voided invoices',
         'RM ' || to_char(coalesce(sum(amt),0),'FM999999990.00'),
         count(*)::text || ' — a voided invoice is not revenue'
    from kindof where coalesce(inv_status,'') = 'void'

  union all
  select 9, '   payments with no date at all',
         'RM ' || to_char(coalesce(sum(p.amount),0),'FM999999990.00'),
         count(*)::text || ' — in no month, so in no figure'
    from payments p where p.payment_date is null

  union all
  select 10, '=== NOT REVENUE, SHOWN FOR COMPARISON ===', '', ''

  union all
  -- The number an expectation usually comes from. Billed is not banked.
  select 11, '   invoiced in this month (issue date)',
         'RM ' || to_char(coalesce(sum(i.total_amount),0),'FM999999990.00'),
         count(*)::text || ' invoices raised — billed, not necessarily paid'
    from invoices i, ask
   where to_char(i.issue_date,'YYYY-MM') = ask.ym
     and coalesce(i.status,'') <> 'void'

  union all
  select 12, '   still unpaid from those',
         'RM ' || to_char(coalesce(sum(greatest(0, coalesce(i.total_amount,0) - coalesce(i.amount_paid,0))),0),'FM999999990.00'),
         'the gap between billing and banking'
    from invoices i, ask
   where to_char(i.issue_date,'YYYY-MM') = ask.ym
     and coalesce(i.status,'') not in ('void','refunded')

  union all
  select 13, '=== THINGS THAT WOULD MAKE IT TOO HIGH ===', '', ''

  union all
  -- The same money entered twice. The Record Payment button can be
  -- pressed twice on a slow connection, and nothing in the app notices:
  -- each press takes its own receipt number, so they do not look like
  -- duplicates, they look like two payments.
  select 14, '   same invoice, same amount, same day, more than once',
         'RM ' || to_char(coalesce(sum(extra_amt),0),'FM999999990.00'),
         coalesce(sum(extra_n),0)::text || ' payments beyond the first in each group'
    from (
      select (count(*) - 1) extra_n, (count(*) - 1) * max(amt) extra_amt
        from live
       where inv_id is not null and amt > 0
       group by inv_id, amt, payment_date
      having count(*) > 1
    ) d

  union all
  select 15, '   and which they are',
         'RM ' || to_char(amt,'FM999999990.00') || ' × ' || count(*)::text,
         'invoice ' || coalesce(max(invoice_number)::text,'?') || ' on ' || payment_date::text
    from live
   where inv_id is not null and amt > 0
   group by inv_id, amt, payment_date, invoice_number
  having count(*) > 1

  union all
  -- The Record Payment button pre-fills the FULL outstanding balance.
  -- Take RM 200 against a RM 600 invoice without editing the box and
  -- RM 600 is recorded. These are the payments that settled an invoice
  -- to the penny in one go — mostly ordinary, and the place to look if
  -- the books are ahead of the bank.
  select 16, '   paid exactly the invoice total in one payment',
         'RM ' || to_char(coalesce(sum(amt),0),'FM999999990.00'),
         count(*)::text || ' of ' || (select count(*)::text from live where amt > 0)
      || ' — the form pre-fills the full balance, so check a few against the slips'
    from live l
   where l.amt > 0
     and exists (select 1 from invoices i where i.id = l.inv_id
                  and abs(coalesce(i.total_amount,0) - l.amt) < 0.005)

  union all
  select 17, '   the ten largest this month',
         'RM ' || to_char(amt,'FM999999990.00'),
         'invoice ' || coalesce(invoice_number::text,'—') || ' · ' || payment_date::text
                    || ' · ' || coalesce(payment_method,'—')
    from (select * from live where amt > 0 order by amt desc limit 10) t

) z order by sort, line, note;
