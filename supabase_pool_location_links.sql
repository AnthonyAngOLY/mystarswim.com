-- ════════════════════════════════════════════════════════════════════════
--  Point each pool at the place staff check in
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Adds no column, deletes nothing, and the only thing it
--  writes is pools.location_id. Run the whole file; the one table it
--  prints at the end is the report.
--
--  A BRANCH IS NOT A PLACE
--  These are two different questions and they have two different answers:
--
--    branches  — whose programme is this, whose invoices, whose students
--    locations — which water, where the geofence is, where staff punch in
--
--  They line up at seven of the eight centres, which is what made it
--  tempting to derive one from the other. They do not line up at SJKC
--  BSB: that programme runs in SBIS's pool, rented. The branch is SJKC
--  BSB because that is whose programme it is. The location is SBIS
--  because that is the water the coach is standing beside and the gate
--  they walked through to get there.
--
--  So nothing here infers a pool's location from its branch where the
--  answer is already known. The branch is used only as a first guess for
--  a pool that has no location at all, and a pool that is somewhere its
--  branch is not gets named in the list below, by hand, because no rule
--  can know it.
--
--  POOL NAMES ARE NOT EVIDENCE EITHER
--  supabase_instructor_pool_links.sql matched by name prefix: "SSGT Pool
--  A" belongs to "SSGT". That happens to get the Collab pool right, and
--  gets "Kinderlabz Pool" and "RPGM Main Pool 25m" wrong by matching
--  nothing at all. It is a rule that is right by luck where it is right,
--  so it is not used here.
--
--  AFTER THIS, DO IT IN THE APP
--  Settings → Pools & Hours → Edit has the location on it. A new pool
--  should be given one there, when it is created. This file is for the
--  nine that already exist.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 0. The column, if the earlier file was never run ───────────────────
alter table pools add column if not exists location_id uuid references locations(id);
create index if not exists pools_location_idx on pools (location_id);


-- ─── 1. Set them, and report, in one statement ──────────────────────────
-- One statement on purpose. A temporary table would depend on the whole
-- file running inside one transaction, which the SQL editor does not
-- promise, and half of this applied is worse than none of it.
--
-- The update sits in a CTE, so the report below it still sees the old
-- rows — which is what makes "moved" reportable: a pool that comes back
-- from upd is one this run changed.
with
-- Stated by hand, because the pool is not where its branch is. Each line
-- is a fact about the world that no column in this database holds.
stated (pool_name, location_name, why) as (values
  -- SJKC BSB's programme runs in SBIS's pool, rented. Staff check in at
  -- SBIS, which is where they actually are.
  ('SBIS Main Pool - Collab', 'SBIS', 'rented pool: SJKC BSB programme in SBIS water')
),
norm_b as (
  select b.id as branch_id,
         lower(regexp_replace(btrim(coalesce(b.name, '')), '\s+', ' ', 'g')) as n_name,
         lower(regexp_replace(btrim(coalesce(b.code, '')), '\s+', ' ', 'g')) as n_code
    from branches b
),
locs as (
  select l.id as location_id, l.name as location_name,
         lower(regexp_replace(btrim(coalesce(l.name, '')), '\s+', ' ', 'g')) as n_loc
    from locations l
   where l.is_active is not false
),
-- A branch matches a location when the names are the same ignoring case
-- and spacing, or when the branch's CODE is the location's name that
-- way. Nothing looser: no prefixes, no abbreviations invented here.
branch_loc as (
  select nb.branch_id,
         case when count(l.location_id) = 1 then (array_agg(l.location_id))[1] end as location_id,
         count(l.location_id)::int as n_matches
    from norm_b nb
    left join locs l on l.n_loc = nb.n_name
                     or (nb.n_code <> '' and l.n_loc = nb.n_code)
   group by nb.branch_id
),
want as (
  -- Stated wins. It is the only source here that knows about the world.
  select p.id as pool_id, l.location_id, 'stated'::text as how
    from stated s
    join pools p on lower(regexp_replace(btrim(p.name), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(s.pool_name), '\s+', ' ', 'g'))
    join locs  l on l.n_loc
                  = lower(regexp_replace(btrim(s.location_name), '\s+', ' ', 'g'))

  union all

  -- A guess, and only for a pool that has none. An existing link was put
  -- there by somebody or by the earlier file, and overwriting it from a
  -- branch is how the Collab pool would be sent to the wrong water.
  select p.id, bl.location_id, 'from branch'
    from pools p
    join branch_loc bl on bl.branch_id = p.branch_id
   where p.location_id is null
     and bl.location_id is not null
     and not exists (
       select 1 from stated s
        where lower(regexp_replace(btrim(p.name), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(s.pool_name), '\s+', ' ', 'g')))
),
upd as (
  update pools p
     set location_id = w.location_id
    from want w
   where w.pool_id = p.id
     and p.location_id is distinct from w.location_id
  returning p.id, w.location_id as new_location_id
)

-- ─── 2. The report ──────────────────────────────────────────────────────
-- One table, because the SQL editor shows only the last result. Read the
-- state column; anything starting >>> needs you.
select kind, item, branch, state from (
  select 1 as sort_a, p.name as item, 'pool' as kind,
         coalesce(br.code, br.name, '>>> NO BRANCH SET') as branch,
         case
           when eff.id is null then '>>> NO CHECK-IN LOCATION — set one in Settings → Pools'
           when u.id is not null then 'moved to ' || eff.name
           else 'checks in at ' || eff.name
         end as state
    from pools p
    left join branches  br  on br.id = p.branch_id
    left join upd       u   on u.id  = p.id
    left join locations eff on eff.id = coalesce(u.new_location_id, p.location_id)
   where p.is_active is not false

  union all

  -- A location nothing points at is a geofence with no class behind it.
  -- Not wrong on its own — staff check in at places that hold no lessons
  -- — but worth seeing beside the rest.
  select 2, l.name, 'location', '—',
         case when exists (
                select 1 from pools p2
                 where p2.is_active is not false
                   and coalesce((select u2.new_location_id from upd u2 where u2.id = p2.id),
                                p2.location_id) = l.id)
              then 'has pools'
              else 'no pools check in here' end
    from locations l
   where l.is_active is not false

  union all

  -- And a branch whose name matches nothing on the attendance side. Only
  -- a problem if one of its pools is still unlinked above; printed so
  -- the two can be read together.
  select 3, b.name, 'branch', coalesce(b.code, '—'),
         case when bl.n_matches = 1 then 'same name as a location'
              when bl.n_matches = 0 then 'no location of this name (fine if its pools are set)'
              else '>>> ' || bl.n_matches || ' LOCATIONS SHARE THIS NAME' end
    from branches b
    join branch_loc bl on bl.branch_id = b.id
   where b.is_active is not false
) r
order by sort_a, (state like '>>>%') desc, item;
