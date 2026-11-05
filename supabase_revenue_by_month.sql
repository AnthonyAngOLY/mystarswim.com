-- ════════════════════════════════════════════════════════════════════════
--  Billed, collected, outstanding — every month, side by side
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It reads and reports.
--
--  WHY THIS, AND WHY IT IS THE ONE TO RUN FIRST
--  The Revenue screen says RM 34,460 came in during September. The bank
--  says about RM 11,000. One of those is wrong, or they are measuring
--  different things, and arguing about it settles nothing.
--
--  This brings in a third number that depends on neither: what was
--  INVOICED. An invoice is raised when a family is billed, long before
--  any money moves, by a different part of the system. So:
--
--    · If invoiced and collected track each other month after month,
--      then every payment has a bill behind it. The payments are real
--      transactions against real families, and the money was collected
--      from somebody. The question then belongs outside this database:
--      which account it reached, or whether it reached one.
--
--    · If collected runs well ABOVE invoiced, the payments table is
--      producing money that was never billed — duplicates, or amounts
--      larger than what was owed. That is a fault in here and it can be
--      found and corrected.
--
--    · If collected runs well BELOW invoiced, nothing is overstated;
--      families simply owe you money, and the outstanding column says
--      how much.
--
--  Two numbers can always be argued about. Three cannot.
--
--  ON THE MISSING FOURTH NUMBER
--  Nothing records WHO took a payment. The column does not exist and
--  never did, so this report cannot break the figures down by person
--  and neither can any other. supabase_money_audit_trail.sql fixes that
--  from the day it is run, and not one day earlier.
-- ════════════════════════════════════════════════════════════════════════

with
months as (
  select to_char(d, 'YYYY-MM') as ym
    from generate_series(
      date_trunc('month', (select min(least(coalesce(issue_date, current_date),
                                            current_date)) from invoices)),
      date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date),
      interval '1 month') d
),
billed as (
  select to_char(issue_date,'YYYY-MM') ym,
         count(*) n, sum(coalesce(total_amount,0)) amt,
         sum(greatest(0, coalesce(total_amount,0) - coalesce(amount_paid,0))) owing
    from invoices
   where coalesce(status,'') <> 'void' and issue_date is not null
   group by 1
),
collected as (
  select to_char(p.payment_date,'YYYY-MM') ym,
         count(*) n, sum(p.amount) amt
    from payments p
    left join invoices i on i.id = p.invoice_id
   where p.payment_date is not null
     and coalesce(i.status,'') <> 'void'
   group by 1
)

select m.ym                                       as month,
       coalesce(b.n,0)                            as invoices,
       'RM ' || to_char(coalesce(b.amt,0),'FM999999990.00')   as billed,
       coalesce(c.n,0)                            as receipts,
       'RM ' || to_char(coalesce(c.amt,0),'FM999999990.00')   as collected,
       'RM ' || to_char(coalesce(b.owing,0),'FM999999990.00') as still_owing,
       -- Collected as a share of billed. Around 100 means the two agree.
       -- Well over 100 is the one that needs explaining in here; well
       -- under means money is owed, not missing.
       case when coalesce(b.amt,0) = 0 then '—'
            else to_char(round(100.0 * coalesce(c.amt,0) / b.amt), 'FM990') || '%' end
                                                  as collected_vs_billed
  from months m
  left join billed    b on b.ym = m.ym
  left join collected c on c.ym = m.ym
 order by m.ym;
