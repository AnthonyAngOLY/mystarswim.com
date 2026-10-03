-- ============================================================================
-- Star Swim Attendance — Phase 1 migration
-- ----------------------------------------------------------------------------
-- Creates the attendance schema: locations, shift categories, roster patterns,
-- dated shifts, punches, alerts, audit log, settings, and the Phase 5 pay
-- tables (schema-only, unused until pay is switched on).
--
-- Conventions carried over from the existing SSB build:
--   * Void-not-delete. Nothing is hard-deleted; rows carry is_void / status.
--   * Additive and reversible. Re-running this file is safe (idempotent).
--   * All schedule logic is Asia/Kuala_Lumpur (stored in attendance_settings).
--
-- EMPLOYEE TABLE: this migration does NOT assume the name. It resolves the
-- worker list at apply time, preferring public.crew and falling back to
-- public.admin_employees, and wires every crew_id FK to whichever it finds.
-- If neither exists it aborts before creating anything crew-dependent.
--
-- APPLY ORDER: run this whole file in one transaction in the SQL editor of the
-- project that holds the worker list. Verify §VERIFY at the bottom afterwards.
-- ============================================================================

begin;

-- ─── 1. Extensions ──────────────────────────────────────────────────────────
-- PostGIS gives us ST_Distance on geography (metres, accounts for curvature).
create extension if not exists postgis;

-- ─── 2. Enum-ish domains (text + CHECK, so Settings can extend without DDL) ──

-- Shift status. NOTE: a session can be BOTH late and early-leave. `status`
-- holds the headline for the board; late_min and early_min hold the facts and
-- may both be > 0 on the same row. Reports read the minutes, not the label.
--   scheduled     — not yet started / in progress, nothing wrong
--   on_time       — in <= start+grace AND out >= end-grace
--   late          — checked in after start+grace
--   early_leave   — checked out before end-grace (and was not late)
--   incomplete    — checked in, never checked out
--   absent        — session ended with no punches
--   geofence_flag — an out-of-radius attempt is attached to this shift

-- ─── 3. Settings (single row) ───────────────────────────────────────────────
create table if not exists attendance_settings (
  id                   boolean primary key default true,
  grace_min            integer not null default 5,
  checkin_window_min   integer not null default 30,   -- check-in opens N min before start
  no_checkin_alert_min integer not null default 15,   -- alert N min after start
  no_checkout_alert_min integer not null default 30,  -- alert N min after end
  default_radius_m     integer not null default 300,
  buddy_overlap_min    integer not null default 30,
  timezone             text    not null default 'Asia/Kuala_Lumpur',
  retention_days       integer not null default 1095, -- PDPA: punch geo retention (3y)
  updated_at           timestamptz not null default now(),
  constraint attendance_settings_singleton check (id)
);

insert into attendance_settings (id) values (true) on conflict (id) do nothing;

-- ─── 4. Locations ───────────────────────────────────────────────────────────
-- geog is generated from lat/lng so the two can never drift apart.
create table if not exists locations (
  id         uuid primary key default gen_random_uuid(),
  name       text    not null,
  lat        double precision not null,
  lng        double precision not null,
  geog       geography(Point, 4326)
             generated always as (
               ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
             ) stored,
  radius_m   integer not null default 300,
  is_active  boolean not null default true,
  notes      text,
  created_at timestamptz not null default now(),
  constraint locations_lat_range check (lat between -90 and 90),
  constraint locations_lng_range check (lng between -180 and 180),
  -- 300 m default; a radius wide enough to cover a worker's home defeats the
  -- point, and overlapping branch circles let one punch satisfy two locations.
  constraint locations_radius_sane check (radius_m between 25 and 2000)
);

create index if not exists locations_geog_idx on locations using gist (geog);
create index if not exists locations_active_idx on locations (is_active);

-- ─── 5. Shift categories ────────────────────────────────────────────────────
create table if not exists shift_categories (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null unique,
  color                    text,
  counts_in_total_default  boolean not null default true,
  is_active                boolean not null default true,
  sort_order               integer not null default 0
);

insert into shift_categories (name, color, counts_in_total_default, sort_order)
values
  ('Regular',   '#0ea5e9', true,  1),
  ('Part-time', '#f59e0b', false, 2)
on conflict (name) do nothing;

-- ─── 6. Core attendance tables (crew_id added in §8, once resolved) ─────────

