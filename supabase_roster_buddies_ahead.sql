-- ════════════════════════════════════════════════════════════════════════
--  Who else is at my pool — for tomorrow, and the days after it
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--  It creates no table, so supabase_rls_guard.sql is not needed with it.
--
--  WHY
--  An instructor already sees "Also scheduled here: ..." on Today. They
--  could not see it for tomorrow, which is the day it is actually worth
--  knowing: who to hand a class over to, whose lane you are sharing,
--  whether you are the only one on deck at 7am.
--
--  get_my_shift_buddies(date) already answers the question for any date
--  you pass it. Two things were missing before the phone could ask it
--  about a week.
--
--  ONE. IT WAS NOT GATED ON THE ROSTER BEING PUBLISHED.
--  supabase_roster_draft_live.sql made a draft week invisible to the
--  worker, and did it in the shifts policy. This function is security
--  definer, so it does not go through that policy: it would answer about
--  a week nobody had agreed to yet, which is the whole thing the draft
--  rule exists to prevent. Somebody reads next week off their phone on
--  Thursday, the manager moves three people on Friday, and the roster
--  was never published at all. The gate is added below, to the function
--  itself, because that is the only place it can be.
--
--  TWO. ONE DATE AT A TIME.
--  A week view asking about seven days meant seven round trips from a
--  phone on pool-deck wifi. get_my_roster_buddies(from, to) answers the
--  same question for a span, in one.
--
--  WHAT A WORKER CAN SEE, EXACTLY
--  Only people whose shift overlaps one of THEIR OWN shifts, at the same
--  location, by at least attendance_settings.buddy_overlap_min minutes,
--  on a published week. A worker with no shift that day sees nobody.
--  This is not a staff directory and it is not the roster: it answers
--  "who is on with me", and nothing wider.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Where the crew's names live ─────────────────────────────────────
-- Both buddy functions have to find the crew table and its display-name
-- column at run time: this project has shipped as `crew` and as
-- `admin_employees`, with full_name / display_name / name. That detection
-- was inline in get_my_shift_buddies. Two copies of it is two things to
-- keep in step, and the one that drifts is the one nobody is looking at,
-- so it is lifted out here and both callers use it.
create or replace function attendance_crew_source(out tbl text, out namecol text)
language plpgsql stable security definer set search_path = public as $$
begin
  select c.relname into tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end
   limit 1;
  if tbl is null then return; end if;

  select a.attname into namecol
    from pg_attribute a
   where a.attrelid = format('public.%I', tbl)::regclass
     and a.attname in ('full_name','display_name','name')
   order by case a.attname when 'full_name' then 1 when 'display_name' then 2 else 3 end
   limit 1;
end $$;

comment on function attendance_crew_source() is
  'The crew table and its display-name column, whichever this deployment '
  'has. Both buddy functions read it so the two cannot disagree.';


