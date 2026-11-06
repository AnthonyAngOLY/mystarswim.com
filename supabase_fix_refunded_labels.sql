-- ════════════════════════════════════════════════════════════════════════
--  An invoice that was refunded should say so
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run: the
--  second run finds nothing to do and says so.
--
--  WHY
--  INV-202607-130 was paid and then refunded. Both payment rows are
--  there and they cancel out, so no money is owed. Its status was never
--  moved off 'sent'. outstanding_accounts() reads the status, finds an
--  invoice that is not void, refunded or draft, and reports a family as
--  owing RM 60.00. Run the end-of-month blast as it stands and that
--  family is asked to pay money it has already had back.
--
--  WHAT IT CHANGES
--  Every invoice whose payment rows net to zero and whose status is
--  neither void nor refunded becomes 'refunded'. Written as a rule
--  rather than against one invoice number, so the same mistake made
--  again is caught by running this file again.
--
--  It touches the status column and nothing else. No payment row is
--  changed, moved or removed — the refund stays exactly where it is,
--  which is the record of what happened. Nothing is deleted.
--
--  THE CHANGE IS RECORDED
--  supabase_money_audit_trail.sql put invoices under the audit trigger.
--  This edit is written to audit_log with the row as it was before and
--  after, so the correction itself leaves a trail. That is the first
--  real use of the trail; it exists for exactly this.
--
--  ONE STATEMENT
--  The update and the report are a single statement: the update runs
--  inside the with clause and the select reads back what it changed. The
--  SQL editor shows only the last statement, so this way the result is
--  the list of corrections rather than a row count with no detail.
-- ════════════════════════════════════════════════════════════════════════

with netted as (
  -- Invoices whose payments exist and cancel out, mislabelled.
  select i.id,
         i.invoice_number,
         coalesce(i.total_amount,0)::numeric as tot,
         coalesce(i.status,'(no status)')    as was
    from invoices i
    join (
      select p.invoice_id,
             sum(p.amount)::numeric as net,
             count(*)               as rows_n
        from payments p
       where p.invoice_id is not null
       group by p.invoice_id
    ) q on q.invoice_id = i.id
   where q.rows_n > 0
     and abs(q.net) < 0.005
     and coalesce(i.status,'') not in ('void','refunded')
),
changed as (
  update invoices i
     set status = 'refunded'
    from netted n
   where n.id = i.id
  returning n.invoice_number, n.tot, n.was
)

select z.invoice, z.change, z.value
  from (
    select 1 k,
           coalesce(c.invoice_number,'(no number)') as invoice,
           'was ''' || c.was || ''', now ''refunded''' as change,
           'RM ' || to_char(c.tot,'FM999999990.00')
             || ' billed, paid, and refunded in full' as value
      from changed c
    union all
    select 2,
           '(nothing to correct)',
           'Every invoice whose payments cancel out already says refunded '
             || 'or void.',
           ''
      from (select count(*) n from changed) t
     where t.n = 0
  ) z
 order by z.k, z.invoice;
