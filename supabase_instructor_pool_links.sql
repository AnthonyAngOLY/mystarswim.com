-- ════════════════════════════════════════════════════════════════════════
--  Join the timetable to the attendance app
-- ════════════════════════════════════════════════════════════════════════
--  STEP 1 and STEP 2 change nothing. Read them, then run STEP 3.
--  Safe to re-run. Nothing is deleted and no existing column changes.
--
--  WHAT IS MISSING
--  To put a class's swimmers in front of the coach teaching it, three
--  questions have to be answerable. Today none of them are.
--
--    Which crew member is this coach?
--      scheduler_instructors is the timetable's list of coach names.
--      admin_employees is the crew list the attendance app runs on.
--      Nothing joins them. Sally the coach and Sally the crew member
--      are, to this database, two different people.
--
--    Is this pool that location?
--      pools is the scheduler's — a name and a branch. locations is the
--      attendance app's — a name, a latitude and a geofence. "SSGT"
--      exists twice, as two unrelated rows.
--
--    Which classes does this shift cover?
--      Answered by arithmetic once the first two are, so it needs no
--      column: every session at that pool whose time falls inside the
--      shift window.
--
--  This file adds the two columns and fills in the matches it is sure
--  of. A pool may hold more than one body of water, so pools point at a
--  location rather than the other way round.
--
--  WHAT "SURE OF" MEANS
--  An exact name match, after trimming and lowercasing, where exactly
--  one row on each side has that name. Anything with two candidates, or
--  none, is left alone and listed for a person. A wrong link here shows
--  a coach somebody else's swimmers, so a near-miss is not good enough.
--
--  STEP 2 shows every link it would make before it makes one.
-- ════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 — the columns ═══════════════════════════════════════════════
alter table scheduler_instructors
  add column if not exists crew_id uuid references admin_employees(id);

alter table pools
  add column if not exists location_id uuid references locations(id);

create index if not exists scheduler_instructors_crew_idx
  on scheduler_instructors (crew_id) where crew_id is not null;
create index if not exists pools_location_idx
  on pools (location_id) where location_id is not null;

comment on column scheduler_instructors.crew_id is
  'Which crew member this coach is, so the attendance app can show them '
  'the swimmers in the classes they are assigned to. Null means they '
  'have no attendance login and will see no swimmers.';
comment on column pools.location_id is
  'Which attendance location this pool sits in. Several pools may share '
  'one location; one pool is in at most one.';


-- ═══ STEP 2 — what STEP 3 would link. Changes nothing. ══════════════════

-- A. Coaches.
with i as (
  select id, btrim(name) as nm, btrim(lower(name)) as key
    from scheduler_instructors
   where is_active is not false and crew_id is null
),
e as (
  select id, btrim(full_name) as nm, btrim(lower(full_name)) as key
    from admin_employees
   where archived_at is null
),
counts as (
  select i.id, i.nm,
         (select count(*) from e where e.key = i.key)                         as crew_matches,
         (select count(*) from i i2 where i2.key = i.key)                      as coach_dupes,
         (select max(e.nm) from e where e.key = i.key)                         as crew_name,
         (select bool_or(e2.auth_user_id is not null) from admin_employees e2
           where btrim(lower(e2.full_name)) = i.key and e2.archived_at is null) as has_login
    from i
)
select nm as coach_on_the_timetable,
       coalesce(crew_name, '—') as crew_record,
       case
         when crew_matches = 0 then '>>> no crew record with that name — link by hand or leave'
         when crew_matches > 1 or coach_dupes > 1
              then '>>> more than one match — a person must choose'
         when not has_login
              then 'will link, but they have no attendance login yet'
         else 'will link'
       end as what_happens
  from counts
 order by 3, 1;

-- B. Pools.
with p as (
  select id, btrim(name) as nm, btrim(lower(name)) as key
    from pools where is_active is not false and location_id is null
),
l as (
  select id, btrim(name) as nm, btrim(lower(name)) as key from locations
)
select p.nm as pool,
       coalesce((select max(l.nm) from l where l.key = p.key), '—') as location,
       case
         when (select count(*) from l where l.key = p.key) = 1 then 'will link'
         when (select count(*) from l where l.key = p.key) = 0
              then '>>> no location with that name — link by hand'
         else '>>> more than one location with that name' end as what_happens
  from p
 order by 3, 1;


-- ═══ STEP 3 — make the certain links ════════════════════════════════════
-- Only where exactly one row on each side carries the name. Everything
-- else is left for the Settings screens, where it can be chosen rather
-- than guessed.
update scheduler_instructors si
   set crew_id = e.id
  from admin_employees e
 where si.crew_id is null
   and si.is_active is not false
   and e.archived_at is null
   and btrim(lower(e.full_name)) = btrim(lower(si.name))
   and (select count(*) from admin_employees x
         where x.archived_at is null
           and btrim(lower(x.full_name)) = btrim(lower(si.name))) = 1
   and (select count(*) from scheduler_instructors y
         where y.is_active is not false
           and btrim(lower(y.name)) = btrim(lower(si.name))) = 1;

update pools p
   set location_id = l.id
  from locations l
 where p.location_id is null
   and p.is_active is not false
   and btrim(lower(l.name)) = btrim(lower(p.name))
   and (select count(*) from locations x
         where btrim(lower(x.name)) = btrim(lower(p.name))) = 1;


-- ═══ STEP 4 — what is linked, and what still needs a person ═════════════
select 'coaches linked'        as thing, count(*) as n from scheduler_instructors where crew_id is not null
union all
select 'coaches still unlinked',       count(*) from scheduler_instructors
  where crew_id is null and is_active is not false
union all
select 'pools linked',                 count(*) from pools where location_id is not null
union all
select 'pools still unlinked',         count(*) from pools
  where location_id is null and is_active is not false
order by 1;

-- Every coach still to link. Settings → Instructors.
select si.name as coach,
       'no crew record matched by name — pick one on Settings → Instructors' as what_to_do
  from scheduler_instructors si
 where si.crew_id is null and si.is_active is not false
 order by 1;

-- Every pool still to link. Settings → Pools & Hours.
select p.name as pool,
       'no location matched by name — pick one on Settings → Pools & Hours' as what_to_do
  from pools p
 where p.location_id is null and p.is_active is not false
 order by 1;

-- And what was linked, to eyeball. A wrong row here shows a coach the
-- wrong swimmers, so it is worth the thirty seconds.
select si.name as coach, e.full_name as crew_record,
       case when e.auth_user_id is null
            then 'no attendance login yet — they will see nothing until one is made'
            else 'has an attendance login' end as state
  from scheduler_instructors si
  join admin_employees e on e.id = si.crew_id
 order by 1;
