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
--  of. A location may hold more than one body of water, so pools point
--  at a location rather than the other way round.
--
--  POOLS ARE MATCHED BY PREFIX AS WELL AS BY NAME
--  The convention is a location called SSGT holding pools called SSGT
--  Pool A and SSGT Pool B — related names, deliberately not identical.
--  An exact match would link none of them. So a pool also matches a
--  location whose whole name begins it, at a word boundary: "SSGT Pool
--  A" belongs to "SSGT". Where two locations could both claim it the
--  longer wins, and where two tie, neither does.
--
--  Coaches are NOT matched this way. "Ali" is not evidence about "Ali
--  Bin Ali", and a wrong coach link shows somebody else's swimmers.
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

-- B. Pools. Exact name, or the location's whole name at the start of
--    the pool's, which is the convention: SSGT → SSGT Pool A.
with p as (
  select id, btrim(name) as nm,
         btrim(lower(regexp_replace(name, '\s+', ' ', 'g'))) as key
    from pools where is_active is not false and location_id is null
),
l as (
  select id, btrim(name) as nm,
         btrim(lower(regexp_replace(name, '\s+', ' ', 'g'))) as key
    from locations
),
cand as (
  select p.id as pool_id, p.nm as pool, l.nm as loc, length(l.key) as len
    from p join l
      on p.key = l.key
      or p.key like l.key || ' %'
      or p.key like l.key || '-%'
),
best as (
  select pool_id, max(len) as len from cand group by pool_id
)
select p.nm as pool,
       coalesce((select string_agg(c.loc, ' | ') from cand c join best b
                  on b.pool_id = c.pool_id and c.len = b.len
                 where c.pool_id = p.id), '—') as location,
       case
         when (select count(*) from cand c join best b
                on b.pool_id = c.pool_id and c.len = b.len
               where c.pool_id = p.id) = 1 then 'will link'
         when (select count(*) from cand c where c.pool_id = p.id) = 0
              then '>>> no location matches — link by hand'
         else '>>> two locations claim it equally — a person must choose'
       end as what_happens
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

-- The longest location name that begins this pool's name, and only
-- where exactly one location is that long. "SSGT Annexe Pool A" goes to
-- "SSGT Annexe" rather than to "SSGT"; a genuine tie goes nowhere.
with p as (
  select id, btrim(lower(regexp_replace(name, '\s+', ' ', 'g'))) as key
    from pools where is_active is not false and location_id is null
),
l as (
  select id, btrim(lower(regexp_replace(name, '\s+', ' ', 'g'))) as key
    from locations
),
cand as (
  select p.id as pool_id, l.id as loc_id, length(l.key) as len
    from p join l
      on p.key = l.key
      or p.key like l.key || ' %'
      or p.key like l.key || '-%'
),
winner as (
  -- array_agg rather than min(): there is no min(uuid) in Postgres, and
  -- the having below guarantees exactly one row to take.
  select c.pool_id, (array_agg(c.loc_id))[1] as loc_id
    from cand c
    join (select pool_id, max(len) as len from cand group by pool_id) b
      on b.pool_id = c.pool_id and c.len = b.len
   group by c.pool_id
  having count(*) = 1
)
update pools p
   set location_id = w.loc_id
  from winner w
 where p.id = w.pool_id
   and p.location_id is null;


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

-- Which pools ended up in which location, to eyeball. A pool in the
-- wrong location shows a coach the classes from the wrong water.
select l.name as location,
       string_agg(p.name, ', ' order by p.name) as pools_in_it
  from locations l
  join pools p on p.location_id = l.id
 group by l.id, l.name
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
