-- ════════════════════════════════════════════════════════════════════════
--  Does nobody owe us anything, or does the field only say so?
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It creates nothing,
--  changes nothing and takes no argument. Safe to re-run.
--
--  WHY
--  outstanding_accounts() reported zero accounts owing, before and after
--  it was changed to do arithmetic instead of reading the status label.
--  Several very different things produce that same zero:
--
--    1. Everything billed really has been collected.
--    2. amount_paid is written as settled whether or not money arrived,
--       so every invoice looks square and the list is empty by
--       construction.
--    3. Balances exist, but only on invoices nobody would chase — void,
--       refunded, draft — which the function excludes on purpose.
--    4. An invoice was paid and then refunded, netting to zero, but its
--       status label was never moved off 'sent'. It reads as owing and
--       is not.
--    5. The function could not answer at all. It is seat-guarded, and a
--       guard written as a where clause returns an empty list rather
--       than an error. In the SQL editor there is no JWT and so never a
--       seat, which means the confirm block that reported the zero was
--       never measuring the data in the first place.
--
--  Reading one number cannot tell these apart. This file separates them.
--  The parts that matter most are C, which asks whether any invoice
--  claims payment with no row in payments behind it — money that arrives
--  leaves a row, a form that pre-fills a field does not — and F, which
--  catches an invoice whose label disagrees with its own money.
--
--  WHAT THE PARTS ARE
--    A  the arithmetic, across every invoice regardless of status
--    B  whether amount_paid agrees with the payments actually recorded
--    C  invoices claiming payment with no payment row
--    D  the same arithmetic broken down by status label
--    E  every invoice where amount_paid and total_amount disagree
--    F  invoices whose status label disagrees with their own money
--    G  what A to F together mean, in a sentence
--
--  ONE STATEMENT
--  The SQL editor shows the result of the last statement only, so this
--  is a single select and the parts are stacked with union all.
-- ════════════════════════════════════════════════════════════════════════

with inv as (
  select i.id,
         i.invoice_number,
         i.account_id,
         coalesce(i.status,'(no status)')          as status,
         coalesce(i.total_amount,0)::numeric       as tot,
         coalesce(i.amount_paid,0)::numeric        as paid
    from invoices i
),
pay as (
  select p.invoice_id,
         sum(p.amount)::numeric as pay_sum,
         count(*)               as pay_rows
    from payments p
   where p.invoice_id is not null
   group by p.invoice_id
),
j as (
  select inv.*,
         coalesce(pay.pay_sum,0)::numeric as pay_sum,
         coalesce(pay.pay_rows,0)         as pay_rows,
         (inv.tot - inv.paid)::numeric    as owed,
         -- Paid and then refunded: rows exist, and they cancel out.
         (coalesce(pay.pay_rows,0) > 0
          and abs(coalesce(pay.pay_sum,0)) < 0.005) as netted_out
    from inv
    left join pay on pay.invoice_id = inv.id
),
-- What outstanding_accounts() would actually chase: a balance on an
-- invoice that is not void, refunded or draft.
chase as (
  select * from j
   where owed >= 0.005
     and status not in ('void','refunded','draft')
),
owing    as (select count(*) n from j where owed >= 0.005),
unbal    as (select count(*) n from j where abs(owed) >= 0.005),
real_n   as (select count(*) n, coalesce(sum(owed),0) rm from chase where not netted_out),
label_n  as (select count(*) n from chase where netted_out),
nomoney  as (select count(*) n from j where paid >= 0.005 and pay_rows = 0),
mismatch as (select count(*) n from j where abs(paid - pay_sum) >= 0.005),
mislabel as (select count(*) n from j
              where netted_out and status not in ('void','refunded'))

