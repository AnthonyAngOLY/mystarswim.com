# From a stranger on the website to a paid, scheduled swimmer

> **Two parts.**
> **Part One** describes the Star Swim school system as it is built and
> running. It is the reference.
> **Part Two** describes the swimming club platform, which is specified
> but not built. It reuses Part One's spine and throws away its money
> model. Read Part One first; Part Two assumes it.

---

# PART ONE — the school, as built

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

---
---

# PART TWO — the club

**Status: specified, not built.** Everything below is design, and every
policy question in it has been answered by the club — §19 lists the
seven decisions and what each one costs. Where a requirement had a
decision hiding inside it, the decision is named rather than quietly
assumed, so that whoever builds this knows what was chosen on purpose.

A swimming club is not a swim school with different wording. Three
things change at the root, and almost everything else follows:

| | School (Part One) | Club (Part Two) |
|---|---|---|
| **What a parent buys** | credits — a pack of lessons | membership and a place in a squad |
| **What attendance does** | spends a credit | records whether they turned up |
| **Who a family is** | matched by phone number | identified by a membership number |

Drop the credit ledger entirely: `pending_credits`,
`credit_purchases`, `student_credit_balances`, and packages-as-credit-
packs all go. Attendance stops being a transaction and becomes a
record. That is a simplification of the money and a complication of the
attendance, which is the right trade for a club.

Make-up classes also go unless you want them. A club squad trains on
fixed nights; a missed session is a missed session. If you do want them,
lift §7's events-not-state rule and nothing else from the school's
replacement machinery — it is the part we got most wrong.

---

## 9. Identity — the membership number

### The rule, stated so it can be implemented

You asked for: a membership number if they have one, otherwise match on
Identity Card, and if not by IC then a membership number must be issued
and used thereafter.

Taken literally that is two identity keys, and two keys means they will
disagree. One parent types their IC on Tuesday and their membership
number on Friday and becomes two families. So:

> **The membership number is the account number.** One family, one
> number, and it is the primary key everything hangs off. The IC is a
> way of finding it, never a second key.

- Every account has exactly one membership number. It is issued once and
  never changes.
- The IC is stored on the account as a **lookup aid**, not as an
  identity. It answers "which membership number is this?" and nothing
  else.
- An account may exist with no IC at all — a foreign parent, a passport
  holder, somebody who declines. That must not block them.

### What enrolment asks

```
  Do you have a club membership number?
      YES → enter it → verify (see §11) → attach to that account
      NO  → Do you have a Malaysian IC?
              YES → look it up
                      found     → "You are member M-0421. Is this you?"
                      not found → issue a new number
              NO  → issue a new number
```

A found IC **never silently attaches**. It offers, and a person confirms.
An IC is typed by hand, is twelve digits, and a transposed pair lands on
a real stranger.

### Issuing a number

Same problem as invoice numbering in §5, same answer:

- Allocated server-side from a counter, in a transaction, walking past
  any number already taken.
- Never derived from anything that can change — not the branch, not the
  year, not the name. A family that moves squad keeps its number.
- Readable aloud over a bad phone line. Drop `I`, `O`, `0`, `1` from any
  alphabetic portion, or use digits only.
- Suggested shape: `M-` plus six digits, zero-padded. Enough for a
  century of a club, short enough to say.

### Storing the IC

An IC is a national identity number and should be treated as sensitive:

- **Stored once**, on the account. Do not denormalise it onto every
  swimmer the way Part One denormalises the guardian's name — that
  advice was about repairability, and it does not apply to an identity
  document.
- **Masked on screen** by default (`••••••-••-1234`), revealed on an
  explicit action by a seat that needs it.
- **Never in a URL, a log line, or an error message.**
- Indexed for lookup, but the index should be on a normalised form
  (digits only) so `850101-14-5531` and `8501011455 31` find each other.

### Two series, not one

There are two numbers and they answer different questions.

