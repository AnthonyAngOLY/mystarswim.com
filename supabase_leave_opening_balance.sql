-- ════════════════════════════════════════════════════════════════════════
--  Leave already taken before this app existed
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It is safe to re-run.
--  Deploy the site update alongside it; this file alone adds a column
--  nothing yet writes to.
--
--  THE PROBLEM
--  Porting somebody across mid-year: 12 annual days, 5 already taken.
--  There was no way to say the second half. "Used" is counted from
--  approved applications in this system, and those five days were taken
--  before the system existed, so she showed 12 days left when she has 7.
--
--  WHY NOT JUST MAKE "USED" EDITABLE
--  Because then it drifts. The whole value of deriving it from approved
--  applications is that the figure and the list it came from cannot
--  disagree. Type over it once and nobody can ever again tell whether a
--  balance reflects the applications or somebody's correction.
--
--  WHY NOT JUST ENTER 7 AS THE ALLOWANCE
--  Because 7 is not what she is given. The record would misstate her
--  entitlement, the cap would read wrong, and next January whoever
--  copies the figures forward carries 7 into a year where she gets 12.
--
--  THE FIX
--  A separate, explicit number: days taken earlier, outside this system.
--  Entitlement stays what she is owed; applications keep driving what she
--  has spent here; the two are added for what is left.
--
--  WHAT THIS DOES NOT CHANGE
--  days_used keeps meaning "days gone this year", now counting both
--  sources, and days_available stays "what is left". So every screen
--  reading those two is still correct without being touched — only the
--  screen where you type the figure in had to learn anything.
-- ════════════════════════════════════════════════════════════════════════

alter table leave_entitlements
  add column if not exists days_taken_before numeric(5,1) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'leave_entitlements_taken_before_nonneg') then
    alter table leave_entitlements
      add constraint leave_entitlements_taken_before_nonneg
      check (days_taken_before >= 0);
  end if;
end $$;

comment on column leave_entitlements.days_taken_before is
  'Days of this leave already taken in this year before the app was '
  'tracking them — a migration figure, not an application. Counts '
  'against what is left; is not part of what they are given.';

-- ── The admin view ──────────────────────────────────────────────────────
-- The new columns are APPENDED, not slotted in where they read best:
-- create or replace view can add columns at the end and nothing else, and
-- dropping the view to reorder them would take out anything built on it
-- for the sake of column order nobody sees. days_used keeps its name and
-- its position and simply counts both sources now, which is why every
-- screen reading it stays right without being touched.
create or replace view v_leave_balances as
with taken as (
  select r.crew_id, r.leave_type_id,
         extract(year from r.start_date)::integer as year,
         sum(r.days) as days
    from leave_requests r
   where r.status = 'approved'
   group by 1, 2, 3
)
select e.crew_id,
       e.year,
       t.id    as leave_type_id,
       t.code,
       t.label,
       t.sort_order,
       t.requires_document,
       t.is_paid,
       e.days_given,
       (e.days_taken_before + coalesce(k.days, 0))::numeric(6,1) as days_used,
       (e.days_given - e.days_taken_before
                     - coalesce(k.days, 0))::numeric(6,1)        as days_available,
       -- Kept apart so the screen that edits it can show it, and so an
       -- opening figure is never mistaken for an application.
       e.days_taken_before,
       coalesce(k.days, 0)::numeric(6,1)                         as days_used_here
  from leave_entitlements e
  join leave_types t on t.id = e.leave_type_id
  left join taken k on k.crew_id = e.crew_id
                   and k.leave_type_id = e.leave_type_id
                   and k.year = e.year;

-- ── The worker's own view ───────────────────────────────────────────────
-- The return type gains columns, which create or replace cannot do.
drop function if exists get_my_leave_balances(integer);
create or replace function get_my_leave_balances(p_year integer default null)
returns table (code text, label text, requires_document boolean, is_paid boolean,
               cap_days numeric, days_given numeric, days_used numeric,
               days_available numeric, days_before numeric, sort_order integer)
language sql stable security definer set search_path = public
as $$
  with yr as (select coalesce(p_year, extract(year from current_date)::integer) as y),
       me as (select attendance_my_crew_id() as crew)
  select t.code, t.label, t.requires_document, t.is_paid,
         t.default_cap_days,
         coalesce(e.days_given, 0)::numeric as days_given,
         (coalesce(e.days_taken_before, 0) + coalesce((
           select sum(r.days) from leave_requests r
            where r.crew_id = (select crew from me)
              and r.leave_type_id = t.id
              and r.status = 'approved'
              and extract(year from r.start_date) = (select y from yr)
         ), 0))::numeric as days_used,
         (coalesce(e.days_given, 0)
          - coalesce(e.days_taken_before, 0)
          - coalesce((
           select sum(r.days) from leave_requests r
            where r.crew_id = (select crew from me)
              and r.leave_type_id = t.id
              and r.status = 'approved'
              and extract(year from r.start_date) = (select y from yr)
         ), 0))::numeric as days_available,
         -- So the app can explain a "used" figure with no applications
         -- behind it, rather than leaving a worker to wonder.
         coalesce(e.days_taken_before, 0)::numeric as days_before,
         t.sort_order
    from leave_types t
    left join leave_entitlements e
      on e.leave_type_id = t.id
     and e.crew_id = (select crew from me)
     and e.year = (select y from yr)
   where t.is_active
   order by t.sort_order;
$$;

revoke all on function get_my_leave_balances(integer) from public, anon;
grant execute on function get_my_leave_balances(integer) to authenticated;

-- ── What you should see ─────────────────────────────────────────────────
-- Nothing yet: the column starts at zero for everybody, so no balance
-- moves until somebody types an opening figure in.
select count(*) as entitlement_rows,
       count(*) filter (where days_taken_before > 0) as with_an_opening_figure
  from leave_entitlements;