create table if not exists shift_patterns (
  id          uuid primary key default gen_random_uuid(),
  weekday     smallint not null,                       -- 1=Mon … 7=Sun
  start_time  time not null,
  end_time    time not null,
  location_id uuid not null references locations(id),
  category_id uuid not null references shift_categories(id),
  valid_from  date not null default current_date,
  valid_to    date,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint shift_patterns_weekday_range check (weekday between 1 and 7),
  constraint shift_patterns_time_order check (end_time > start_time),
  constraint shift_patterns_date_order check (valid_to is null or valid_to >= valid_from)
);

create table if not exists shifts (
  id              uuid primary key default gen_random_uuid(),
  shift_date      date not null,
  start_time      time not null,
  end_time        time not null,
  location_id     uuid not null references locations(id),
  category_id     uuid not null references shift_categories(id),
  pattern_id      uuid references shift_patterns(id),
  status          text not null default 'scheduled',
  late_min        integer not null default 0,
  early_min       integer not null default 0,
  resolution      text,                                -- free-text resolution label
  pay_treatment   text,                                -- full | half | none  (NULL = undecided)
  is_unpaid_leave boolean not null default false,
  remark          text,
  is_void         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint shifts_time_order check (end_time > start_time),
  constraint shifts_status_valid check (status in
    ('scheduled','on_time','late','early_leave','incomplete','absent','geofence_flag')),
  constraint shifts_pay_treatment_valid check (pay_treatment is null or pay_treatment in ('full','half','none')),
  constraint shifts_minutes_nonneg check (late_min >= 0 and early_min >= 0)
);

create index if not exists shifts_date_idx on shifts (shift_date) where not is_void;
create index if not exists shifts_location_date_idx on shifts (location_id, shift_date) where not is_void;
create index if not exists shifts_status_idx on shifts (status) where not is_void;

create table if not exists punches (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references shifts(id),
  type         text not null,
  punched_at   timestamptz not null default now(),     -- SERVER clock, never device
  lat          double precision,
  lng          double precision,
  accuracy_m   double precision,
  distance_m   double precision,                        -- metres from location centre
  inside_fence boolean,
  accepted     boolean not null default true,           -- rejected attempts are kept
  source       text not null default 'worker',          -- worker | admin
  remark       text,                                    -- mandatory for source='admin'
  created_by   uuid,                                    -- auth.uid() of the actor
  created_at   timestamptz not null default now(),
  constraint punches_type_valid check (type in ('in','out')),
  constraint punches_source_valid check (source in ('worker','admin')),
  -- A manually entered punch must say why. This is the §4 SOP, enforced.
  constraint punches_admin_needs_remark
    check (source <> 'admin' or (remark is not null and length(btrim(remark)) > 0))
);

create index if not exists punches_shift_idx on punches (shift_id);
create index if not exists punches_punched_at_idx on punches (punched_at);

create table if not exists alerts (
  id                uuid primary key default gen_random_uuid(),
  shift_id          uuid not null references shifts(id),
  type              text not null,
  raised_at         timestamptz not null default now(),
  status            text not null default 'open',
  resolution_action text,
  pay_treatment     text,
  remark            text,
  resolved_by       uuid,
  resolved_at       timestamptz,
  constraint alerts_type_valid check (type in
    ('late','early_leave','no_checkin','no_checkout','absent','geofence')),
  constraint alerts_status_valid check (status in ('open','resolved')),
  constraint alerts_pay_treatment_valid check (pay_treatment is null or pay_treatment in ('full','half','none'))
);

-- One open alert per (shift, type) — the 5-minute cron re-scans the same rows.
create unique index if not exists alerts_open_unique
  on alerts (shift_id, type) where status = 'open';
create index if not exists alerts_status_idx on alerts (status, raised_at desc);

create table if not exists audit_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null,
  before_json jsonb,
  after_json  jsonb,
  actor       uuid,
  at          timestamptz not null default now()
);

create index if not exists audit_log_record_idx on audit_log (table_name, record_id, at desc);

-- ─── 7. Pay tables (Phase 5 — schema now so history is complete) ────────────
create table if not exists pay_settings (
  id              uuid primary key default gen_random_uuid(),
  category_id     uuid not null references shift_categories(id),
  counts_in_total boolean not null default true,
  rate_type       text not null,                        -- monthly | per_session
  effective_from  date not null default current_date,
  created_at      timestamptz not null default now(),
  constraint pay_settings_rate_type_valid check (rate_type in ('monthly','per_session'))
);

create table if not exists pay_rates (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references shift_categories(id),
  amount         numeric(12,2) not null,
  effective_from date not null default current_date,
  created_at     timestamptz not null default now(),
  constraint pay_rates_amount_nonneg check (amount >= 0)
);

