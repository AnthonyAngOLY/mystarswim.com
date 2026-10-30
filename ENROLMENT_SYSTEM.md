# From a stranger on the website to a paid, scheduled swimmer

A description of the enrolment-to-invoice loop as it is actually built at
Star Swim, written so it can be rebuilt on another platform. It describes
behaviour and reasoning, not Supabase specifics — the parts that are
Postgres-flavoured are called out where they matter.

Read the **rules that are not obvious** section before designing
anything. Most of it was learned by getting it wrong.

---

## 1. The loop in one page

```
  PUBLIC                    OFFICE                         MONEY
  ──────                    ──────                         ─────
  Intake form
      │
      │ one POST, server-side
      ▼
  parent_accounts ◄──── matched by phone, never created blind
      │
      ├── students (1..n)  ── particulars, T&C acceptance
      │
      ▼
                      assign lesson type(s)
                      assign package
                      optionally: family group
                            │
                            ▼
                      enrol into a class
                      (weekly_session_students)
                            │
                            ▼
                                                  invoice raised
                                                      │
                                                  payment recorded
                                                      │
                                                  pending_credits
                                                      │
                                                  confirmed by a person
                                                      │
                                                  credit_purchases (ledger)
                                                  student_credit_balances
                                                      │
                            ◄─────────────────────────┘
                      attendance marked
                      → one credit consumed
```

**The single most important property:** a credit does not exist until
somebody has confirmed that money arrived. Enrolment, scheduling and
billing are deliberately separate from the credit ledger.

---

## 2. The data model

Only the columns that carry meaning are listed. Everything has an `id`
and timestamps.

### parent_accounts — the payer and the login
| column | why it exists |
|---|---|
| `display_name` | who the office asks for |
| `phone_primary`, `phone_secondary` | E.164. Two numbers per family, one active |
| `active_phone` | `'primary'` \| `'secondary'` — which one receives a sign-in code |
| `email` | |
| `auth_user_id` | set on first sign-in, not before. Unique |
| `last_login_at` | |

An account is a **billing and access unit**, not a person. One account
holds one or more swimmers and answers to one phone number.

### students — a swimmer
| column | why it exists |
|---|---|
| `name`, `date_of_birth`, `age`, `gender` | |
| `account_id` → parent_accounts | who pays, and who may see them |
| `branch_id` | which centre |
| `lesson_type_ids[]` | an array: a swimmer may be in more than one programme |
| `package_id`, `package` | the current package, id and its name at the time |
| `guardian_name/email/phone/ic/tin` | denormalised on purpose — see §7 |
| `emergency_*` | |
| `tc_accepted_at`, `tc_acceptance_id` | stamped on the swimmer's own record |
| `is_active` | hidden, never deleted |

**An adult student is their own parent.** There is no separate "adult"
path: an adult registering creates a `parent_accounts` row for
themselves and one `students` row for themselves. The account is the
payer; the student is the body in the water. For a minor those are two
people, for an adult they are one, and nothing downstream has to care.

### scheduler_lesson_types — a programme
`name`, `class_type` (`group` \| `personal`), `students_per_instructor`,
`default_duration_minutes`, `billing_model`, `default_pool_id`,
`age_min_months`, `age_max_months`, `branch_id`, colours.

Lesson types are **per branch**. So are their packages.

### packages — what a parent buys
| column | meaning |
|---|---|
| `lesson_type_id` | packages hang off a lesson type, never free-floating |
| `name` | "8 classes", "Term" |
| `pax` | how many swimmers the price covers |
| `amount` | price |
| `billing_mode` | `monthly` \| `credit` |
| `billing_count` | lessons per month, or credits in the pack |
| `is_group` | a family unit: one payer covers `pax` swimmers |
| `fallback_per_pax` | price per head when the group is short of `pax` |

### family_groups — siblings billed together
`name`, `package_id`, `group_type`:
- `bound` — billed as one unit. Credits are bought and spent at group
  level; no per-swimmer adjustment.
- `discount` — billed individually at a group rate.

### invoices / invoice_lines / payments
```
invoices       invoice_number, account_id, account_name/email/phone,
               status (draft|sent|partial|paid|void|refunded),
               issue_date, due_date, total_amount, amount_paid, branch_id

invoice_lines  invoice_id, description, lesson_type_id, package_id,
               family_group_id, student_ids (csv), student_names,
               amount, quantity, line_type, is_billable

payments       invoice_id, receipt_number, amount, payment_date,
               payment_method, kind ('payment' | 'refund')
```
A refund is a **negative payment in the same table**, not a separate
concept. Receipts and refunds read from one place.