| | Scope | Answers |
|---|---|---|
| **Membership number** | the family / account | who pays, who signs in, who a child belongs to |
| **Swimmer Club ID** | one swimmer | who is this body in the water |

A swimmer gets their own Club ID at first enrolment and keeps it for
life — through squad changes, through a sibling leaving, through the
family's membership lapsing and resuming. It is what goes on a gala
entry, a lane sheet, a timing chip and a results export, and it is the
thing other systems will key on.

Both are issued the same way: server-side, from a counter, in a
transaction, walking past anything already taken. Both are immutable.

Keep the two visually distinct so nobody reads one for the other on a
form — for example `M-000421` for the family and `S-001138` for the
swimmer. Different letter, different length, no overlap.

> A swimmer's Club ID must **not** be derived from the membership
> number. `M-000421-02` looks tidy until the child's parents separate,
> or a swimmer moves to another family's membership, and the ID now
> states something untrue that is printed on three years of results.

### A family has two parents

Clubs routinely have both parents dealing with the club. Decide early:

**Decided: one account, two contacts.** The membership number belongs to
the family; both parents are contacts on it and either may sign in. It
matches how a club actually behaves, and it is what Part One's
`phone_primary` / `phone_secondary` already does.

Note the consequence for §11: **either registered mobile verifies.** A
father adding a child must not be turned away because the mother's
number is the primary one.

---

## 10. Enrolling a child

Two routes, deliberately.

### Route A — the public form, with a membership number

For a parent who is not signed in. Same shape as Part One §3: one
server-side write, nothing the public key can touch directly.

### Route B — the parent app, signed in

The better route, and the one to push people toward. A signed-in parent
presses **Add a swimmer**, fills in the child, accepts the two
agreements, done. No membership number to type, because the session
already knows who they are. No verification problem, because they
authenticated.

**This route has no identity risk at all**, which is why it should be
the one on every email, poster and reminder. Route A exists for the
parent who has not signed in yet.

---

## 11. The thing to get right: a membership number is not a password

> **If typing a membership number is enough to attach a child to that
> account, then anybody who learns a number can add a child to somebody
> else's billing — and see that family on the next screen.**

Membership numbers are printed on kit bags, read out at galas, written
on entry forms and shared between parents arranging lifts. Treat one as
public knowledge.

**Decided: membership number plus the registered mobile.** Both must
match before anything attaches. Two facts, one public and one not.

```
  membership number  M-000421
  mobile             01x-xxx xxxx

  both match one account  →  attach, and log it
  number matches, mobile does not
      →  "Those do not match our records. Call the centre."
         Do NOT say which one was wrong.
  number matches nothing  →  same sentence, same reason
```

Three details that decide whether this actually works:

- **Either registered mobile counts.** The account carries two (§9), and
  a father must not be refused because the mother's is primary.
- **Compare normalised**, through the same phone function everything
  else uses. `012-345 6789`, `0123456789` and `+60123456789` are one
  number or this fails for honest people.
- **Rate-limit by membership number.** Six attempts an hour, as the
  parent app's sign-in gate does. Without it the mobile is guessable by
  machine, and the whole check is decoration.

**Say nothing useful when it fails.** "That number is not ours" tells a
stranger which numbers are. One sentence for every failure.

**Every attachment is logged** — who, when, from which route, against
which verification. That log is the only thing that answers "how did
this child end up on our bill" six months later.

---

## 12. What is signed, and for whom

**Decided: everything is per child, at the moment that child is
enrolled.** Not per family, not per year.

A parent enrolling two children at once completes the set twice, once
for each. A parent adding a third child in March completes it once more,
for that child only — nothing already signed is touched or re-asked.

Three things are captured per swimmer:

1. **Indemnity** — the club's liability waiver
2. **Code of conduct** — behaviour, at the pool and at galas
3. **Medical declaration** — see §12b. This is the one that is not a
   signature but a set of answers, and it is the one that matters at
   6am on a cold poolside.