-- ─── 8. Resolve the employee table and wire every crew_id FK ────────────────
-- Prefers public.crew; falls back to public.admin_employees. The FK column type
-- is copied from whichever PK it finds, so this works for uuid or bigint ids.
do $$
declare
  v_tbl   text;
  v_type  text;
  v_t     text;
begin
  select c.relname into v_tbl
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end
  limit 1;

  if v_tbl is null then
    raise exception
      'Attendance migration: no employee table found. Expected public.crew or public.admin_employees in this project. Are you connected to the right Supabase project?';
  end if;

  raise notice 'Attendance migration: using public.% as the worker list.', v_tbl;

  -- PK type of the employee table, used for every crew_id column.
  select format_type(a.atttypid, a.atttypmod) into v_type
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = format('public.%I', v_tbl)::regclass
    and i.indisprimary;

  if v_type is null then
    raise exception 'Attendance migration: public.% has no primary key.', v_tbl;
  end if;

  -- The RLS helpers in §9 are typed to uuid. If the worker list uses bigint
  -- ids we must regenerate them rather than silently create a type mismatch,
  -- so stop here with an actionable message instead of half-applying.
  if v_type <> 'uuid' then
    raise exception
      'Attendance migration: public.%.id is "%", but the RLS helpers assume uuid. Send the developer this PK type so the helpers can be regenerated.',
      v_tbl, v_type;
  end if;

  -- 8a. Login + role columns on the employee table (§8: add if not present).
  execute format('alter table public.%I add column if not exists auth_user_id uuid', v_tbl);
  execute format('alter table public.%I add column if not exists staff_id text', v_tbl);
  execute format('alter table public.%I add column if not exists is_admin boolean not null default false', v_tbl);
  execute format('create unique index if not exists %I on public.%I (staff_id) where staff_id is not null',
                 v_tbl || '_staff_id_key', v_tbl);
  execute format('create unique index if not exists %I on public.%I (auth_user_id) where auth_user_id is not null',
                 v_tbl || '_auth_user_id_key', v_tbl);

  -- 8b. crew_id on every attendance table that needs it.
  foreach v_t in array array['shift_patterns','shifts','punches','alerts','pay_settings','pay_rates']
  loop
    execute format('alter table public.%I add column if not exists crew_id %s', v_t, v_type);

    if not exists (
      select 1 from pg_constraint
      where conname = v_t || '_crew_id_fkey'
        and conrelid = format('public.%I', v_t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (crew_id) references public.%I(id)',
        v_t, v_t || '_crew_id_fkey', v_tbl);
    end if;

    execute format('create index if not exists %I on public.%I (crew_id)', v_t || '_crew_id_idx', v_t);
  end loop;

  -- crew_id is required on these; the tables are empty on first apply, and on a
  -- re-run any backfilled row already has one.
  foreach v_t in array array['shift_patterns','shifts','punches','alerts']
  loop
    begin
      execute format('alter table public.%I alter column crew_id set not null', v_t);
    exception when others then
      raise notice 'Could not set %.crew_id NOT NULL (existing rows without crew_id?) — leaving nullable.', v_t;
    end;
  end loop;

  -- One pay settings/rate row per worker per category, per effective date.
  execute 'create unique index if not exists pay_settings_unique on pay_settings (crew_id, category_id, effective_from)';
  execute 'create unique index if not exists pay_rates_unique on pay_rates (crew_id, category_id, effective_from)';

  -- A worker cannot be double-booked at the same moment; one shift per
  -- (crew, date, start). Parallel sessions at different times are fine.
  execute 'create unique index if not exists shifts_no_double_booking on shifts (crew_id, shift_date, start_time) where not is_void';

  -- Stash the resolved name so later sections and the app can read it back.
  execute format('comment on table public.%I is %L', v_tbl,
                 'Star Swim worker list — wired to the attendance module as crew.');
end $$;

-- ─── 9. Helper functions ────────────────────────────────────────────────────

-- The caller's crew row id, or NULL if the JWT is not a linked worker.
create or replace function attendance_my_crew_id()
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_id uuid;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return null; end if;
  execute format('select id from public.%I where auth_user_id = auth.uid() limit 1', v_tbl) into v_id;
  return v_id;
end $$;

create or replace function attendance_is_admin()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_tbl text; v_flag boolean;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then return false; end if;
  execute format('select coalesce(is_admin,false) from public.%I where auth_user_id = auth.uid() limit 1', v_tbl)
    into v_flag;
  return coalesce(v_flag, false);
end $$;

-- Pay factor from a pay_treatment. §7: full deduction = 0, half = 0.5, none = 1.
create or replace function attendance_pay_factor(p_treatment text)
returns numeric language sql immutable as $$
  select case p_treatment
           when 'full' then 0::numeric
           when 'half' then 0.5::numeric
           else 1::numeric            -- 'none' or undecided
         end;
$$;

-- A shift's start/end as real timestamptz in the configured timezone.
create or replace function attendance_shift_window(p_shift_id uuid)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable as $$
  select (s.shift_date + s.start_time) at time zone st.timezone,
         (s.shift_date + s.end_time)   at time zone st.timezone
  from shifts s cross join attendance_settings st
  where s.id = p_shift_id;
$$;

-- ─── 10. Audit triggers (void-not-delete needs a paper trail) ───────────────
create or replace function attendance_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (table_name, record_id, action, before_json, after_json, actor)
  values (
    tg_table_name,
    coalesce((to_jsonb(new)->>'id'), (to_jsonb(old)->>'id')),
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    auth.uid()
  );
  return coalesce(new, old);
end $$;

drop trigger if exists shifts_audit on shifts;
create trigger shifts_audit after insert or update or delete on shifts
  for each row execute function attendance_audit();

drop trigger if exists punches_audit on punches;
create trigger punches_audit after insert or update or delete on punches
  for each row execute function attendance_audit();

drop trigger if exists alerts_audit on alerts;
create trigger alerts_audit after insert or update or delete on alerts
  for each row execute function attendance_audit();

-- ─── 11. Buddy RPC ──────────────────────────────────────────────────────────
-- Workers cannot read each other's shifts (RLS). This SECURITY DEFINER function
-- returns ONLY the caller's own shift ids plus colleague display names for
-- overlapping sessions at the same location. No other colleague data escapes.
create or replace function get_my_shift_buddies(p_date date)
returns table (shift_id uuid, buddy_name text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me       uuid := attendance_my_crew_id();
  v_overlap  integer;
  v_tbl      text;
  v_namecol  text;
begin
  if v_me is null then return; end if;
  select buddy_overlap_min into v_overlap from attendance_settings;

  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('crew','admin_employees')
  order by case c.relname when 'crew' then 1 else 2 end limit 1;

  -- Display name column differs between the two candidate tables.
  select a.attname into v_namecol
  from pg_attribute a
  where a.attrelid = format('public.%I', v_tbl)::regclass
    and a.attname in ('full_name','display_name','name')
  order by case a.attname when 'full_name' then 1 when 'display_name' then 2 else 3 end
  limit 1;

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
  $q$, v_namecol, v_overlap, v_tbl, v_me, p_date);
end $$;

-- ─── 12. Alerts scan (called every 5 minutes by pg_cron) ────────────────────
-- Real-time alerts (late, early leave, geofence) are raised by the `punch`
-- Edge Function. This job catches the absences — the things that are defined
-- by a punch NOT happening.
create or replace function attendance_scan_alerts()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_set   attendance_settings%rowtype;
  v_count integer := 0;
  v_ins   integer := 0;
  r       record;
begin
  select * into v_set from attendance_settings;

  for r in
    select s.id, s.crew_id, s.status,
           (s.shift_date + s.start_time) at time zone v_set.timezone as starts_at,
           (s.shift_date + s.end_time)   at time zone v_set.timezone as ends_at,
           exists (select 1 from punches p where p.shift_id = s.id and p.type = 'in'  and p.accepted) as has_in,
           exists (select 1 from punches p where p.shift_id = s.id and p.type = 'out' and p.accepted) as has_out
    from shifts s
    where not s.is_void
      and s.shift_date between (now() at time zone v_set.timezone)::date - 1
                           and (now() at time zone v_set.timezone)::date
  loop
    -- Absent: session ended, nothing at all.
    if now() > r.ends_at and not r.has_in then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'absent')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
      update shifts set status = 'absent', updated_at = now()
        where id = r.id and status in ('scheduled','geofence_flag');

    -- No check-in: past the alert threshold but the session has not ended yet.
    elsif now() > r.starts_at + make_interval(mins => v_set.no_checkin_alert_min)
          and not r.has_in then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'no_checkin')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
    end if;

    -- No check-out: checked in, session over, still open.
    if r.has_in and not r.has_out
       and now() > r.ends_at + make_interval(mins => v_set.no_checkout_alert_min) then
      insert into alerts (shift_id, crew_id, type)
      values (r.id, r.crew_id, 'no_checkout')
      on conflict do nothing;
      get diagnostics v_ins = row_count;
      v_count := v_count + v_ins;
      update shifts set status = 'incomplete', updated_at = now()
        where id = r.id and status in ('scheduled','late','geofence_flag');
    end if;
  end loop;

  return v_count;
