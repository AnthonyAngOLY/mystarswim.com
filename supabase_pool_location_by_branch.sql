-- ════════════════════════════════════════════════════════════════════════
--  Link each pool to its attendance location through its branch
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Adds no column, deletes nothing, and the only thing it
--  writes is pools.location_id. Run the whole file; the one table it
--  prints at the end is the report.
--
--  WHY THIS REPLACES THE NAME MATCHING
--  supabase_instructor_pool_links.sql matched a pool to a location by
--  name: "SSGT Pool A" belongs to "SSGT". That worked while every pool
--  was named after the water it sits in. It stopped working the moment
--  the branches were filled in properly:
--
--    SBIS Main Pool - Collab  is at  SJKC BSB,  not SBIS
--    Kinderlabz Pool          is at  KLABZWW
--    RPGM Main Pool 25m       is at  ROYAL PERAK GOLD CLUB
--
--  The first of those is the dangerous one. Name matching does not fail
--  on it — it succeeds, at the wrong branch, and a coach rostered at
--  SBIS would be shown a class running at SJKC BSB. A wrong link is
--  worse than no link, so the name is no longer consulted at all.
--
--  Every pool already carries a branch, entered by hand in Settings →
--  Pools & Hours. That is the authority. This file reads it and sets
--  location_id from it, matching the branch to the attendance location
--  by name, and failing loudly rather than guessing.
--
--  WHAT COUNTS AS A MATCH
--  A branch matches a location when their names are the same ignoring
--  case, surrounding spaces and runs of spaces inside — or when the
--  branch's CODE is the same as the location's name that way. So branch
--  "SSGT" matches location "SSGT", and branch "PUSAT AKUATIK TUANKU
--  ZARA" with code "PATZ" matches a location called either. Nothing
--  looser: no prefixes, no "starts with", no abbreviations invented
--  here. If a branch matches two locations, it matches neither, and the
--  report says so.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 0. The column, if the earlier file was never run ───────────────────
alter table pools add column if not exists location_id uuid references locations(id);
create index if not exists pools_location_idx on pools (location_id);


-- ─── 1. Branch ↔ location, and the linking, in one statement ───────────
-- One statement on purpose. A temporary table would depend on the whole
-- file running inside one transaction, which the SQL editor does not
-- promise, and half of this applied is worse than none of it.
--
-- The update lives in a CTE, so the report below it still sees the old
-- pools rows — which is exactly what makes "moved" reportable: a pool
-- that comes back from upd is one this run changed.
with norm as (
  select b.id   as branch_id,
         b.name as branch_name,
         b.code as branch_code,
         b.is_active,
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
hits as (
  select n.branch_id, l.location_id, l.location_name
    from norm n
    join locs l on l.n_loc = n.n_name
                or (n.n_code <> '' and l.n_loc = n.n_code)
   group by n.branch_id, l.location_id, l.location_name
),
bl as (
  select n.branch_id, n.branch_name, n.branch_code, n.is_active,
         -- Exactly one match, or nothing. Two candidates is an answer
         -- nobody should be handed silently.
         case when count(h.location_id) = 1 then (array_agg(h.location_id))[1] end   as location_id,
         case when count(h.location_id) = 1 then (array_agg(h.location_name))[1] end as location_name,
         count(h.location_id)::int as n_matches
    from norm n
    left join hits h on h.branch_id = n.branch_id
   group by n.branch_id, n.branch_name, n.branch_code, n.is_active
),
-- Including pools the name matching linked earlier: where the branch is
-- certain and disagrees, the branch wins.
upd as (
  update pools p
     set location_id = bl.location_id
    from bl
   where p.branch_id = bl.branch_id
     and bl.location_id is not null
     and p.location_id is distinct from bl.location_id
  returning p.id, bl.location_id as new_location_id
)

-- ─── 2. The report ──────────────────────────────────────────────────────
-- Everything in one table, because the SQL editor shows only the last
-- result. Read the state column; anything starting >>> needs you.
select kind, item, detail, state from (
  select 1 as sort_a, bl.branch_name as item, 'branch' as kind,
         coalesce(bl.branch_code, '—') as detail,
         case
           when bl.n_matches = 1 then 'location: ' || bl.location_name
           when bl.n_matches = 0 then '>>> NO ATTENDANCE LOCATION WITH THIS NAME OR CODE'
           else '>>> ' || bl.n_matches || ' LOCATIONS MATCH — RENAME ONE'
         end as state
    from bl
   where bl.is_active is not false

  union all

  select 2, p.name, 'pool',
         coalesce(br.code, br.name, '>>> NO BRANCH SET ON THIS POOL'),
         case
           when eff.id is null then '>>> NOT LINKED — no location for its branch'
           when u.id is not null then 'moved to ' || eff.name
           else 'location: ' || eff.name
         end
    from pools p
    left join branches  br  on br.id = p.branch_id
    left join upd       u   on u.id  = p.id
    left join locations eff on eff.id = coalesce(u.new_location_id, p.location_id)
   where p.is_active is not false

  union all

  -- A location nothing points at is a geofence with no class behind it.
  -- Not always wrong — staff check in at places that hold no lessons —
  -- but worth seeing beside the rest.
  select 3, l.name, 'location', '—',
         case when exists (
                select 1 from pools p2
                 where coalesce((select u2.new_location_id from upd u2 where u2.id = p2.id),
                                p2.location_id) = l.id)
              then 'has pools'
              else 'no pools point here' end
    from locations l
   where l.is_active is not false
) r
order by sort_a, (state like '>>>%') desc, item;
