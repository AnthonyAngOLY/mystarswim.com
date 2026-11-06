-- ════════════════════════════════════════════════════════════════════════
--  Put the money tables under the audit trail that already exists
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  creates no table and changes no data; it attaches triggers.
--
--  WHY, AND WHY NOW
--  Eight numbers are missing from the receipt sequence. Whether each was
--  a receipt somebody was handed and the system later erased, or a
--  number reserved by a save that failed, cannot be answered from this
--  database. The difference matters enormously — one is a document that
--  no longer exists, the other is housekeeping — and the information
--  that would settle it was never written down.
--
--  The mechanism to write it has been here the whole time. audit_log and
--  its trigger function were built for attendance, with the comment
--  "void-not-delete needs a paper trail", and attached to shifts,
--  punches and alerts. They were never attached to payments or invoices.
--  The money was the one thing left outside the paper trail.
--
--  This attaches them. From now on every insert, change and deletion of
--  a payment or an invoice is recorded with the whole row as it was
--  before and after, and who did it. The next time somebody asks what
--  was in a gap, there will be an answer.
--
--  It is not retrospective. The eight already missing stay unanswerable;
--  nothing can recover what was never recorded.
--
--  THE FUNCTION'S NAME
--  attendance_audit() reads tg_table_name and to_jsonb(old/new), so it
--  is general despite what it is called. It is reused rather than copied
--  — a second function doing the same thing is how two copies of the
--  same logic start drifting apart.
-- ════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.attendance_audit()') is null then
    raise exception
      'attendance_audit() is missing — run supabase_attendance_phase1_migration.sql first.';
  end if;
end $$;

drop trigger if exists payments_audit on payments;
create trigger payments_audit
  after insert or update or delete on payments
  for each row execute function attendance_audit();

drop trigger if exists invoices_audit on invoices;
create trigger invoices_audit
  after insert or update or delete on invoices
  for each row execute function attendance_audit();

-- invoice_lines carries the amounts an invoice is made of. An invoice
-- whose total changed without its lines changing, or the reverse, is
-- worth being able to see.
drop trigger if exists invoice_lines_audit on invoice_lines;
create trigger invoice_lines_audit
  after insert or update or delete on invoice_lines
  for each row execute function attendance_audit();

comment on table audit_log is
  'Row-level history for the tables that must not lose one: shifts, '
  'punches, alerts, and now payments, invoices and invoice_lines. '
  'before_json holds the row as it was, so a deletion is recoverable '
  'in full.';


-- ─── What is now watched, and what was ──────────────────────────────────
select thing, detail from (
  select 1 as sort, 'tables now audited' as thing,
         string_agg(c.relname, ', ' order by c.relname) as detail
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and t.tgfoid = 'public.attendance_audit()'::regprocedure

  union all
  select 2, 'rows of history so far',
         (select count(*)::text from audit_log)

  union all
  select 3, 'money rows of history so far',
         (select count(*)::text from audit_log
           where table_name in ('payments','invoices','invoice_lines'))
      || ' (only what has happened since the triggers were attached —'
      || ' this is not retrospective)'

  union all
  select 4, 'what this does not do',
         'It cannot say what the eight missing receipt numbers were. '
      || 'Whether each was a receipt that was erased or a number burnt '
      || 'by a save that failed is not recorded anywhere, so it is not '
      || 'answerable — not here and not by any other query.'
) z order by sort;
