-- ============================================================================
-- Star Swim — Leave management, part 1: the schema
-- ----------------------------------------------------------------------------
-- Six kinds of leave, an allowance per person per year, and applications that
-- move pending → approved / rejected, or cancelled by the worker.
--
-- Two decisions worth stating, because the shape of the tables follows from
-- them:
--
--   Days used are never stored. They are summed from approved requests, so
--   the balance cannot drift away from the applications that produced it. A
--   counter would eventually disagree with the list underneath it, and the
--   list is the thing people argue about.
--
--   An allowance is per crew, per type, PER YEAR. Annual leave resets; last
--   year's is still an answer somebody will want. Entering a year's figures
--   does not disturb any year already recorded.
--
-- Nothing is deleted. A withdrawn application becomes 'cancelled' and stays,
-- because "I did apply" is exactly the kind of thing that gets disputed.
--
-- Additive. Safe to apply while the app is running.
-- ============================================================================

begin;

set local search_path = public, extensions;

-- ── Who may act on leave ────────────────────────────────────────────────────
-- HR Admin is a new role beside sysadmin. Deliberately separate: approving
-- leave should be delegable without handing over procurement or the scheduler.
create or replace function attendance_is_hr()
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text;
begin
  begin
    v_role := auth.jwt() -> 'app_metadata' ->> 'ssb_role';
  exception when others then
    v_role := null;
  end;
  if v_role in ('hr_admin','sysadmin') then return true; end if;
  -- An instructor flagged is_admin supervises attendance, not leave, so the
  -- crew-table route that attendance_is_admin() allows is NOT offered here.
  return false;
end $$;

