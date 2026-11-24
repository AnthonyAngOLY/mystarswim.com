-- ════════════════════════════════════════════════════════════════════════
--  Refunds, documented the way an accountant expects them
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  IT CREATES A TABLE, SO supabase_rls_guard.sql IS THE SECOND HALF OF
--  THIS JOB. credit_notes is locked below, but run the guard after this
--  and read its last query. The anon key is printed in every page we
--  serve; a table without row security is readable by anyone who views
--  source.
--
--  WHY
--  Refunding already worked, and worked correctly: the original invoice
--  and its receipt are left alone, and a negative payments row with its
--  own receipt number nets the cash out. Nothing is destroyed, which is
--  the part that matters.
--
--  Three things were missing around it.
--
--    There was no credit note. A refund receipt is the document for the
--    money going back. A credit note is the document that reverses the
--    sale. They are different instruments and LHDN e-invoicing expects
--    the second one; we only had the first.
--
--    The refund form captured no reference. refundInvoice() accepted one
--    and the form never sent it, so a refund paid by bank transfer had
--    no transfer reference against it anywhere.
--
--    And there was nowhere to keep the proof. A transfer slip lived in
--    somebody's phone, which is not where it is wanted eleven months
--    later when the family asks.
--
--  WHAT A CREDIT NOTE IS NOT
--  It is not a void. Void is for an invoice that should never have
--  existed. A credit note says the invoice was right and is now being
--  reversed, in whole or in part, and leaves both documents standing.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. The numbering ───────────────────────────────────────────────────
-- Its own sequence, like invoices and receipts. A credit note sharing the
-- invoice sequence would leave gaps in the invoice numbers, and a gap in
-- a numbered sequence is the thing an auditor asks about.
alter table invoice_settings
  add column if not exists credit_note_prefix   text    not null default 'CN',
  add column if not exists next_credit_note_seq integer not null default 1;

-- ─── 2. Where the proof lives ───────────────────────────────────────────
alter table payments
  add column if not exists proof_path text;

comment on column payments.proof_path is
  'Object path in the refund-proofs bucket: the transfer slip or signed '
  'acknowledgement for money paid back. Null on ordinary payments.';

-- ─── 3. The credit note itself ──────────────────────────────────────────
create table if not exists credit_notes (
  id                 uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique,
  invoice_id         uuid not null references invoices(id) on delete restrict,
  -- The refund receipt this note accompanies, where there is one. A note
  -- can exist without a payment row: a sale reversed before the money
  -- went back is still a reversed sale.
  payment_id         uuid references payments(id) on delete set null,
  amount             numeric(12,2) not null check (amount > 0),
  reason             text,
  issue_date         date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  branch_id          uuid,
  created_at         timestamptz not null default now()
);

create index if not exists credit_notes_invoice_idx on credit_notes (invoice_id);
create index if not exists credit_notes_date_idx    on credit_notes (issue_date desc);

comment on table credit_notes is
  'The document that reverses a sale. Separate from the refund receipt, '
  'which is the document for the money: an invoice can be credited '
  'without cash moving, and cash can move before the note is raised.';

-- on delete restrict on invoice_id, deliberately. A credit note that
-- outlives the invoice it reverses refers to nothing, and an invoice with
-- a credit note against it is not one anybody should be deleting.

alter table credit_notes enable row level security;
revoke all on credit_notes from anon;
grant select, insert, update on credit_notes to authenticated;

drop policy if exists credit_notes_office on credit_notes;
create policy credit_notes_office on credit_notes for all to authenticated
  using (is_website_login()) with check (can_write_office());

-- Never deleted. A credit note is a numbered document that was handed
-- over; withdrawing one is itself an accounting event, not a delete.
revoke delete on credit_notes from authenticated;

-- ─── 4. The proof bucket ────────────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No storage schema here — skipping the bucket (expected outside Supabase).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('refund-proofs', 'refund-proofs', false, 10485760,
          array['application/pdf','image/jpeg','image/png','image/webp'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Private, office only. A transfer slip carries a bank account number
  -- and a customer's name; it is not a thing to leave readable.
  execute $p$ drop policy if exists refund_proofs_office_insert on storage.objects $p$;
  execute $p$
    create policy refund_proofs_office_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'refund-proofs' and can_write_office()) $p$;

  execute $p$ drop policy if exists refund_proofs_office_read on storage.objects $p$;
  execute $p$
    create policy refund_proofs_office_read on storage.objects for select to authenticated
    using (bucket_id = 'refund-proofs' and is_website_login()) $p$;

  -- No delete policy. The proof of a refund is part of the refund.
  raise notice 'refund-proofs bucket ready (private, 10 MB, PDF and images).';
end $$;

-- ─── 5. The money tables already keep a paper trail ─────────────────────
-- supabase_money_audit_trail.sql attached attendance_audit() to payments
-- and invoices. credit_notes belongs with them.
do $$
begin
  if to_regclass('public.audit_log') is null then
    raise notice 'No audit_log — run supabase_money_audit_trail.sql first.';
    return;
  end if;
  execute 'drop trigger if exists credit_notes_audit on credit_notes';
  execute 'create trigger credit_notes_audit after insert or update or delete '
       || 'on credit_notes for each row execute function attendance_audit()';
end $$;

-- ─── 6. What is now in place ────────────────────────────────────────────
select z.thing, z.detail
  from (
  select 1 k, 'credit note numbering' as thing,
         (select coalesce(credit_note_prefix,'CN') || ', next number '
               || coalesce(next_credit_note_seq,1)::text
            from invoice_settings where id = 1) as detail
  union all
  select 2, 'credit notes raised so far', (select count(*)::text from credit_notes)
  union all
  select 3, 'refund proofs stored',
         (select count(*)::text from payments where proof_path is not null)
      || ' — none until the next refund is recorded with one attached'
  union all
  select 4, 'the bucket',
         case when to_regclass('storage.buckets') is null then 'no storage schema here'
              when exists (select 1 from storage.buckets where id = 'refund-proofs')
              then 'refund-proofs — private, 10 MB, PDF and images'
              else 'NOT created — look at the notices above' end
  union all
  select 5, 'who can read a proof',
         'Any website seat. Who can write one, and who can raise a credit '
      || 'note, is the office seats only — the same rule as invoices.'
  union all
  select 6, 'still to do',
         'Run supabase_rls_guard.sql. This file created a table, and the '
      || 'guard is the second half of that job, not optional.'
  ) z
 order by z.k;
