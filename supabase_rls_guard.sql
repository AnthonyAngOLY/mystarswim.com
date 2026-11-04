-- ════════════════════════════════════════════════════════════════════════
--  Nothing in public should ever be open to the anon key
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run, and
--  worth re-running: the last query is the standing check, and it is the
--  one to run after any file that creates a table.
--
--  WHY THIS EXISTS
--  The anon key is printed in every page we serve. That is not a leak —
--  it is how a browser talks to Supabase at all — but it means row
--  security is the only thing between the public internet and this
--  database. A table created without it is readable and writable by
--  anybody who views source.
--
--  roster_weeks sat like that for a week. It was created by a file that
--  enabled security on nothing, nobody noticed, and the only reason it
--  was found is that a check happened to list it. Relying on noticing is
--  not a control.
--
--  TWO LAYERS, BECAUSE THE FIRST ONE MAY NOT BE ALLOWED
--  Layer one is an event trigger that locks every new table in public
--  the moment it is created, so forgetting becomes impossible. Creating
--  an event trigger needs privileges a hosted project may not grant; if
--  it is refused, this file says so plainly rather than appearing to
--  have worked.
--
--  Layer two is the check at the bottom, which needs no privileges at
--  all and answers the question directly.
--
--  A TABLE LOCKED WITH NO POLICY IS SAFE, NOT FINISHED
--  Row security on and no policy means nobody but the service role can
--  read it. That is the right way to fail — closed — but it will look
--  like data disappearing. The check names those separately so they are
--  not mistaken for either a problem or a job done.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Lock every new table, if this project allows it ─────────────────
create or replace function lock_new_public_tables()
returns event_trigger
language plpgsql security definer as $$
declare r record;
begin
  for r in
    select object_identity
      from pg_event_trigger_ddl_commands()
     where command_tag = 'CREATE TABLE'
       and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', r.object_identity);
    raise notice 'Row security enabled on % by the standing guard.', r.object_identity;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_event_trigger where evtname = 'lock_new_public_tables_trg') then
    raise notice 'GUARD: already in place.';
  else
    begin
      execute $e$
        create event trigger lock_new_public_tables_trg
          on ddl_command_end when tag in ('CREATE TABLE')
          execute function lock_new_public_tables()
      $e$;
      raise notice 'GUARD: installed. New tables in public are locked on creation.';
    exception
      when insufficient_privilege or feature_not_supported then
        raise notice 'GUARD: not permitted on this project (%). The check below is the control.', sqlerrm;
      when others then
        raise notice 'GUARD: could not be installed (%). The check below is the control.', sqlerrm;
    end;
  end if;
end $$;


-- ─── 2. The standing check ──────────────────────────────────────────────
-- One statement, because the SQL editor shows the last result only.
--
-- Run this after any file that creates a table. Three verdicts:
--
--   >>> OPEN TO THE ANON KEY   anybody with the key can read and write
--                              it. Fix before anything else.
--   locked, no policy          closed to everyone but the service role.
--                              Safe, but the app will see nothing.
--   locked                     as intended.
select case
         when not c.relrowsecurity then '>>> OPEN TO THE ANON KEY'
         when p.n = 0              then 'locked, no policy'
         else ''
       end                                              as action,
       case
         when not c.relrowsecurity then 'open'
         when p.n = 0              then 'no policy'
         else 'locked'
       end                                              as state,
       c.relname::text                                  as table_name,
       p.n                                              as policies,
       case
         when not c.relrowsecurity
           then 'alter table ' || quote_ident(c.relname) || ' enable row level security;'
         when p.n = 0
           then 'needs a policy, or nothing but the service role can read it'
         else ''
       end                                              as what_to_do
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join lateral (
    select count(*)::int as n from pg_policy pol where pol.polrelid = c.oid
  ) p on true
 where n.nspname = 'public'
   and c.relkind = 'r'
 order by c.relrowsecurity,          -- open ones first
          (p.n = 0) desc,            -- then locked-but-empty
          c.relname;