end $$;

-- Schedule it. pg_cron must be enabled for the project first
-- (Dashboard → Database → Extensions → pg_cron). Guarded so the migration
-- still applies cleanly if it is not yet on.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('attendance_scan_alerts')
      where exists (select 1 from cron.job where jobname = 'attendance_scan_alerts');
    perform cron.schedule('attendance_scan_alerts', '*/5 * * * *',
                          'select attendance_scan_alerts();');
    raise notice 'Attendance: alert scan scheduled every 5 minutes.';
  else
    raise notice 'Attendance: pg_cron not installed — enable it, then run: select cron.schedule(''attendance_scan_alerts'', ''*/5 * * * *'', ''select attendance_scan_alerts();'');';
  end if;
end $$;

-- ─── 13. Row Level Security ─────────────────────────────────────────────────
-- Workers: read their own shifts / punches / alerts, and the locations those
-- shifts point at. They may NOT insert punches directly — only the `punch`
-- Edge Function (service role) writes those, so the server clock and the
-- geofence check can never be bypassed by a crafted request.

alter table shifts           enable row level security;
alter table punches          enable row level security;
alter table alerts           enable row level security;
alter table shift_patterns   enable row level security;
alter table locations        enable row level security;
alter table shift_categories enable row level security;
alter table attendance_settings enable row level security;
alter table pay_settings     enable row level security;
alter table pay_rates        enable row level security;
alter table audit_log        enable row level security;