```
consents
  id
  account_id            the family
  student_id            the swimmer this covers
  document_type         'indemnity' | 'code_of_conduct'
  document_version      which text they actually saw
  signed_year           the calendar year they signed in
  accepted_at           server clock, never the browser's
  accepted_by_name      typed signature
  signed_via            'public_form' | 'parent_app' | 'paper'
  ip, user_agent
  is_void, voided_at, voided_by, void_reason
```

Properties that matter, all learned the hard way in Part One:

- **Version the document.** Store which version they signed, not just
  that they signed. Without it an indemnity is unenforceable the first
  time somebody edits the text.
- **Server clock only.** A browser's clock is a claim.
- **Never delete one.** Void it, with a reason.
- **`signed_year` costs nothing and buys an option.** Today nothing
  enforces an annual re-sign. If the club later decides the indemnity
  should be renewed each season, the rule becomes a query against a
  column that is already populated truthfully, rather than a migration
  with nothing to backfill from.

---

## 12b. The medical declaration

Per swimmer, and different in kind from the two signatures: it is not an
agreement, it is **information that changes and is needed in a hurry**.

```
medical_declarations
  id
  student_id
  declared_at, declared_by_name
  is_current            boolean — exactly one true per swimmer

  can_swim_unaided      boolean
  conditions            text[]   asthma, epilepsy, diabetes, …
  condition_notes       text
  allergies             text[]
  allergy_notes         text
  medication            text     what they carry, and where it is kept
  dietary               text

  doctor_name, doctor_phone
  emergency_contact_name, emergency_contact_phone, relationship

  consent_to_treat      boolean  — may we get them treated if we cannot
                                   reach you
  photo_consent         boolean  — may their picture appear in club media

  superseded_by         id of the declaration that replaced this one
  is_void, …
```

### Four things to get right

**A declaration is never edited — it is superseded.** A child develops
asthma in year two; that is a new declaration, with the old one kept and
marked superseded. The old one is what the club was working from last
season, and that matters if anything ever goes wrong.

**Exactly one is current.** Enforce it (a partial unique index on
`student_id where is_current`), do not merely intend it. Two current
declarations means a coach reads whichever the query happens to return.

**A coach must be able to see it at the poolside, and almost nobody else
should.** This is health data about a child. The shape that works:

- The coach's screen shows, against each swimmer in their own squad, a
  **medical flag** — a marker that there is something to know.
- Tapping it shows the conditions, medication, allergies, emergency
  contact and treatment consent. Nothing else about the child.
- **Every view is logged.** Not to deter the coaches, but because a log
  is the only honest answer to "who had access to this".
- The office sees it in full. Reception, finance and timetable seats do
  not.

**Photo consent is not a formality.** It has to be readable from
wherever photos get used — galas, the website, social media — or it is a
box ticked and then ignored. Surface it in any squad list a coach or a
media volunteer exports.

### Renewal

The declaration does not expire with the calendar, but stale medical
information is worse than none, because it is trusted. **Prompt the
parent to confirm or update it each year at renewal** — one screen, "is
this still right?", with a confirm that writes a new `declared_at` and
nothing else if unchanged. That is a nudge, not a gate: a swimmer is
never stopped from training over it.

## 13. Programmes and squads

Replaces Part One's lesson types and packages.

```
programmes        name, squad level, age guidance, branch/venue,
                  monthly_fee, is_active

squad_sessions    programme_id, weekday, start_time, end_time,
                  venue_id, coach_id
                  — the recurring training slots

enrolments        student_id, programme_id,
                  started_on, ended_on (null = current),
                  status
```

A swimmer's training schedule is **derived**: their enrolments give
their programmes, and each programme's `squad_sessions` give the nights
they are expected. That is the "in-built schedule" — it is not typed per
swimmer, it falls out of which squad they are in.

