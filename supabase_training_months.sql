-- ════════════════════════════════════════════════════════════════════════
--  For a training programme, a credit is a month
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. Safe to re-run.
--
--  Run supabase_training_programmes.sql first — this reads the
--  programme_type column that file adds.
--
--  THE IDEA
--  A learn-to-swim credit is one lesson: buy six, swim six. That unit is
--  wrong for a training programme, where the fee buys the month however
--  many times the pool is open, and a missed session is simply an
--  absence. So for a training programme the unit is the month.
--
--    one month's package  = 1 credit
--    a four-month package = 4 credits
--
--  Which makes both packages the same shape — months, and a price — and
--  makes the balance mean something a person can say out loud: paid up
--  to February, or two months behind.
--
--  WHY THE MONTH IS NOT CONSUMED BY ANYTHING
--  Nothing decrements this. There is no scheduled job, no trigger, and
--  no balance row to drift. Months pass on their own, which is the whole
--  reason this unit works where the lesson did not: the calendar does
--  the consuming, and the question "how many months have they paid for
--  against how many have passed" is answerable at any moment from the
--  ledger and the date.
--
--  That is also what makes an arrear persist. Nobody has to remember to
--  carry it forward. It is March, they paid for four months from
--  November, and the subtraction says one.
--
--  WHAT THIS RETIRES
--  programme_terms held stated terms with fixed dates — "Nov 2026 to Feb
--  2027". Counting in months removes the need for it: a swimmer's term
--  is however many months they have bought, beginning when they started,
--  and two families who joined in different months are not forced into
--  one centre-wide cycle. It is dropped below. It carried no rows.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Retire the stated terms ─────────────────────────────────────────
-- Dropped rather than left to sit unused. A table nothing writes and
-- nothing reads is a thing somebody later has to work out the status of.
drop function if exists current_term(uuid, date);
drop table if exists programme_terms cascade;

-- term_months stays. It no longer draws a calendar, but it still says
-- what a full term of this programme is, which is what sizes the
-- packages offered and what the terms a parent signs refer to.
comment on column scheduler_lesson_types.term_months is
  'How many months a full term of this programme is. Packages are sold '
  'in months — one, or a whole term — and a credit is one month.';


-- ─── 2. Selling months ──────────────────────────────────────────────────
-- The office's way in. Writes the ledger and nothing else: there is no
-- balance row for a training programme, because a stored balance would
-- be a second answer to a question the ledger and the calendar already
-- answer between them.
create or replace function add_training_months(
  p_student_id    uuid,
  p_lesson_type_id uuid,
  p_months        integer,
  p_notes         text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_who text; v_child text;
begin
  if not can_write_office() then
    return jsonb_build_object('ok', false, 'error', 'Not yours to record.');
  end if;
  if not lesson_type_is_training(p_lesson_type_id) then
    return jsonb_build_object('ok', false,
      'error', 'That is a lessons programme. Its credits are lessons, not months.');
  end if;
  if p_months is null or p_months = 0 then
    return jsonb_build_object('ok', false, 'error', 'How many months?');
  end if;

  select coalesce(nullif(btrim(coalesce(
           (select e.full_name from admin_employees e
             where e.id = attendance_my_crew_id()), '')), ''), 'the office')
    into v_who;
  select name into v_child from students where id = p_student_id;

  insert into credit_purchases
    (student_id, lesson_type_id, purchase_date, credits_added, source, notes)
  values
    (p_student_id, p_lesson_type_id,
     (now() at time zone 'Asia/Kuala_Lumpur')::date,
     p_months, 'training_months',
     coalesce(nullif(btrim(coalesce(p_notes, '')), ''),
              p_months || ' month' || (case when abs(p_months) = 1 then '' else 's' end)
              || ' recorded by ' || v_who));

  return jsonb_build_object('ok', true, 'months', p_months,
    'child', coalesce(v_child, 'This swimmer'),
    'standing', (select to_jsonb(t) from training_standing(p_student_id, p_lesson_type_id) t));
end $$;


-- ─── 3. Where one swimmer stands ────────────────────────────────────────
-- Liability starts the month they began swimming, not the month they
-- first paid — somebody who swam in November and paid in January owes
-- November. Where there are no sessions at all, the first payment is the
-- only date there is, and it will do.
create or replace function training_standing(
  p_student_id uuid, p_lesson_type_id uuid)
returns table (
  student_id        uuid,
  lesson_type_id    uuid,
  started_month     date,
  months_paid       integer,
  months_elapsed    integer,
  months_outstanding integer,
  paid_through      date
)
language sql stable security definer set search_path = public as $$
  with anchor as (
    select least(
      (select min(date_trunc('month', (ws.week_start_date + (ws.weekday - 1))::date))
         from weekly_session_students wss
         join weekly_sessions ws on ws.id = wss.session_id
        where wss.student_id = p_student_id
          and ws.lesson_type_id = p_lesson_type_id),
      (select min(date_trunc('month', cp.purchase_date))
         from credit_purchases cp
        where cp.student_id = p_student_id
          and cp.lesson_type_id = p_lesson_type_id)
    )::date as m0
  ),
  paid as (
    select coalesce(sum(cp.credits_added), 0)::int as n
      from credit_purchases cp
     where cp.student_id = p_student_id
       and cp.lesson_type_id = p_lesson_type_id
  )
  select p_student_id,
         p_lesson_type_id,
         a.m0,
         p.n,
         -- Inclusive: the month they started is a month that has passed.
         (((extract(year  from date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date))
            - extract(year  from a.m0)) * 12)
          + (extract(month from date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date))
            - extract(month from a.m0)) + 1)::int,
         greatest(0,
           (((extract(year  from date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date))
              - extract(year  from a.m0)) * 12)
            + (extract(month from date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date))
              - extract(month from a.m0)) + 1) - p.n)::int,
         case when p.n > 0 then (a.m0 + make_interval(months => p.n - 1))::date end
    from anchor a, paid p
   where a.m0 is not null
     and is_website_login();