drop policy if exists shifts_admin_all on shifts;
create policy shifts_admin_all on shifts for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists shifts_worker_read on shifts;
create policy shifts_worker_read on shifts for select
  using (crew_id = attendance_my_crew_id() and not is_void);

drop policy if exists punches_admin_all on punches;
create policy punches_admin_all on punches for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists punches_worker_read on punches;
create policy punches_worker_read on punches for select
  using (crew_id = attendance_my_crew_id());
-- Deliberately NO worker INSERT/UPDATE policy on punches.

drop policy if exists alerts_admin_all on alerts;
create policy alerts_admin_all on alerts for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists alerts_worker_read on alerts;
create policy alerts_worker_read on alerts for select
  using (crew_id = attendance_my_crew_id());

drop policy if exists patterns_admin_all on shift_patterns;
create policy patterns_admin_all on shift_patterns for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists patterns_worker_read on shift_patterns;
create policy patterns_worker_read on shift_patterns for select
  using (crew_id = attendance_my_crew_id());

-- Locations: admins manage; a worker sees only the ones they are rostered to.
drop policy if exists locations_admin_all on locations;
create policy locations_admin_all on locations for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists locations_worker_read on locations;
create policy locations_worker_read on locations for select
  using (exists (
    select 1 from shifts s
    where s.location_id = locations.id
      and s.crew_id = attendance_my_crew_id()
      and not s.is_void
  ));

-- Categories and settings are not sensitive; any signed-in worker may read.
drop policy if exists categories_read on shift_categories;
create policy categories_read on shift_categories for select
  using (auth.uid() is not null);
drop policy if exists categories_admin_write on shift_categories;
create policy categories_admin_write on shift_categories for all
  using (attendance_is_admin()) with check (attendance_is_admin());

drop policy if exists settings_read on attendance_settings;
create policy settings_read on attendance_settings for select
  using (auth.uid() is not null);
drop policy if exists settings_admin_write on attendance_settings;
create policy settings_admin_write on attendance_settings for all
  using (attendance_is_admin()) with check (attendance_is_admin());

-- Pay and audit: admin only, no worker visibility at all.
drop policy if exists pay_settings_admin on pay_settings;
create policy pay_settings_admin on pay_settings for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists pay_rates_admin on pay_rates;
create policy pay_rates_admin on pay_rates for all
  using (attendance_is_admin()) with check (attendance_is_admin());
drop policy if exists audit_log_admin on audit_log;
create policy audit_log_admin on audit_log for select
  using (attendance_is_admin());