`account_id` on the invoice is what the parent app reads an invoice
through. Matching on the name or phone text is how one family sees
another family's bill — see §7.

### pending_credits — money in, credits not yet granted
`invoice_id`, `payment_id`, `student_id` **or** `family_group_id` (never
both, explicit null for the other), `lesson_type_id`, `package_id`,
`credits_per_swimmer`, `status` (`pending` \| `confirmed`).

### credit_purchases — the ledger
`student_id`, `lesson_type_id`, `purchase_date`, `credits_added`
(signed), `source`, `notes`.

`source` is the interesting column:
- `pending_credit_confirmed` — bought and paid for
- `attendance` — consumed by attending or being marked away
- `attendance_unpaid` — consumed with nothing in hand
- `subscription`, manual adjustments, etc.

### student_credit_balances — a cache of the ledger
`student_id`, `lesson_type_id`, `initial_balance`, `remaining_balance`.
Primary key is the pair.

**The ledger is the record; the balance is a cache.** Never move one
without the other. A balance that moves without a ledger row behind it
is how nobody can say why a swimmer is short a class.

---

## 3. Stage one — the intake form

A public page. No login, no account, no session.

It collects, in one submission:
- one guardian: name, phone, email, IC, TIN
- one or more children: name, date of birth, gender
- emergency contact (or "same as guardian")
- branch, referral code
- a typed signature accepting the T&Cs

### It is one server-side write, not three

The form originally did three writes with the public API key: insert
the children, upsert the acceptance, then patch the children with the
acceptance id. That meant anyone holding the key — which is printed in
every page served — could create and edit student records at will, and
it meant the students table could never be locked down without taking
enrolment down with it.

It is now **one POST to one server-side endpoint** holding the service
role. The public key has no write access to either table. Every field is
re-read and re-trimmed on the server, the acceptance timestamp is the
server's clock, and any account id the browser sends is ignored.

### How it finds the family

```
normalise the phone  →  look for an account with that number
                            (primary OR secondary)
   found    →  attach the children to it
   not found →  create one account, attach the children
   race/conflict → look again before failing
```

The form used to mint a fresh random account id for every submission, so
a parent enrolling a second child months later became a second family.
Harmless when the account only grouped rows on a screen. Not harmless
once the account decides who may see which children.

The phone normalisation must be **the same function the sign-in uses**.
If the form and the login disagree about what a number is, a parent
enrols under one account and signs in to another.

### What it does not do

It does not assign a lesson type, a package, a class or a price.
`lesson_type_ids` is written as `[]`. A stranger on the internet cannot
put themselves in a class.

---

## 4. Stage two — the office picks it up

A new intake lands as a swimmer with particulars and no programme. The
office then, in whatever order suits:

1. **Checks the account.** Right family? Right phone? Two children
   enrolled separately that should be one account?
2. **Assigns lesson types** — `students.lesson_type_ids`. More than one
   is normal: a child may be in Learn to Swim and Squad.
3. **Assigns a package** — `students.package_id`. Determines what they
   are billed and how many credits a payment buys.
4. **Optionally puts them in a family group** — siblings billed together.
5. **Enrols them into a class** — a row in `weekly_session_students`
   against a `weekly_sessions` slot.

Enrolment into a class and having credits are **independent**. A swimmer
can be scheduled before paying; that is normal and the system does not
fight it. What it does is notice at the moment of attendance.

---

## 5. Stage three — money

```
invoice raised (draft)
   │  status: draft — not a bill yet, invisible to the parent
   ▼
invoice sent
   │
   ▼
payment recorded ──► receipt number allocated
   │                 invoice status recomputed from the sum of payments:
   │                   total paid >= total  → paid
   │                   total paid >  0      → partial
   │                   otherwise            → sent
   ▼
pending_credits rows written, one per swimmer (or one per group)
   │  status: pending
   ▼
a person confirms
   │
   ▼
credit_purchases rows (+N, source 'pending_credit_confirmed')
student_credit_balances bumped
```

### Why a person confirms

Credits are not granted automatically when a payment is recorded. The
step exists because a payment and a credit grant are different
questions: *did money arrive* and *who should receive how many lessons
for it*. A family-group payment covering four siblings, a part payment,
a payment against an invoice with three lines of different lesson types
— all need a human to say which swimmers get what. Granting
automatically means unpicking it afterwards, from the ledger, in front
of a parent.

