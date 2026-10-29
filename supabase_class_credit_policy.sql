-- ════════════════════════════════════════════════════════════════════════
--  Credits and classes: the rules, written down
-- ════════════════════════════════════════════════════════════════════════
--  Safe to re-run. Two tables created if missing, several functions
--  replaced, and one backfill that counts what already happened. Nothing
--  is deleted.
--
--  WHAT THIS IS FOR
--  Three rules the centre has been carrying in its head:
--    - whether a missed class may be replaced, and with how much notice
--    - how often a family may call it an emergency before that stops
--      being an emergency
--    - whether a swimmer may attend a class they have not paid for, and
--      what happens when they do
--
--  WHY REPLACEMENTS NEEDED A RECORD BEFORE THEY NEEDED A POLICY
--  Marking a swimmer for replacement deleted their row from the class
--  and wrote a pending row; placing them deleted the pending row too.
--  What survived was one row flagged is_replacement. Nowhere was it
--  written down that a request had been made, by whom, or when — so
--  there was nothing to measure a 24-hour rule against, and nothing to
--  count.
--
--  replacement_requests is that record. It is written when the request
--  is made and kept when the request is fulfilled, cancelled or
--  abandoned. Voided, never deleted.
--
--  THE CLOCK STARTS WHEN THE PARENT TOLD US
--  Not when the office typed it in. The form fills requested_at with
--  the current time, which is right nearly always, and the office
--  corrects it when entering yesterday's phone call. Measuring from the
--  keystroke instead would make the tracker a measure of how promptly
--  the office does its paperwork, and would mark a family who gave a
--  week's notice as an emergency because the note sat in a diary.
--
--  WHAT CANNOT BE BACKDATED
--  Notice was never recorded, so no past replacement can be sorted into
--  emergency or planned. The backfill at the end counts what is real —
--  how many replacements each swimmer has had, and how many classes
--  they have had altogether — and leaves the emergency count at zero
--  with a date from which it is being measured. A rate invented from
--  nothing would be worse than no rate, because somebody would act on
--  it.
-- ════════════════════════════════════════════════════════════════════════


-- ─── 1. The rules ───────────────────────────────────────────────────────
create table if not exists class_policy_settings (
  id boolean primary key default true check (id),

  -- ── Replacements ──
  replacements_enabled boolean not null default true,
  -- Notice at or above this is ordinary; below it is an emergency.
  replacement_notice_hours integer not null default 24
    check (replacement_notice_hours between 0 and 336),
  -- A swimmer calling it an emergency more often than this is, on the
  -- centre's own reading, not having emergencies. Recorded now and
  -- reported on; it refuses nothing until enforce_emergency_limit is on.
  emergency_rate_limit numeric not null default 0.25
    check (emergency_rate_limit > 0 and emergency_rate_limit <= 1),
  enforce_emergency_limit boolean not null default false,
  -- Below this many classes the rate means nothing: one emergency out of
  -- two lessons is 50% and tells you only that they are new.
  emergency_min_classes integer not null default 8 check (emergency_min_classes >= 0),

  -- ── Credits ──
  -- Whether a swimmer's balance may go below zero. Off does not refuse
  -- the attendance — the child was in the water — it stops the balance
  -- at nil and records the class as unpaid instead.
  allow_negative_credits boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by text
);

insert into class_policy_settings (id) values (true) on conflict (id) do nothing;

comment on table class_policy_settings is
  'One row. The centre''s rules about replacements and credits, in the '
  'one place the office can change them.';


-- ─── 2. A replacement request, as a thing that happened ─────────────────
create table if not exists replacement_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  lesson_type_id uuid,

  -- The class being missed.
  original_session_id uuid,
  original_label text,
  original_class_at timestamptz,

  -- When the parent told us. Not when this row was written.
  requested_at timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),
  recorded_by  text,

  -- Settled at the moment of writing, against the policy of that moment,
  -- so changing the rule later does not rewrite history.
  notice_hours numeric,
  is_emergency boolean not null default false,
  policy_hours integer,

  status text not null default 'pending'
         check (status in ('pending','placed','cancelled','expired')),
  placed_session_id uuid,
  placed_at timestamptz,

  is_void boolean not null default false,
  voided_at timestamptz,
  voided_by text,
  void_reason text
);

create index if not exists repl_req_student_idx
  on replacement_requests (student_id, requested_at desc) where not is_void;
create index if not exists repl_req_open_idx
  on replacement_requests (student_id, lesson_type_id)
  where status = 'pending' and not is_void;

comment on column replacement_requests.requested_at is
  'When the parent told us, which is what the notice rule measures. The '
  'form defaults it to now; the office corrects it when entering a call '
  'from yesterday.';
comment on column replacement_requests.is_emergency is
  'Settled when the row is written, against the notice rule as it stood '
  'then. Changing the rule does not re-label what already happened.';
