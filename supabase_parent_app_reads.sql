-- ════════════════════════════════════════════════════════════════════════
--  What a signed-in parent may see
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Creates no table and writes no row: it is the read
--  side of the parent app and nothing else.
--
--  EVERY ANSWER IS KEYED TO THE CALLER, NEVER TO AN ARGUMENT
--  Not one function here takes "which account" as a parameter. The
--  account is auth.uid() resolved through parent_accounts, inside a
--  definer function. A parameter is a thing a caller can change, and
--  the whole risk in this app is one family seeing another's children,
--  schedule, credits or bills.
--
--  AN INVOICE WITH NO OWNER IS INVISIBLE
--  invoices.account_id is filled by supabase_invoice_account_link.sql
--  only where the match is certain. A null is not shown to anybody.
--  That is deliberate: a bill we cannot prove belongs to this family is
--  better missing than wrong.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. Who is asking ───────────────────────────────────────────────────
-- Defined in supabase_parent_messages.sql too, replaced here so this
-- file stands on its own if run first.
create or replace function my_parent_account_id()
returns uuid language sql stable security definer set search_path = public as $$
  select pa.id from parent_accounts pa where pa.auth_user_id = auth.uid();
$$;

-- The header of the app: who they are and who is under them.
create or replace function my_family()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_acct uuid; v_out jsonb;
begin
  v_acct := my_parent_account_id();
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in.');
  end if;
  select jsonb_build_object(
    'ok', true,
    'account_id', pa.id,
    'name', coalesce(nullif(btrim(pa.display_name), ''), 'there'),
    'phone', parent_signin_phone(pa),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                        order by s.name)
        from students s
       where s.account_id = pa.id and s.is_active is not false), '[]'::jsonb),
    'unread', (select count(*) from parent_messages m
                where m.account_id = pa.id and m.read_at is null))
    into v_out
    from parent_accounts pa where pa.id = v_acct;
  return v_out;
end $$;


-- ─── 2. The schedule ────────────────────────────────────────────────────
-- Their children's classes between two dates. Capped at a term's worth:
-- a parent wants the next few weeks, and a wider range is a download of
-- the centre's timetable one family at a time.
create or replace function my_schedule(p_from date, p_to date)
returns table (
  session_id   uuid,
  student_id   uuid,
  child        text,
  class_date   date,
  start_time   time,
  end_time     time,
  lesson       text,
  pool         text,
  coach        text,
  is_cancelled boolean,
  is_replacement boolean,
  attendance   text
)
language sql stable security definer set search_path = public as $$
  select ws.id, s.id, coalesce(nullif(btrim(wss.student_name),''), s.name)::text,
         (ws.week_start_date + (ws.weekday - 1))::date,
         (ws.start_minute * interval '1 minute')::time,
         ((ws.start_minute + coalesce(ws.duration_minutes, 60)) * interval '1 minute')::time,
         coalesce(lt.name, 'Class')::text,
         coalesce(p.name, '')::text,
         coalesce((select string_agg(sc.name, ', ' order by sc.name)
                     from session_instructors si
                     join scheduler_instructors sc on sc.id = si.instructor_id
                    where si.session_id = ws.id), '')::text,
         ws.cancelled_at is not null,
         coalesce(wss.is_replacement, false),
         coalesce(wss.attendance_status, 'pending')::text
    from weekly_session_students wss
    join weekly_sessions ws on ws.id = wss.session_id
    join students s         on s.id = wss.student_id
    left join pools p       on p.id = ws.pool_id
    left join scheduler_lesson_types lt on lt.id = ws.lesson_type_id
   where s.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
     and p_from is not null and p_to is not null
     and p_to >= p_from and p_to - p_from <= 120
     and (ws.week_start_date + (ws.weekday - 1))::date between p_from and p_to
   order by 4, 5, 3;
$$;


-- ─── 3. Credits ─────────────────────────────────────────────────────────
-- One row per child per lesson type. Negative is a class already owed,
-- and it is shown rather than floored: the office can see it, so the
-- parent should not be the last to know.
create or replace function my_credits()
returns table (student_id uuid, child text, lesson text, remaining numeric)
language sql stable security definer set search_path = public as $$
  select s.id, s.name::text, coalesce(lt.name, 'Class')::text,
         coalesce(b.remaining_balance, 0)
    from students s
    join student_credit_balances b on b.student_id = s.id
    left join scheduler_lesson_types lt on lt.id = b.lesson_type_id
   where s.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
   order by s.name, 3;
$$;


-- ─── 4. Invoices and what has been paid against them ────────────────────
create or replace function my_invoices()
returns table (
  id uuid, invoice_number text, issue_date date, due_date date,
  status text, total numeric, paid numeric, outstanding numeric
)
language sql stable security definer set search_path = public as $$
  select i.id, i.invoice_number::text, i.issue_date, i.due_date,
         i.status::text,
         coalesce(i.total_amount, 0),
         coalesce(i.amount_paid, 0),
         coalesce(i.total_amount, 0) - coalesce(i.amount_paid, 0)
    from invoices i
   where i.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
     -- A draft is the office still working. It is not a bill yet.
     and coalesce(i.status, '') <> 'draft'
   order by i.issue_date desc nulls last, i.invoice_number desc;
$$;

create or replace function my_invoice_lines(p_invoice uuid)
returns table (description text, student_names text, amount numeric)
language sql stable security definer set search_path = public as $$
  select l.description::text, l.student_names::text, coalesce(l.amount, 0)
    from invoice_lines l
    join invoices i on i.id = l.invoice_id
   where l.invoice_id = p_invoice
     -- The join to invoices is the lock: a line is readable only
     -- through an invoice this account owns.
     and i.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
   order by l.sort_order, l.id;
$$;

-- Receipts. A refund is a negative payment in the same table, and it is
-- shown as one rather than hidden — a parent who was refunded should be
-- able to see that it happened.
create or replace function my_receipts()
returns table (
  id uuid, receipt_number text, payment_date date, amount numeric,
  method text, kind text, invoice_number text
)
language sql stable security definer set search_path = public as $$
  select pm.id, pm.receipt_number::text, pm.payment_date,
         coalesce(pm.amount, 0), coalesce(pm.payment_method, '')::text,
         coalesce(pm.kind, 'payment')::text, i.invoice_number::text
    from payments pm
    join invoices i on i.id = pm.invoice_id
   where i.account_id = my_parent_account_id()
     and my_parent_account_id() is not null
   order by pm.payment_date desc nulls last, pm.receipt_number desc;
$$;
