-- ════════════════════════════════════════════════════════════════════════
--  A colour per programme, and per level
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so no row-security guard is needed with it.
--
--  RUN supabase_grading_programs.sql FIRST.
--
--  WHY
--  Three programmes drawn in the same blue are three programmes a person
--  has to read to tell apart. Water Discovery and Swim Passport are
--  different ladders for different children, and on the coach's class
--  list and the parent's home screen they sit next to each other --
--  where a colour is read before a word is.
--
--  A level gets one too, because a collection of badges that are all the
--  same colour is a collection that looks like a checklist. The level
--  colour falls back to the programme's, so setting one is optional and
--  a programme stays coherent until somebody decides otherwise.
--
--  STORED, NOT CHOSEN FROM A LIST
--  A free hex rather than an enum: the badges are being drawn by the
--  centre, and a palette picked in this file would be a palette somebody
--  has to work around within a month. Constrained only to the shape of
--  a hex colour, which stops a typo becoming an invisible chip.
-- ════════════════════════════════════════════════════════════════════════

alter table grading_programs
  add column if not exists colour text;
alter table grading_milestones
  add column if not exists colour text;

-- Shape only: #RGB or #RRGGBB. A value the browser cannot parse is a
-- chip that silently vanishes, which reads as a broken screen rather
-- than a bad colour.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grading_programs_colour_hex') then
    alter table grading_programs add constraint grading_programs_colour_hex
      check (colour is null or colour ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'grading_milestones_colour_hex') then
    alter table grading_milestones add constraint grading_milestones_colour_hex
      check (colour is null or colour ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$');
  end if;
end $$;

comment on column grading_programs.colour is
  'The programme''s colour, as #RRGGBB. Null means the app''s default '
  'blue. A level with no colour of its own inherits this one.';
comment on column grading_milestones.colour is
  'This level''s colour. Null inherits the programme''s, so a programme '
  'stays coherent until somebody decides otherwise.';


-- ─── A starting colour, where none is set ───────────────────────────────
-- Only on the seeded three, and only where nothing has been chosen. An
-- update that overwrote a colour somebody picked would be the one thing
-- this file must not do.
update grading_programs set colour = '#0EA5E9' where name = 'Swim Passport'   and colour is null;
update grading_programs set colour = '#14B8A6' where name = 'Water Discovery' and colour is null;
update grading_programs set colour = '#8B5CF6' where name = 'Advanced Program' and colour is null;


-- ─── What is now true ───────────────────────────────────────────────────
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'programmes with a colour' as thing,
         coalesce((select string_agg(name || ' ' || coalesce(colour, '(none)'), ' · '
                          order by sort_order) from grading_programs), 'none') as detail
  union all
  select 2, 'levels with one of their own',
         (select count(*)::text from grading_milestones where colour is not null)
      || ' of ' || (select count(*)::text from grading_milestones)
      || ' — the rest take the programme''s, which is usually what you want'
  union all
  select 3, 'where it shows',
         'The programme pills in Admin → Settings → Grading, the level '
      || 'beside a swimmer on the coach''s class list, and the badge on '
      || 'the parent''s home screen.'
  union all
  select 4, 'next',
         'Refresh the admin app to pick colours. Deploy the attendance '
      || 'and parent apps to see them on a phone.'
  ) z
 order by z.k;