### Invoice numbering

A counter in settings, with a format (prefix, date part, padding). The
allocator **walks forward past any number already taken** before using
one, and increments the counter immediately so two people raising an
invoice at the same moment do not collide. If it skips numbers it says
so on screen.

---

## 6. Stage four — attendance spends a credit

One class, one credit. Marking a swimmer `attended` **or** `absent`
consumes one; they held the place either way. Moving between attended
and absent moves nothing, because one has already been taken. Going back
to `pending` returns it.

This rule must live in exactly one place and be called from every
screen. At Star Swim it is a database function called by both the
coach's phone and the office; it was two implementations for a while and
they drifted.

If the swimmer has no credit, the person marking is **asked first** —
not blocked, asked. The child is in the water; the question is whether
anybody tells the parent. Whether the balance may then go below zero is
a centre policy; either way the class is recorded as unpaid so it can be
chased.

---

## 7. The rules that are not obvious

Each of these was a bug first.

**An account is a key, not a label.** The moment `account_id` decides who
may see which children and which bills, every place that creates one
blind, or matches one on free text, becomes a privacy hole. Match on a
normalised phone number, refuse when two accounts answer to one number,
and leave it unmatched rather than guess.

**Invoices need a real foreign key to the payer.** Ours carried
`account_name`, `account_email`, `account_phone` as typed text, which is
fine for a human reading a screen and useless for "show this parent
their invoices". Backfill it where the match is certain — one of the
numbers on the invoice is exactly one of that account's numbers, and
exactly one account answers to it — and leave the rest null. **A null is
invisible; a wrong match is somebody else's money on screen.**

**A draft is not a bill.** Drafts must be excluded from everything a
parent sees. The office is still working on them.

**Denormalise the guardian onto the swimmer, deliberately.** We keep
`guardian_name`/`phone`/`email` on `students` as well as on the account.
It looks redundant. It is what lets the account be repaired later: when
an account is wrong or missing, the swimmer still carries who brought
them, and that is the evidence you rebuild from.

**Never delete a record that work hangs off.** Void it. Our replacement
flow deleted the swimmer's class row when they were marked for
replacement, and deleted the pending row when they were placed — so a
completed replacement left no trace that a request was ever made, and no
way to measure a notice rule against it. We had to add an events table
afterwards, and the history before that date is simply gone.

**Record the event, not just the state.** "This row is a replacement" is
a state. "This family asked for a replacement at 14:30 on the 29th,
19 hours before the class" is an event. Policies need events. If you
only ever store state, every policy you invent later is unenforceable
backwards.

**Timestamp what happened, not when you typed it.** A notice rule
measured from when the office pressed the button measures how promptly
the office does paperwork. Record when the parent told you; default it
to now, let it be corrected.

**Ledger first, cache second.** Always write the ledger row before the
balance, and let the defaulters report read the ledger. Then the report
is right whether or not the balance is allowed to go negative.

**Age ranges in months, not years.** `age_min_months` / `age_max_months`.
A four-year-old and a four-and-a-half-year-old are not the same swimmer,
and years cannot say so.

**Lesson types and packages are per branch.** If you have more than one
site, this is not optional, and retrofitting it is miserable.

---

## 8. If you are rebuilding this

Things to do from day one that we did late:

1. **One server-side endpoint for public writes.** Never let the public
   key write to a table you will later need to lock.
2. **One phone-normalising function**, called by the intake form, the
   sign-in, and every lookup.
3. **`account_id` as a real foreign key everywhere** — students,
   invoices, anything a parent will later read.
4. **An events table for anything you might make a policy about** —
   replacements, cancellations, credit grants.
5. **Void columns on everything** — `is_void`, `voided_at`, `voided_by`,
   `void_reason` — from the first migration.
6. **The credit rule in one function**, called by every screen. Not one
   per client.
7. **Settings as rows, not constants.** Every number in this document
   that looks like a business rule — notice hours, credits per class,
   whether balances may go negative — will be changed by somebody who
   cannot deploy code.

And one thing to decide early, because it is hard to change: **does
enrolling in a class require credits?** We said no, deliberately.
Scheduling and money move at different speeds, and a system that refuses
to schedule an unpaid swimmer forces the office to lie to it. Instead
it schedules freely and tells the truth at the moment of attendance.
