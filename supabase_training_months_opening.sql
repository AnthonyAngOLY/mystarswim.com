-- ════════════════════════════════════════════════════════════════════════
--  Opening balance for training programmes
-- ════════════════════════════════════════════════════════════════════════
--  Run this whole file in the Supabase SQL editor. It levels the books
--  once and then refuses to do it again, whenever it is next run.
--
--  Run supabase_training_months.sql first.
--
--  THE PROBLEM THIS SOLVES
--  Fifty-one swimmers are on a training programme and not one month has
--  ever been recorded against any of them, because months only became
--  the unit this week. So the first time anybody opens Reports →
--  Training months, every one of those swimmers is behind by however
--  long they have been swimming, and the office is looking at a list of
--  arrears for families who have paid in full.
--
--  WHY IT CREDITS EVERYBODY RATHER THAN GUESSING
--  There is nothing in the database that says which of those families
--  are actually behind. Payments were taken against packages and
--  subscriptions in a unit that was not the month, and no honest
--  arithmetic turns that into "Siti has paid for three of her four
--  months". Inventing it would be worse than starting again, because
--  somebody would ring a family on the strength of it.
--
--  So every swimmer is credited with exactly the months that have passed
--  and starts level. From the next month on, the arithmetic is real:
--  months pass, months are recorded, and the difference is a debt
--  somebody can be shown.
--
--  This is the same choice the replacement tracker made about emergency
--  notice — count what is real, start the rest from the day recording
--  began, and never guess at the part that was never written down.
--
--  A PROGRAMME CLASSIFIED AS TRAINING LATER
--  Its swimmers are not levelled by running this again — nothing is.
--  Record their months individually in Reports → Training months, which
--  is the right amount of work for one programme and leaves a reason
--  against each entry.
--
--  A FAMILY WHO IS GENUINELY BEHIND
--  They are levelled too, and that is the cost of this. If the office
--  knows of a real arrear, record it afterwards as a negative in Reports
--  → Training months — a correction with a date and a reason on it,
--  which is better than a number nobody can account for.
-- ════════════════════════════════════════════════════════════════════════

with
-- Everybody on a training programme who has never had a month recorded.
--
-- The second condition is the important one, and it guards the whole
-- statement rather than each swimmer: if ANY opening row exists, this
-- does nothing at all. Guarding per swimmer looked idempotent and was
-- not — run a month later, it would find a family who joined since,
-- credit them with the month they have not paid for, and quietly erase
-- a real debt. An opening balance is a thing that happens once.
fresh as (
  select distinct wss.student_id, ws.lesson_type_id
    from weekly_session_students wss
    join weekly_sessions ws on ws.id = wss.session_id
   where lesson_type_is_training(ws.lesson_type_id)
     and not exists (
       select 1 from credit_purchases cp
        where cp.student_id = wss.student_id
          and cp.lesson_type_id = ws.lesson_type_id
          and cp.source in ('training_months','training_opening'))
     and not exists (
       select 1 from credit_purchases cp where cp.source = 'training_opening')
),
-- How many months each has been swimming, by the same reckoning
-- training_standing uses, so the two cannot disagree.
due as (
  select f.student_id, f.lesson_type_id, st.months_elapsed
    from fresh f
    cross join lateral training_standing(f.student_id, f.lesson_type_id) st
   where st.months_elapsed > 0
),
posted as (
  insert into credit_purchases
    (student_id, lesson_type_id, purchase_date, credits_added, source, notes)
  select d.student_id, d.lesson_type_id,
         (now() at time zone 'Asia/Kuala_Lumpur')::date,
         d.months_elapsed,
         'training_opening',
         'Opening balance: ' || d.months_elapsed || ' month'
           || (case when d.months_elapsed = 1 then '' else 's' end)
           || ' already swum, credited so the months count starts level.'
    from due d
  returning student_id, credits_added
)
select 'swimmers levelled' as thing, count(*)::text as n from posted
union all
select 'months credited in total', coalesce(sum(credits_added), 0)::text from posted
union all
select 'longest-standing swimmer, in months', coalesce(max(credits_added), 0)::text from posted;


-- ── And what the report says now ────────────────────────────────────────
-- Expected to be nobody, on the first run. On any later run everything
-- above reads zero and this is simply the current state of the report.
select 'still showing as behind' as thing, count(*)::text as n
  from training_outstanding();