$$;

comment on function training_standing(uuid, uuid) is
  'Months bought against months passed, for one swimmer on one training '
  'programme. Nothing is stored: the calendar does the consuming.';


-- ─── 4. Who is behind ───────────────────────────────────────────────────
-- The office screen. One row per swimmer and training programme where
-- more months have passed than were paid for.
--
-- Deliberately no money. What a month costs depends on the package the
-- family took, and that is the invoice's business — a second opinion on
-- it here is how two records of one truth start to disagree.
create or replace function training_outstanding()
returns table (
  student_id        uuid,
  child             text,
  parent            text,
  parent_phone      text,
  programme         text,
  started_month     date,
  months_paid       integer,
  months_outstanding integer,
  paid_through      date
)
language sql stable security definer set search_path = public as $$
  with pairs as (
    select distinct wss.student_id, ws.lesson_type_id
      from weekly_session_students wss
      join weekly_sessions ws on ws.id = wss.session_id
     where lesson_type_is_training(ws.lesson_type_id)
    union
    select distinct cp.student_id, cp.lesson_type_id
      from credit_purchases cp
     where lesson_type_is_training(cp.lesson_type_id)
  )
  select s.id::uuid,
         s.name::text,
         coalesce(nullif(btrim(pa.display_name), ''), '—')::text,
         coalesce(parent_signin_phone(pa), '')::text,
         coalesce(lt.name, 'Training')::text,
         st.started_month::date,
         st.months_paid::int,
         st.months_outstanding::int,
         st.paid_through::date
    from pairs pr
    join students s on s.id = pr.student_id
    left join parent_accounts pa on pa.id = s.account_id
    left join scheduler_lesson_types lt on lt.id = pr.lesson_type_id
    cross join lateral training_standing(pr.student_id, pr.lesson_type_id) st
   where is_website_login()
     and s.is_active is not false
     and st.months_outstanding > 0
   order by st.months_outstanding desc, s.name;
$$;

comment on function training_outstanding() is
  'Swimmers on a training programme with more months passed than paid '
  'for. No amounts: what a month costs is the invoice''s business.';


revoke all on function add_training_months(uuid, uuid, integer, text) from public, anon;
revoke all on function training_standing(uuid, uuid)                  from public, anon;
revoke all on function training_outstanding()                         from public, anon;
grant execute on function add_training_months(uuid, uuid, integer, text) to authenticated;
grant execute on function training_standing(uuid, uuid)                  to authenticated;
grant execute on function training_outstanding()                         to authenticated;


-- ─── 5. What is there now ───────────────────────────────────────────────
select 'training programmes' as thing, count(*)::text as n
  from scheduler_lesson_types where programme_type = 'training'
union all
select 'swimmers on one',
       count(*)::text from (
         select distinct wss.student_id
           from weekly_session_students wss
           join weekly_sessions ws on ws.id = wss.session_id
          where lesson_type_is_training(ws.lesson_type_id)) z
union all
select 'months recorded against training so far',
       coalesce(sum(credits_added), 0)::text
  from credit_purchases where source = 'training_months'
union all
select 'the stated-terms table',
       case when to_regclass('public.programme_terms') is null
            then 'gone, as intended' else '>>> still there' end;