**`started_on` / `ended_on` are not decoration.** A swimmer who moves
from Development to Senior in March must show as expected at
Development's sessions in February and Senior's in April, or every
attendance figure before March is wrong. Close the old enrolment, open a
new one. Never edit a squad in place.

---

## 14. Billing — three fees, and the one idea that makes them work

Three charges, as you described them:

| Fee | When | Scope |
|---|---|---|
| **Registration** | once, ever | per swimmer, first time they join the club |
| **Annual membership** | once per calendar year | **per swimmer** |
| **Monthly programme** | every month enrolled | per swimmer per programme |

**Annual membership is per swimmer, not per family.** Decided. It keeps
`charges.student_id` non-null for every charge type, so one table and
one unique key covers all three fees with no special case. The cost of
the decision is a January bill that multiplies by the number of
children — a three-swimmer family pays three subscriptions at once — so
the billing tracker must show the whole of what is coming, not each
charge on its own. See §17.

### The annual fee is keyed to a year, not to a date

This is the whole trick. You said it plainly: join in November 2026 and
you pay the 2026 fee; in January 2027 you pay again. So the fee is not
"twelve months from joining" and it is not pro-rated. It is **the 2026
fee**, and either you have paid it or you have not.

Therefore do not store it as a date range and compute. Store it as a
**period-keyed charge**:

```
charges
  id
  student_id
  charge_type       'registration' | 'annual' | 'monthly'
  period_key        'once' | '2026' | '2026-11'
  amount
  status            'due' | 'invoiced' | 'paid' | 'waived' | 'void'
  invoice_id        null until invoiced
  generated_at, generated_by

  UNIQUE (student_id, charge_type, period_key) where not void
```

Every charge hangs off a swimmer, including the annual one. There is no
family-level charge and so no second shape to reason about.


That unique constraint is the entire design. With it:

- "Has this swimmer paid for 2027?" is a lookup, not arithmetic.
- The generator can run **every night, or twice in one morning**, and
  never double-bills. It inserts and lets the constraint refuse
  duplicates.
- A waiver, a scholarship or a hardship case is a status on the charge,
  not a missing row — so the report still says what *should* have been
  paid.
- Changing the price for 2027 does not touch 2026's charges, because
  the amount was written when the charge was raised.

### Generating charges

One job, idempotent, run on a schedule and runnable by hand:

```
for each active enrolment:
    if the swimmer has never had a registration charge
        → raise 'registration' / 'once'
    if no 'annual' charge for the current year
        → raise 'annual' / '2026'
    if no 'monthly' charge for the current month
        → raise 'monthly' / '2026-11'
```

Invoicing then collects **due** charges into an invoice. Keep the two
steps apart: *what is owed* and *what has been billed* are different
questions, and merging them is how a family gets two invoices for one
month.

### What this gives the parent app

A billing tracker that can honestly answer:
- what is outstanding now
- what was paid, and when
- **when the next annual renewal falls, and how much** — put this on the
  front screen in December. It is the charge that surprises people, and
  a surprise in January is a complaint in January.

### No pro-rating. Ever.

**Decided.** The annual membership is paid in full whenever a swimmer
joins. A family joining on 20 November pays the whole 2026 fee for six
weeks of it, and pays again in January. There is no half-year, no
monthly apportionment and no discretion in the generator.

That is a clean rule and worth defending as one: the fee buys
*membership of the club for the year 2026*, not a quantity of weeks.
Said that way it is obviously not divisible, and the front desk has one
sentence rather than a negotiation.

Two things follow for the build:

- **The generator takes no join date into account.** It asks only
  whether an `annual` charge exists for this swimmer and this year. One
  comparison, no arithmetic, nothing to get wrong in a leap year or
  across a timezone.
- **Say it before they pay, not after.** The enrolment form and the
  parent app should both state plainly, at the point of joining, that
  the annual fee covers the calendar year and renews in January. A
  November joiner who was told is a member; one who finds out in
  January is a complaint.