select z.part, z.item, z.detail
  from (

  -- ── A. the arithmetic ────────────────────────────────────────────────
  select 1 k, 'A. the arithmetic' part,
         'invoices in total' item, count(*)::text detail
    from j
  union all
  select 1, 'A. the arithmetic',
         'owing — amount_paid is short of total_amount', count(*)::text
    from j where owed >= 0.005
  union all
  select 1, 'A. the arithmetic',
         'settled exactly, to the cent', count(*)::text
    from j where abs(owed) < 0.005
  union all
  select 1, 'A. the arithmetic',
         'overpaid — amount_paid exceeds total_amount', count(*)::text
    from j where owed <= -0.005
  union all
  select 1, 'A. the arithmetic',
         'of that, actually chaseable (not void, refunded or draft)',
         (select n::text from real_n) || ' invoice'
      || case when (select n from real_n) = 1 then '' else 's' end
      || ', RM ' || (select to_char(rm,'FM999999990.00') from real_n)

  -- ── B. amount_paid against the payments actually recorded ────────────
  union all
  select 2, 'B. amount_paid vs the payment rows',
         'invoices where the two disagree', (select n::text from mismatch)
  union all
  select 2, 'B. amount_paid vs the payment rows',
         'how much they disagree by, added up',
         'RM ' || to_char(coalesce((select sum(abs(paid - pay_sum)) from j
                                     where abs(paid - pay_sum) >= 0.005),0),
                          'FM999999990.00')

  -- ── C. the pre-fill test ─────────────────────────────────────────────
  union all
  select 3, 'C. paid, with no money behind it',
         'invoices with amount_paid above zero and NO payment row',
         (select n::text from nomoney)
  union all
  select 3, 'C. paid, with no money behind it',
         'what those invoices claim to have collected',
         'RM ' || to_char(coalesce((select sum(paid) from j
                                     where paid >= 0.005 and pay_rows = 0),0),
                          'FM999999990.00')

  -- ── D. by status label ───────────────────────────────────────────────
  union all
  select 4, 'D. by status',
         j.status || ' — ' || count(*) || ' invoice'
           || case when count(*) = 1 then '' else 's' end,
         'owed RM ' || to_char(sum(greatest(0,j.owed)),'FM999999990.00')
           || ' of RM ' || to_char(sum(j.tot),'FM999999990.00') || ' billed'
    from j group by j.status

  -- ── E. every invoice that does not balance ───────────────────────────
  union all
  select 5, 'E. invoices that do not balance',
         coalesce(j.invoice_number,'(no number)') || '  [' || j.status || ']',
         case when j.owed >= 0.005 then 'owes RM ' || to_char(j.owed,'FM999999990.00')
              else 'OVERPAID by RM ' || to_char(-j.owed,'FM999999990.00') end
           || ' of RM ' || to_char(j.tot,'FM999999990.00')
           || ' — ' || j.pay_rows || ' payment row'
           || case when j.pay_rows = 1 then '' else 's' end
           || case when j.netted_out then ', netting to zero (paid then refunded)'
                   when j.pay_rows = 0 then ', no money ever recorded'
                   else ', RM ' || to_char(j.pay_sum,'FM999999990.00') || ' recorded' end
           || case when j.status in ('void','refunded','draft')
                   then '  ·  not chased' else '' end
    from j where abs(j.owed) >= 0.005
  union all
  select 5, 'E. invoices that do not balance', '(none)',
         'Every invoice has amount_paid equal to total_amount.'
    from unbal where unbal.n = 0

  -- ── F. labels that disagree with the money ───────────────────────────
  union all
  select 6, 'F. label disagrees with the money',
         coalesce(j.invoice_number,'(no number)') || '  [' || j.status || ']',
         'Payments net to zero — paid and then refunded — but the status '
      || 'is not refunded or void. It reads as owing RM '
      || to_char(greatest(0,j.owed),'FM999999990.00') || ' and is not.'
    from j where j.netted_out and j.status not in ('void','refunded')
  union all
  select 6, 'F. label disagrees with the money', '(none)',
         'Every invoice whose payments cancel out is labelled refunded or void.'
    from mislabel where mislabel.n = 0

  -- ── G. what it means ─────────────────────────────────────────────────
  union all
  select 7, 'G. verdict', 'is the money itself sound',
         case
           when (select n from nomoney) > 0 then
             (select n::text from nomoney) || ' invoices are marked paid with no '
          || 'payment row behind them. amount_paid is being set without money '
          || 'arriving, so no figure drawn from it can be trusted.'
           when (select n from mismatch) > 0 then
             (select n::text from mismatch) || ' invoices disagree with the sum of '
          || 'their own payment rows. Worth an accountant''s eye.'
           else
             'Yes. Every invoice claiming payment has payment rows behind it, and '
          || 'the two agree to the cent. amount_paid is not being pre-filled.'
         end
  union all
  select 7, 'G. verdict', 'should the outstanding list be empty',
         case
           when (select n from real_n) > 0 then
             'No. RM ' || (select to_char(rm,'FM999999990.00') from real_n)
          || ' across ' || (select n::text from real_n) || ' invoice(s) is genuinely '
          || 'chaseable, so outstanding_accounts() reporting nothing is a fault in '
          || 'the function, not the data. Part E names them.'
           when (select n from label_n) > 0 then
             'Yes, but for a sloppy reason. The only invoices that would be chased '
          || 'were paid and then refunded, netting to zero, and had their status '
          || 'left behind. Nothing is owed. Part F names them; fix the labels and '
          || 'the list is empty for the right reason.'
           when (select n from owing) > 0 then
             'Yes. Balances exist only on void, refunded or draft invoices, which '
          || 'are never chased. Everything billed in earnest has been collected.'
           else
             'Yes. No invoice anywhere shows a balance.'
         end
  union all
  select 7, 'G. verdict', 'can this file be trusted over the confirm block',
         'Yes, and the confirm block could not be. outstanding_accounts() is '
      || 'seat-guarded, and the guard was written as a where clause, so a caller '
      || 'with no seat gets an empty list rather than an error. The SQL editor '
      || 'carries no JWT and so never has a seat. Every zero it reported meant '
      || '"not allowed to ask", not "nobody owes". This file does the arithmetic '
      || 'directly and has no guard to trip over.'

  ) z
 order by z.k, z.item;
