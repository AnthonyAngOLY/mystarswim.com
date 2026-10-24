-- ════════════════════════════════════════════════════════════════════════
--  Stage B — the last five tables, and the public key loses its pen
-- ════════════════════════════════════════════════════════════════════════
--  ⚠️  DEPLOY ORDER MATTERS, AND GETTING IT WRONG TAKES ENROLMENT DOWN.
--
--      1. Deploy the public-intake Edge Function.
--      2. Deploy the website (Netlify builds the new intake form).
--      3. Run this file.
--
--      Run this before step 1 and the intake form stops working: it
--      would still be writing students with the anon key, and this takes
--      that away. Run it after and there is no gap at all, because the
--      new form does not use the anon key for anything.
--
--  WHAT STAGE A LEFT OPEN, AND WHY
--  Five tables the public website genuinely touched with the anon key:
--
--    promos            the homepage reads the live banner
--    branches          the intake form reads the branch list
--    contact_messages  the homepage writes an enquiry
--    students          the intake form wrote the children
--    tc_acceptances    the intake form wrote the signed terms
--
--  The first three are fine as they are, narrowed. The last two were
--  the reason Stage A had to stop: students cannot be locked while the
--  public form is writing to it, and students is the table with
--  children's names and their parents' contact details in it.
--
--  WHAT CHANGED SO THEY CAN BE LOCKED
--  The intake form no longer writes anything. public-intake does, behind
--  the service role, which ignores row security entirely. So the public
--  key can be refused outright on both tables rather than given a door
--  narrow enough to be safe — there is no such door for a table anybody
--  can insert into.
--
--  WHAT THE PUBLIC KEY KEEPS, AND ONLY THIS
--    read   promos that are switched on
--    read   branches that are switched on
--    write  one contact message, and never read one back
--
--  No reads of students. No reads of acceptances. No reading back the
--  enquiries other people have sent.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. promos — the homepage banner ─────────────────────────────────────
alter table promos enable row level security;
drop policy if exists promos_public_read on promos;
drop policy if exists promos_office      on promos;

create policy promos_public_read on promos
  for select to anon using (coalesce(is_active, true));

create policy promos_office on promos
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all     on promos from anon;
grant  select  on promos to   anon;
grant  select, insert, update, delete on promos to authenticated;


-- ── 2. branches — the intake form's branch picker ───────────────────────
alter table branches enable row level security;
drop policy if exists branches_public_read on branches;
drop policy if exists branches_office      on branches;

create policy branches_public_read on branches
  for select to anon using (coalesce(is_active, true));

create policy branches_office on branches
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all    on branches from anon;
grant  select on branches to   anon;
grant  select, insert, update, delete on branches to authenticated;


-- ── 3. contact_messages — write only, and never read back ───────────────
-- An enquiry holds a name, an email and whatever somebody chose to tell
-- us. Insert with no select is the whole shape of a contact form: you
-- can post one, you cannot read anybody else's.
alter table contact_messages enable row level security;
drop policy if exists contact_messages_public_write on contact_messages;
drop policy if exists contact_messages_office       on contact_messages;

create policy contact_messages_public_write on contact_messages
  for insert to anon with check (true);

create policy contact_messages_office on contact_messages
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all    on contact_messages from anon;
grant  insert on contact_messages to   anon;
grant  select, insert, update, delete on contact_messages to authenticated;


-- ── 4. students — closed to the public key entirely ─────────────────────
-- public-intake writes this with the service role now, which does not
-- consult row security. The office reads and writes it as before. The
-- parent app's own policy comes with the parent app, not here: until
-- then nothing but an office login can read a student row.
alter table students enable row level security;
drop policy if exists students_office on students;

create policy students_office on students
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all on students from anon;
grant select, insert, update, delete on students to authenticated;


-- ── 5. tc_acceptances — the same ────────────────────────────────────────
alter table tc_acceptances enable row level security;
drop policy if exists tc_acceptances_office on tc_acceptances;

create policy tc_acceptances_office on tc_acceptances
  for all to authenticated
  using (is_website_login()) with check (is_website_login());

revoke all on tc_acceptances from anon;
grant select, insert, update, delete on tc_acceptances to authenticated;


-- ═══ Confirm ════════════════════════════════════════════════════════════

-- Nothing in public should read ">>> OPEN" any more.
select c.relname as table_name,
       case when c.relrowsecurity then 'locked' else '>>> OPEN' end as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relrowsecurity, c.relname;

-- What the public key may still do, in full. Expect exactly three rows:
-- read promos, read branches, insert a contact message.
select p.tablename, p.cmd, p.qual as can_see, p.with_check as may_write
  from pg_policies p
 where p.schemaname = 'public'
   and 'anon' = any (p.roles)
 order by 1, 2;

-- The public schedule, which reads through a view and is unaffected.
select count(*) as public_schedule_rows from public_schedule_preview;