-- ─── 2. The span version ────────────────────────────────────────────────
-- New function, not a changed one: get_my_shift_buddies(date) is called
-- by installed phones and keeps its signature and its columns exactly.
--
-- shift_date is returned even though the caller knows the range, because
-- the caller needs to put each name under the right day and matching it
-- back through shift_id alone would mean a second lookup.
drop function if exists get_my_roster_buddies(date, date);
create function get_my_roster_buddies(p_from date, p_to date)
returns table (
  shift_id    uuid,
  shift_date  date,
  buddy_name  text,
  buddy_start time,
  buddy_end   time
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me      uuid := attendance_my_crew_id();
  v_overlap integer;
  v_src     record;
begin
  if v_me is null or p_from is null or p_to is null then return; end if;
  -- A span nobody asked for. Seven days is a week view; anything much
  -- wider is a crawl of the roster one window at a time.
  if p_to < p_from or p_to > p_from + 62 then return; end if;

  select buddy_overlap_min into v_overlap from attendance_settings;
  v_overlap := coalesce(v_overlap, 30);
  select * into v_src from attendance_crew_source();
  if v_src.tbl is null or v_src.namecol is null then return; end if;

  return query execute format($q$
    select mine.id, mine.shift_date, other_crew.%I::text,
           others.start_time, others.end_time
    from shifts mine
    join shifts others
      on  others.shift_date  = mine.shift_date
      and others.location_id = mine.location_id
      and others.crew_id    <> mine.crew_id
      and not others.is_void
      and (least(mine.end_time, others.end_time)
           - greatest(mine.start_time, others.start_time)) >= make_interval(mins => %s)
    join public.%I other_crew on other_crew.id = others.crew_id
    where mine.crew_id = %L
      and mine.shift_date between %L and %L
      and not mine.is_void
      -- The draft gate. Not inherited from the shifts policy: this
      -- function is security definer and does not pass through it.
      and roster_week_is_live(mine.shift_date)
    order by mine.shift_date, mine.start_time, others.start_time, 3
  $q$, v_src.namecol, v_overlap, v_src.tbl, v_me, p_from, p_to);
end $$;

comment on function get_my_roster_buddies(date, date) is
  'Who else is rostered at the signed-in worker''s own locations, '
  'overlapping their own shifts, across a span of dates. Published weeks '
  'only: a draft roster answers with nothing.';


-- ─── 3. The same gate on the single-date version ────────────────────────
-- Restated whole rather than patched. Its signature and its two returned
-- columns are unchanged — an installed phone on the old build calls it
-- exactly as before and reads exactly what it read before. The only
-- difference is that a draft week now answers with nothing, which is
-- what every other worker-facing read already does.
create or replace function get_my_shift_buddies(p_date date)
returns table (shift_id uuid, buddy_name text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me      uuid := attendance_my_crew_id();
  v_overlap integer;
  v_src     record;
begin
  if v_me is null then return; end if;
  if not roster_week_is_live(p_date) then return; end if;

  select buddy_overlap_min into v_overlap from attendance_settings;
  v_overlap := coalesce(v_overlap, 30);
  select * into v_src from attendance_crew_source();
  if v_src.tbl is null or v_src.namecol is null then return; end if;

  return query execute format($q$
    select mine.id, other_crew.%I::text
    from shifts mine
    join shifts others
      on  others.shift_date  = mine.shift_date
      and others.location_id = mine.location_id
      and others.crew_id    <> mine.crew_id
      and not others.is_void
      and (least(mine.end_time, others.end_time)
           - greatest(mine.start_time, others.start_time)) >= make_interval(mins => %s)
    join public.%I other_crew on other_crew.id = others.crew_id
    where mine.crew_id = %L and mine.shift_date = %L and not mine.is_void
    order by 2
  $q$, v_src.namecol, v_overlap, v_src.tbl, v_me, p_date);
end $$;


-- ─── 4. Who may ask ─────────────────────────────────────────────────────
revoke all on function attendance_crew_source()          from public;
revoke all on function get_my_roster_buddies(date, date) from public;
revoke all on function get_my_shift_buddies(date)        from public;
grant execute on function attendance_crew_source()          to authenticated;
grant execute on function get_my_roster_buddies(date, date) to authenticated;
grant execute on function get_my_shift_buddies(date)        to authenticated;


-- ─── 5. What is now true ────────────────────────────────────────────────
-- One statement, because the SQL editor shows the last one only.
select z.k as "#", z.thing, z.detail
  from (
  select 1 k, 'the span function' as thing,
         case when to_regprocedure('public.get_my_roster_buddies(date,date)') is null
              then 'MISSING — read the errors above'
              else 'get_my_roster_buddies(from, to) — installed' end as detail
  union all
  select 2, 'the single-date function, unchanged in shape',
         coalesce((select pg_get_function_result(p.oid)
                     from pg_proc p
                     where p.oid = to_regprocedure('public.get_my_shift_buddies(date)')),
                  'MISSING')
      || ' — an installed phone reads this the same as it did before'
  union all
  select 3, 'the draft gate',
         case when (select prosrc from pg_proc
                     where oid = to_regprocedure('public.get_my_shift_buddies(date)'))
                   like '%roster_week_is_live%'
              then 'on both functions — a week nobody published answers with nothing'
              else 'NOT APPLIED — look at the errors above' end
  union all
  select 4, 'overlap required',
         coalesce((select buddy_overlap_min::text from attendance_settings), '30')
      || ' minutes with one of your own shifts, at the same location'
  union all
  select 5, 'weeks published so far',
         coalesce((select count(*)::text from roster_weeks where published_at is not null), '0')
      || ' of ' || coalesce((select count(*)::text from roster_weeks), '0')
      || ' weeks that have a row at all'
  union all
  select 6, 'next',
         'Deploy the attendance app (BUILD 18). Until then nothing calls '
      || 'the new function and the Week screen looks as it did.'
  ) z
 order by z.k;