-- Table-level grants. Supabase normally hands these to anon/authenticated via
-- default privileges, but we state them explicitly so the module does not
-- depend on that: a project with altered defaults would otherwise fail with
-- "permission denied", which reads like an RLS bug and is not one.
-- RLS above is what actually constrains the rows; these only open the door.
grant usage on schema public to authenticated;
grant select on shifts, punches, alerts, shift_patterns, locations,
                shift_categories, attendance_settings to authenticated;
grant insert, update, delete on shifts, punches, alerts, shift_patterns,
                locations, shift_categories to authenticated;
grant update on attendance_settings to authenticated;
grant select, insert, update, delete on pay_settings, pay_rates to authenticated;
grant select on audit_log to authenticated;
-- (view grants live in §14, after the views are created)
-- anon gets nothing: the attendance module has no public surface at all.
revoke all on shifts, punches, alerts, shift_patterns, locations,
              shift_categories, attendance_settings, pay_settings, pay_rates,
              audit_log from anon;

-- The buddy RPC is the only way a worker learns a colleague's name.
revoke all on function get_my_shift_buddies(date) from public;
grant execute on function get_my_shift_buddies(date) to authenticated;
grant execute on function attendance_my_crew_id() to authenticated;
grant execute on function attendance_is_admin() to authenticated;

-- ─── 14. Report views ───────────────────────────────────────────────────────
-- Base view: one row per shift with the derived facts reports aggregate.
create or replace view v_attendance_shift_facts as
select
  s.id                as shift_id,
  s.crew_id,
  s.shift_date,
  s.location_id,
  l.name              as location_name,
  s.category_id,
  c.name              as category_name,
  c.counts_in_total_default,
  s.status,
  s.late_min,
  s.early_min,
  s.is_unpaid_leave,
  s.pay_treatment,
  attendance_pay_factor(s.pay_treatment) as pay_factor,
  extract(epoch from (s.end_time - s.start_time)) / 3600.0 as scheduled_hours,
  case when s.status = 'absent' then 0
       else extract(epoch from (s.end_time - s.start_time)) / 3600.0
  end                 as attended_hours
from shifts s
join locations l        on l.id = s.location_id
join shift_categories c on c.id = s.category_id
where not s.is_void;

create or replace view v_attendance_monthly as
select
  crew_id,
  date_trunc('month', shift_date)::date as period,
  category_name,
  count(*)                                            as sessions,
  sum(scheduled_hours)                                as scheduled_hours,
  sum(attended_hours)                                 as attended_hours,
  count(*) filter (where status = 'late')             as late_count,
  sum(late_min)                                       as late_minutes,
  count(*) filter (where early_min > 0)               as early_count,
  sum(early_min)                                      as early_minutes,
  count(*) filter (where status = 'absent')           as absent_count,
  count(*) filter (where is_unpaid_leave)             as unpaid_leave_count,
  round(100.0 * count(*) filter (where status = 'on_time')
        / nullif(count(*), 0), 1)                     as punctuality_pct
from v_attendance_shift_facts
group by 1, 2, 3;

-- Views inherit the RLS of their base tables (they are not SECURITY DEFINER),
-- so a worker reading these sees only their own shifts.
grant select on v_attendance_shift_facts, v_attendance_monthly to authenticated;
revoke all on v_attendance_shift_facts, v_attendance_monthly from anon;

commit;

-- ============================================================================
-- §VERIFY — run these after applying.
-- ============================================================================
-- 1. Which employee table did it wire to?
--    select table_name, column_name from information_schema.columns
--    where column_name = 'auth_user_id' and table_schema = 'public';
--
-- 2. Tables exist and are locked down:
--    select tablename, rowsecurity from pg_tables
--    where schemaname='public'
--      and tablename in ('shifts','punches','alerts','locations');
--    -- rowsecurity must be true for all four.
--
-- 3. Settings row seeded:  select * from attendance_settings;
-- 4. Categories seeded:    select name, sort_order from shift_categories order by sort_order;
-- 5. Alert job scheduled:  select jobname, schedule from cron.job;
--
-- ROLLBACK (if needed, in this order):
--   select cron.unschedule('attendance_scan_alerts');
--   drop view if exists v_attendance_monthly, v_attendance_shift_facts;
--   drop table if exists audit_log, alerts, punches, shifts, shift_patterns,
--                        pay_rates, pay_settings, shift_categories,
--                        locations, attendance_settings cascade;
--   -- The columns added to the employee table (auth_user_id, staff_id,
--   -- is_admin) are additive and safe to leave in place.
-- ============================================================================
