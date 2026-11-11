-- ════════════════════════════════════════════════════════════════════════
--  The customer's IC and TIN: the columns the save has been failing on
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  creates NO TABLE — four columns on two tables that already exist — so
--  it needs no RLS guard beside it. The policies on students and
--  invoices already cover every column on those tables, including ones
--  added later, so office and sysadmin can write these the moment they
--  exist.
--
--  WHY THE SAVE LOST THE IC
--  The account contact editor already collects an IC and a TIN, and
--  updateStudent() already puts them in the PATCH:
--
--      if('guardianIc'  in patch) body.guardian_ic  = patch.guardianIc  || null;
--      if('guardianTin' in patch) body.guardian_tin = patch.guardianTin || null;
--
--  Those columns were never created. PostgREST rejects a PATCH naming a
--  column that does not exist, so the whole save fails — not just the IC,
--  the entire edit — the screen reloads from the database, and what comes
--  back is what was there before. It looks exactly like the field being
--  ignored. Nothing was blocking the seat; there was nowhere to put it.
--
--  WHY FOUR COLUMNS AND NOT TWO
--  guardian_ic and guardian_tin live on students, where the rest of the
--  account's contact details live, and that is what the editor writes.
--
--  account_ic and account_tin go on invoices for the same reason
--  account_email and account_phone are already there: an invoice is a
--  document issued on a date, and it should keep saying what it said
--  when it was handed over. Reading the customer's particulars live
--  would mean a reprint silently changing after the customer edits their
--  details, which is not what an invoice is.
--
--  ONE STATEMENT
--  The SQL editor shows the result of the last statement only, so the
--  confirmation is a single select over all four columns.
-- ════════════════════════════════════════════════════════════════════════

alter table students add column if not exists guardian_ic  text;
alter table students add column if not exists guardian_tin text;

alter table invoices add column if not exists account_ic  text;
alter table invoices add column if not exists account_tin text;

comment on column students.guardian_ic  is
  'The account holder''s IC / NRIC, as the customer gives it. Free text: '
  'an IC is an identifier printed on a document, not a number to compute '
  'with, and bending it into a shape loses the one the customer asked for.';
comment on column students.guardian_tin is
  'The account holder''s tax identification number, where they have one.';
comment on column invoices.account_ic   is
  'The IC as it stood when this invoice was issued. A snapshot, like '
  'account_email — a reprint has to match what was handed over.';
comment on column invoices.account_tin  is
  'The TIN as it stood when this invoice was issued.';

-- ─── Confirm ────────────────────────────────────────────────────────────
select z.thing, z.detail
  from (
  select 1 k, 'columns now present' as thing,
         string_agg(c.table_name || '.' || c.column_name, ', ' order by
                    c.table_name, c.column_name) as detail
    from information_schema.columns c
   where c.table_schema = 'public'
     and ((c.table_name = 'students' and c.column_name in ('guardian_ic','guardian_tin'))
       or (c.table_name = 'invoices' and c.column_name in ('account_ic','account_tin')))

  union all
  select 2, 'all four there',
         case when count(*) = 4 then 'Yes — the contact editor can save an IC now.'
              else count(*)::text || ' of 4. Something above did not run.' end
    from information_schema.columns c
   where c.table_schema = 'public'
     and ((c.table_name = 'students' and c.column_name in ('guardian_ic','guardian_tin'))
       or (c.table_name = 'invoices' and c.column_name in ('account_ic','account_tin')))

  union all
  select 3, 'who can write them',
         'Whoever could already edit a student or an invoice. These are '
      || 'columns on existing tables, so the existing policies apply '
      || 'unchanged — no seat gained anything and none lost anything.'

  union all
  select 4, 'existing records',
         (select count(*)::text from students where guardian_ic is not null)
      || ' students carry an IC. New ones are entered in the account contact '
      || 'editor; invoices created from then on keep their own copy.'
  ) z
 order by z.k;
