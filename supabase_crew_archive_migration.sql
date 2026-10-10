-- ============================================================================
-- Star Swim — Crew archive
-- ----------------------------------------------------------------------------
-- People leave. Their record has to stay: attendance history, payroll banking
-- details and the dates they worked are all still answers to questions
-- somebody will ask next year. But a leaver has no business sitting in the
-- roster picker next to the instructors who are actually teaching.
--
-- So: archive, not delete. One timestamp. Archived crew drop out of the main
-- list and out of the "who is working this session" dropdown; everything
-- already recorded against them is untouched, and their name still resolves
-- on every past shift and report.
--
-- Deliberately a timestamp rather than a flag, because "when did they go"
-- gets asked and a boolean cannot answer it.
--
-- Additive and reversible. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

do $$
declare v_tbl text;
begin
  -- Same resolution as the attendance migrations: whichever worker table this
  -- project actually has.
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;

  if v_tbl is null then
    raise exception 'No worker table found (looked for crew, admin_employees).';
  end if;

  execute format('alter table public.%I add column if not exists archived_at timestamptz', v_tbl);

  -- Everyone currently on the books is, by definition, not archived. The
  -- column defaults to null, so this is a statement of intent rather than a
  -- backfill — there is nothing to correct.
  raise notice 'archived_at added to public.%', v_tbl;
end $$;

commit;

-- ============================================================================
-- §VERIFY
--   select count(*) from information_schema.columns
--    where table_name in ('crew','admin_employees') and column_name='archived_at';   -- 1
--
-- WHO IS ARCHIVED
--   select full_name, status, archived_at from admin_employees
--    where archived_at is not null order by archived_at desc;
--
-- ROLLBACK
--   alter table admin_employees drop column if exists archived_at;
--   -- (or crew, whichever this project has)
-- ============================================================================