---

## 15. Attendance without credits

Nothing is spent. The question is only: were they there?

### Expected and actual are two different things

```
session_occurrences      one row per squad session per date
  programme_id, squad_session_id, held_on, start_time, end_time,
  venue_id, coach_id,
  status 'scheduled' | 'held' | 'cancelled',
  cancelled_reason

attendance
  occurrence_id, student_id,
  expected      boolean   — were they due?
  status        'present' | 'absent' | 'excused' | 'late'
  minutes_late  integer
  marked_by, marked_at, note
```

**Materialise occurrences a term ahead** rather than computing them
from a recurrence rule at read time. Two reasons, both from Part One:

- A swimmer who changes squad in March must have the *old* schedule
  before March. Materialised rows carry their own history; a rule
  recomputed from today's enrolment rewrites the past.
- Real life needs exceptions — pool closed, gala weekend, public
  holiday. An occurrence row can be cancelled with a reason. A
  recurrence rule cannot.

A cancelled occurrence is **not an absence for anybody**. That must be
true in the data, not just in the report, or the first wet weekend
destroys everybody's attendance record.

### The four states, and why `excused` is separate

- `present` — there
- `late` — there, after the start. Keep the minutes; "always ten minutes
  late" is a different conversation from "misses a session a month"
- `absent` — not there, no word
- `excused` — not there, told us. Illness, exams, family.

`excused` must be its own state and not a flavour of absent. Attendance
rate and discipline are different measures: a swimmer with 80%
attendance all excused is a different case from 80% unexplained, and a
coach needs to see which.

### Marking

Same shape as the school's coach screen and the same rules:

- The coach sees only their own squads, on the day.
- Marking is corrigible on the day by the coach; after that it is the
  office's, so a correction reaches somebody.
- A cancelled session is marked cancelled once, for everyone, not
  swimmer by swimmer.

---

## 16. What the coaches get

With `expected` and `status` on every occurrence, the analysis falls out:

| Measure | Definition |
|---|---|
| Attendance rate | `present + late` ÷ `expected`, over a window |
| Unexplained rate | `absent` ÷ `expected` — the discipline number |
| Punctuality | `late` ÷ `(present + late)`, and mean minutes late |
| Current streak | consecutive expected sessions missed |
| Trend | this month against the last three |

Two things worth building beyond a table:

- **A squad grid** — swimmers down, sessions across, a mark in each
  cell. A coach reads a term's discipline in one glance, and patterns
  (every Thursday, or since the exams started) are visible in a way no
  percentage shows.
- **A threshold flag, with a floor.** "Below 70% over the last eight
  weeks" is useful; the same rule over three weeks is noise. Borrow
  the school's own `emergency_min_classes` rule: do not judge a swimmer
  until there are enough sessions for the number to mean anything.

Tie it to selection only after a season of data. A rule enforced on two
months of a new system will be wrong about somebody, publicly.

---

## 17. The parent app

Three screens, two of them already built in Part One and reusable
almost unchanged:

- **Announcements** — lift Part One's broadcast and inbox entirely. The
  reminder machinery works the same; only the wording changes.
- **Billing** — invoices, receipts, outstanding, and the next annual
  renewal with its date and amount. Because membership is per swimmer,
  show the **family total** for the renewal as well as the per-swimmer
  figure. A parent of three who is told "RM 120 due in January" and then
  billed RM 360 will ring, and they will be right to.
- **Attendance** — per swimmer: the next session, recent marks, and a
  rate for the term. Show `excused` distinctly from `absent`, or the
  first parent who rang in sick will say the app called their child
  truant.

Plus two things that fall out of the decisions above:

- **Add a swimmer** — Route B from §10, and the thing that makes the
  membership-number problem mostly disappear. It collects the three
  per-child items from §12 and §12b for the new swimmer and touches
  nothing already signed.