-- ── 1. The kinds of leave ───────────────────────────────────────────────────
create table if not exists leave_types (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  label             text not null,
  -- The company ceiling. An individual allowance is entered per person and may
  -- sit below it; null means uncapped, which is what unpaid leave is.
  default_cap_days  numeric(5,1),
  requires_document boolean not null default false,
  is_paid           boolean not null default true,
  sort_order        integer not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

insert into leave_types (code, label, default_cap_days, requires_document, is_paid, sort_order)
values
  ('annual',          'Annual leave',      14, false, true,  1),
  ('medical',         'Medical leave',     14, true,  true,  2),
  ('hospitalization', 'Hospitalisation',   60, false, true,  3),
  ('maternity',       'Maternity leave',   98, false, true,  4),
  ('death',           'Compassionate leave (death)', 3, true, true, 5),
  ('unpaid',          'Unpaid leave',    null, false, false, 6)
on conflict (code) do nothing;

-- ── 2. What each person is given, per year ──────────────────────────────────
create table if not exists leave_entitlements (
  id            uuid primary key default gen_random_uuid(),
  crew_id       uuid not null,
  leave_type_id uuid not null references leave_types(id),
  year          integer not null,
  days_given    numeric(5,1) not null default 0,
  note          text,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  constraint leave_entitlements_days_nonneg check (days_given >= 0),
  constraint leave_entitlements_year_sane   check (year between 2020 and 2100),
  constraint leave_entitlements_unique      unique (crew_id, leave_type_id, year)
);

-- ── 3. The applications ─────────────────────────────────────────────────────
create table if not exists leave_requests (
  id            uuid primary key default gen_random_uuid(),
  crew_id       uuid not null,
  leave_type_id uuid not null references leave_types(id),
  start_date    date not null,
  end_date      date not null,
  -- Half days are not offered yet; the column takes them without a migration
  -- when they are.
  days          numeric(4,1) not null,
  reason        text,
  status        text not null default 'pending',
  -- Where the MC or certificate lives in storage. Never a public URL: the
  -- bucket is private and the file is fetched through a signed link.
  document_path text,
  applied_at    timestamptz not null default now(),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  cancelled_at  timestamptz,
  updated_at    timestamptz not null default now(),
  constraint leave_requests_status_valid check
    (status in ('pending','approved','rejected','cancelled')),
  constraint leave_requests_dates_sane check (end_date >= start_date),
  constraint leave_requests_days_positive check (days > 0)
);

create index if not exists leave_requests_crew_idx   on leave_requests (crew_id, start_date desc);
create index if not exists leave_requests_status_idx on leave_requests (status, applied_at desc);
create index if not exists leave_requests_range_idx  on leave_requests (start_date, end_date)
  where status = 'approved';
create index if not exists leave_entitlements_crew_idx on leave_entitlements (crew_id, year);

-- Link both tables to whichever worker table this project has.
do $$
declare v_tbl text;
begin
  select c.relname into v_tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('crew','admin_employees')
   order by case c.relname when 'crew' then 1 else 2 end limit 1;
  if v_tbl is null then
    raise exception 'No worker table found (looked for crew, admin_employees).';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_entitlements_crew_fkey') then
    execute format('alter table leave_entitlements add constraint leave_entitlements_crew_fkey
                    foreign key (crew_id) references public.%I(id)', v_tbl);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leave_requests_crew_fkey') then
    execute format('alter table leave_requests add constraint leave_requests_crew_fkey
                    foreign key (crew_id) references public.%I(id)', v_tbl);
  end if;
end $$;

-- ── 4. Balances, derived ────────────────────────────────────────────────────
-- Given minus used, where used is the sum of APPROVED days whose start falls
-- in that year. A request spanning New Year counts to the year it began in —
-- one rule, applied the same way every time, beats a clever one nobody can
-- reproduce by hand.
create or replace view v_leave_balances as
select e.crew_id,
       e.year,
       t.id    as leave_type_id,
       t.code,
       t.label,
       t.sort_order,
       t.requires_document,
       t.is_paid,
       e.days_given,
       coalesce((
         select sum(r.days) from leave_requests r
          where r.crew_id = e.crew_id
            and r.leave_type_id = t.id
            and r.status = 'approved'
            and extract(year from r.start_date) = e.year
       ), 0)::numeric(6,1) as days_used,
       (e.days_given - coalesce((
         select sum(r.days) from leave_requests r
          where r.crew_id = e.crew_id
            and r.leave_type_id = t.id
            and r.status = 'approved'
            and extract(year from r.start_date) = e.year
       ), 0))::numeric(6,1) as days_available
  from leave_entitlements e
  join leave_types t on t.id = e.leave_type_id;

-- ── 5. Row security ─────────────────────────────────────────────────────────
alter table leave_types        enable row level security;
alter table leave_entitlements enable row level security;
alter table leave_requests     enable row level security;

grant select on leave_types to authenticated;
grant select on leave_entitlements to authenticated;
grant select on leave_requests to authenticated;
grant select on v_leave_balances to authenticated;
revoke all on leave_types, leave_entitlements, leave_requests from anon;

-- Everyone signed in may read the catalogue; only HR writes it.
drop policy if exists leave_types_read on leave_types;
create policy leave_types_read on leave_types for select using (true);
drop policy if exists leave_types_hr_write on leave_types;
create policy leave_types_hr_write on leave_types for all
  using (attendance_is_hr()) with check (attendance_is_hr());

-- A worker sees their own allowance; HR sees everyone's and sets it.
drop policy if exists leave_ent_own_read on leave_entitlements;
create policy leave_ent_own_read on leave_entitlements for select
  using (crew_id = attendance_my_crew_id() or attendance_is_hr() or attendance_is_admin());
drop policy if exists leave_ent_hr_write on leave_entitlements;
create policy leave_ent_hr_write on leave_entitlements for all
  using (attendance_is_hr()) with check (attendance_is_hr());

-- Same for applications. Workers never write these directly — they go through
-- apply_for_leave(), which is where the rules live.
drop policy if exists leave_req_own_read on leave_requests;
create policy leave_req_own_read on leave_requests for select
  using (crew_id = attendance_my_crew_id() or attendance_is_hr() or attendance_is_admin());
drop policy if exists leave_req_hr_write on leave_requests;
create policy leave_req_hr_write on leave_requests for all
  using (attendance_is_hr()) with check (attendance_is_hr());

commit;

-- ============================================================================
-- §VERIFY
--   select code, label, default_cap_days, requires_document from leave_types
--    order by sort_order;                                      -- 6 rows
--   select count(*) from information_schema.tables
--    where table_name in ('leave_types','leave_entitlements','leave_requests');  -- 3
--
-- A document is required only where you said it was. To ask for one on
-- hospitalisation too:
--   update leave_types set requires_document = true where code = 'hospitalization';
--
-- ROLLBACK
--   drop view if exists v_leave_balances;
--   drop table if exists leave_requests;
--   drop table if exists leave_entitlements;
--   drop table if exists leave_types;
--   drop function if exists attendance_is_hr();
-- ============================================================================
