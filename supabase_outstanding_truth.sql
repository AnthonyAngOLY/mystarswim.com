-- ════════════════════════════════════════════════════════════════════════
--  Does nobody owe us anything, or does the field only say so?
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It creates nothing,
--  changes nothing and takes no argument. Safe to re-run.
--
--  WHY
--  outstanding_accounts() reports zero accounts owing. That was true
--  before, when the function filtered on the status label, and it is
--  still true now that it does the arithmetic. Two very different things
--  produce that same zero:
--
--    1. Everything billed really has been collected. For a swim school
--       taking payment at the counter this is entirely plausible, and
--       the invoice-to-receipt pairing already came back 154 of 154.
--
--    2. amount_paid is being written as though the invoice were settled,
--       whether or not money arrived. Then every invoice looks square by
--       arithmetic and the outstanding list is empty by construction.
--
--  Reading the number alone cannot tell these apart. The question that
--  can is: are there invoices marked paid with no payment row behind
--  them? Money that arrived leaves a row in payments. A field set by a
--  form does not. Part C is that test; everything else is context.
--
--  WHAT THE PARTS ARE
--    A  the arithmetic, across every invoice regardless of status
--    B  whether amount_paid agrees with the payments actually recorded
--    C  invoices claiming payment with no payment row  ← the test
--    D  the same arithmetic broken down by status label
--    E  the invoices that do show a balance, largest first
--    F  what A–E together mean, in a sentence
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
         (inv.tot - inv.paid)::numeric    as owed
    from inv
    left join pay on pay.invoice_id = inv.id
),
owing   as (select count(*) n from j where owed >=  0.005),
nomoney as (select count(*) n from j where paid >= 0.005 and pay_rows = 0),
mismatch as (select count(*) n from j where abs(paid - pay_sum) >= 0.005)

select z.part, z.item, z.detail
  from (

  -- ── A. the arithmetic ────────────────────────────────────────────────
  select 1 k, 'A. the arithmetic' part,
         'invoices in total' item,
         count(*)::text detail
    from j
  union all
  select 1, 'A. the arithmetic',
         'owing — amount_paid is short of total_amount',
         count(*)::text
    from j where owed >= 0.005
  union all
  select 1, 'A. the arithmetic',
         'settled exactly, to the cent',
         count(*)::text
    from j where abs(owed) < 0.005
  union all
  select 1, 'A. the arithmetic',
         'overpaid — amount_paid exceeds total_amount',
         count(*)::text
    from j where owed <= -0.005
  union all
  select 1, 'A. the arithmetic',
         'total still owed across every invoice',
         'RM ' || to_char(coalesce(sum(greatest(0,owed)),0),'FM999999990.00')
    from j

  -- ── B. amount_paid against the payments actually recorded ────────────
  union all
  select 2, 'B. amount_paid vs the payment rows',
         'invoices where the two disagree',
         count(*)::text
    from j where abs(paid - pay_sum) >= 0.005
  union all
  select 2, 'B. amount_paid vs the payment rows',
         'how much they disagree by, added up',
         'RM ' || to_char(coalesce(sum(abs(paid - pay_sum)),0),'FM999999990.00')
    from j where abs(paid - pay_sum) >= 0.005

  -- ── C. the test ──────────────────────────────────────────────────────
  union all
  select 3, 'C. paid, with no money behind it',
         'invoices with amount_paid above zero and NO payment row',
         count(*)::text
    from j where paid >= 0.005 and pay_rows = 0
  union all
  select 3, 'C. paid, with no money behind it',
         'what those invoices claim to have collected',
         'RM ' || to_char(coalesce(sum(paid),0),'FM999999990.00')
    from j where paid >= 0.005 and pay_rows = 0

  -- ── D. by status label ───────────────────────────────────────────────
  union all
  select 4, 'D. by status',
         j.status || ' — ' || count(*) || ' invoice' ||
           case when count(*) = 1 then '' else 's' end,
         'owed RM ' || to_char(sum(greatest(0,j.owed)),'FM999999990.00') ||
           ' of RM ' || to_char(sum(j.tot),'FM999999990.00') || ' billed'
    from j group by j.status

  -- ── E. who actually owes ─────────────────────────────────────────────
  union all
  select 5, 'E. invoices showing a balance',
         coalesce(j.invoice_number,'(no number)') || '  [' || j.status || ']',
         'RM ' || to_char(j.owed,'FM999999990.00') ||
           ' of RM ' || to_char(j.tot,'FM999999990.00') ||
           ' — ' || j.pay_rows || ' payment row' ||
           case when j.pay_rows = 1 then '' else 's' end
    from j where j.owed >= 0.005
  union all
  select 5, 'E. invoices showing a balance',
         '(none)',
         'No invoice has amount_paid short of total_amount.'
    from owing where owing.n = 0

  -- ── F. what it means ─────────────────────────────────────────────────
  union all
  select 6, 'F. verdict', 'reading A to E together',
         case
           when (select n from owing) > 0 then
             'Accounts DO owe money, so the outstanding list should not be empty. '
          || 'The arithmetic finds a balance that outstanding_accounts() is not '
          || 'reporting — the fault is in the function, not the data. Send me part E.'
           when (select n from nomoney) > 0 then
             'No invoice shows a balance, but ' || (select n from nomoney) ||
             ' are marked paid with no payment row behind them. amount_paid is '
          || 'being set without money arriving, so a zero outstanding list proves '
          || 'nothing either way. The receipts, not this field, are the record.'
           when (select n from mismatch) > 0 then
             'No invoice shows a balance, and every paid invoice has payment rows, '
          || 'but ' || (select n from mismatch) || ' disagree on the amount. '
          || 'Worth an eye, though it does not explain the zero.'
           else
             'No invoice shows a balance, every paid invoice has payment rows '
          || 'behind it, and the two agree on the amount. Zero accounts owing is '
          || 'the truth: everything billed has been collected. The outstanding '
          || 'reminder has nothing to send because there is nothing to chase.'
         end

  ) z
 order by z.k, z.item;
