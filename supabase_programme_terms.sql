-- ════════════════════════════════════════════════════════════════════════
--  A term, and how long one is
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run. It
--  adds two columns, one table and two functions, and changes no data.
--
--  Run supabase_training_programmes.sql first — this builds on the
--  programme_type column that file adds.
--
--  WHAT THIS IS FOR
--  Every training programme is paid for by the term. What differs is how
--  long a term is: ASC squad bills a month at a time and simply goes on,
--  the SJKC school course runs four months like a semester. Those are
--  not two billing systems. They are one, with a duration on it.
--
--    term_months = 1   the term is the calendar month. Nothing to
--                      declare: it rolls, and January is a term in the
--                      same way March is.
--    term_months > 1   the term is a stated period with a start and an
--                      end, because "the four months beginning when?"
--                      has no answer the calendar can give.
--
--  So programme_terms holds rows only for the second case. A monthly
--  programme needs none, and making somebody create twelve rows a year
--  to say "the months are the months" would be a way of losing track of
--  which month it is.
--
--  WHAT A TERM DOES NOT DO
--  It does not prorate. The fee buys the term whenever a swimmer joins
--  it — that is the policy, and the kindness of letting somebody swim a
--  fortnight for a month's fee, or waiving a class or two, stays a
--  decision the office makes on the day. It is deliberately not written
--  down as a rule here: a discretion encoded is a discretion lost, and
--  then it cannot be refused to the next family who asks.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. How long a term is, and what it costs ───────────────────────────
alter table scheduler_lesson_types
  add column if not exists term_months integer,
  add column if not exists term_fee numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lesson_types_term_months_ck') then
    alter table scheduler_lesson_types
      add constraint lesson_types_term_months_ck
      check (term_months is null or term_months between 1 and 24);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lesson_types_term_fee_ck') then
    alter table scheduler_lesson_types
      add constraint lesson_types_term_fee_ck
      check (term_fee is null or term_fee >= 0);
  end if;
end $$;

comment on column scheduler_lesson_types.term_months is
  '1 means the term is the calendar month and rolls on. More than 1 '
  'means the term is a stated period, and programme_terms says which.';
comment on column scheduler_lesson_types.term_fee is
  'What one term costs. For a monthly programme that is the month''s '
  'fee. A term in programme_terms may override it.';


-- ─── 2. The stated terms, for programmes longer than a month ────────────
create table if not exists programme_terms (
  id             uuid primary key default gen_random_uuid(),
  lesson_type_id uuid not null references scheduler_lesson_types(id) on delete cascade,
  -- What the office and the parents call it: "Nov 2026 – Feb 2027".
  label          text not null,
  starts_on      date not null,
  ends_on        date not null,
  -- Null takes the lesson type's term_fee. Set it where one term was
  -- priced differently, rather than editing the type and losing what
  -- the last term actually cost.
  fee            numeric(10,2),
  -- Voided, not deleted: a term that ran is a thing that happened, and
  -- invoices point at it.
  is_void        boolean not null default false,
  voided_at      timestamptz,
  voided_by      text,
  created_at     timestamptz not null default now(),
  created_by     text,
  constraint programme_terms_order_ck check (ends_on >= starts_on),
  constraint programme_terms_fee_ck   check (fee is null or fee >= 0)
);

create index if not exists programme_terms_type_idx
  on programme_terms (lesson_type_id, starts_on desc) where not is_void;

comment on table programme_terms is
  'One row per stated term of a programme that runs longer than a '
  'month. A monthly programme has none: its term is the calendar month.';


-- ─── 3. Two terms of one programme cannot cover the same day ────────────
-- A swimmer would be in both, and an invoice would have two terms to
-- point at. Enforced rather than asked for, because the day it goes
-- wrong is the day somebody is billed twice.
create or replace function programme_terms_no_overlap()
returns trigger
language plpgsql as $$
declare v_clash text;
begin
  if new.is_void then return new; end if;
  select t.label into v_clash
    from programme_terms t
   where t.lesson_type_id = new.lesson_type_id
     and t.id <> new.id
     and not t.is_void
     and t.starts_on <= new.ends_on
     and t.ends_on   >= new.starts_on
   limit 1;
  if v_clash is not null then
    raise exception 'Those dates overlap the term "%". A programme cannot run two terms at once.', v_clash;
  end if;
  return new;
end $$;

drop trigger if exists programme_terms_no_overlap_trg on programme_terms;
create trigger programme_terms_no_overlap_trg
  before insert or update on programme_terms
  for each row execute function programme_terms_no_overlap();


-- ─── 4. Which term is a given day in ────────────────────────────────────
-- One answer for both shapes, so nothing that calls this has to know
-- which kind of programme it is holding.
--
-- A monthly programme returns a term with no id: it is real, it has a
-- name and a start and an end, but there is no row behind it because
-- there does not need to be one.
create or replace function current_term(p_lesson_type uuid, p_on date default null)
returns table (
  term_id   uuid,
  label     text,
  starts_on date,
  ends_on   date,
  fee       numeric,
  is_stated boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_on     date;
  v_months int;
  v_fee    numeric;
  v_start  date;
begin
  v_on := coalesce(p_on, (now() at time zone 'Asia/Kuala_Lumpur')::date);

  select coalesce(lt.term_months, 1), lt.term_fee
    into v_months, v_fee
    from scheduler_lesson_types lt
   where lt.id = p_lesson_type;

  if v_months is null then return; end if;   -- no such lesson type

  if v_months > 1 then
    return query
      select t.id::uuid,
             t.label::text,
             t.starts_on::date,
             t.ends_on::date,
             coalesce(t.fee, v_fee)::numeric,
             true
        from programme_terms t
       where t.lesson_type_id = p_lesson_type
         and not t.is_void
         and v_on between t.starts_on and t.ends_on
       limit 1;
    return;
  end if;

  -- A month, named the way a person would name it.
  v_start := date_trunc('month', v_on)::date;
  return query
    select null::uuid,
           to_char(v_start, 'Mon YYYY')::text,
           v_start::date,
           (v_start + interval '1 month - 1 day')::date,
           v_fee::numeric,
           false;
end $$;

comment on function current_term(uuid, date) is
  'The term a date falls in. A monthly programme gets its calendar '
  'month with a null term_id; a longer one gets its stated term, or no '
  'row at all where none covers that date — which is the honest answer '
  'and the one worth seeing on a screen.';

revoke all on function current_term(uuid, date) from public, anon;
grant execute on function current_term(uuid, date) to authenticated;


-- ─── 5. Locks ───────────────────────────────────────────────────────────
alter table programme_terms enable row level security;
drop policy if exists programme_terms_office on programme_terms;
create policy programme_terms_office on programme_terms for all
  using (is_website_login()) with check (can_write_office());
revoke all on programme_terms from anon;


-- ─── 6. What is there now ───────────────────────────────────────────────
select 'training programmes' as thing, count(*)::text as n
  from scheduler_lesson_types where programme_type = 'training'
union all
select 'of those, billed monthly (term_months 1 or unset)',
       count(*)::text from scheduler_lesson_types
 where programme_type = 'training' and coalesce(term_months, 1) = 1
union all
select 'of those, running a stated term',
       count(*)::text from scheduler_lesson_types
 where programme_type = 'training' and coalesce(term_months, 1) > 1
union all
select 'stated terms on record', count(*)::text
  from programme_terms where not is_void
union all
select 'stated terms covering today', count(*)::text
  from programme_terms
 where not is_void
   and (now() at time zone 'Asia/Kuala_Lumpur')::date between starts_on and ends_on;