- **Keep my details right** — the annual nudge to confirm or update each
  swimmer's medical declaration (§12b). One screen, "is this still
  right?", and a confirm that writes a fresh date if nothing changed.

Show the family's membership number and each swimmer's Club ID
somewhere plain. Parents are asked for them at galas and by the office,
and the alternative is a phone call to reception.

Everything in Part One about reads being keyed to the signed-in account,
with no account id ever passed as a parameter, applies here unchanged. It
is the part most worth copying verbatim.

---

## 18. What carries over, and what does not

**Lift unchanged from Part One:**
- `parent_accounts` ↔ `students`, and the adult-is-their-own-parent rule
- public writes through one server-side endpoint, never the public key
- one phone-normalising function shared by every caller
- void, never delete; `is_void` from the first migration
- events, not just state
- settings as rows, not constants
- reads keyed to the caller, never to an argument
- announcements, the inbox, and the reminder job

**Drop:**
- credits in every form, and packages as credit packs
- replacement and make-up classes, unless the club wants them

**New, with no equivalent in Part One:**
- membership numbers, swimmer Club IDs, and the issuance of both
- IC as a lookup aid, with the care §9 describes
- attaching to an existing account on number + registered mobile (§11)
- per-child medical declarations, superseded rather than edited (§12b)
- period-keyed charges and an idempotent generator
- materialised session occurrences and expected-versus-actual attendance
- squad-level analytics

---

## 19. Decisions — all settled

Every question this document raised has been answered by the club. They
are recorded here so that whoever builds it knows these were decided,
not defaulted, and knows what each one costs.

| # | Decision | What it costs you |
|---|---|---|
| 1 | **Annual membership is per swimmer.** Every charge hangs off a swimmer; no family-level charge | A January bill that multiplies by the number of children — so the parent app shows the family total, §17 |
| 2 | **Annual fee is always paid in full.** No pro-rating, no half-year | A November joiner pays twice in two months. Say so at the point of joining, §14 |
| 3 | **A returning parent attaches on membership number + registered mobile.** Both must match | One more field on the form, a rate limit, and a deliberately unhelpful failure message, §11 |
| 4 | **Everything is signed per child, at enrolment.** Indemnity, code of conduct and medical declaration, once per swimmer | Adding a third child means one more form, not a new account. Nothing already signed is re-asked, §12 |
| 5 | **One account, two contacts.** The membership number is the family's; either parent may sign in | Either registered mobile must satisfy §11's check |
| 6 | **Each swimmer also gets a Club ID**, separate from the family's membership number | Two counters, two immutable series, and the Club ID must never be derived from the membership number, §9 |
| 7 | **Non-payment never blocks training.** Chasing is a person's job | The attendance screens need to know nothing about money, which is why they stay simple |

### What follows from them, taken together

**The membership number is the account number.** One family, one number,
one row everything hangs off. The IC finds it; the mobile proves it; the
Club ID identifies a swimmer within it.

**Money and the pool never touch.** Charges are generated on a period
key and chased by a human. Attendance records who turned up. Neither
queries the other, and no screen has to decide what to do about a
swimmer who is behind. That is the single biggest simplification in this
design and it was decision 7 that bought it.

**The per-child shape repeats everywhere.** Consents, medical
declarations, Club IDs, registration fees, annual fees, monthly fees and
attendance are all per swimmer. Only the account, the membership number
and the login are per family. One sentence, and most of the schema
follows from it.

### The two things genuinely left to the builder

Not policy, so not for the club to answer — but they will bite if nobody
decides them:

- **How far ahead to materialise session occurrences** (§15). A term is
  the natural unit. Too far and every timetable change rewrites a year;
  too near and the schedule runs out over a holiday when nobody is
  looking.
- **Who may see a medical declaration** (§12b). The shape is described —
  coach sees their own squad, office sees all, everybody else sees
  nothing, every view logged — but the seats are this club's to name.
