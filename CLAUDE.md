# Working notes for this repo

## Handing Anthony code to deploy

Anthony deploys by hand: Supabase Edge Functions through the dashboard
editor, SQL through the SQL editor. Two rules, both from him:

**Always the whole file. Never a patch.** No "find this line and change
it", no "paste this block after that one". Select all, paste, deploy.
Partial edits in a web editor are how a function ends up half-deployed
with nobody sure which half.

**Always a GitHub URL. Never an attached file.** Link the file on `main`
and let him use GitHub's "Copy raw file" button. The file cards truncate
— a 310-line Edge Function came back as 150 lines and Deno rejected it
with "Unexpected eof", which reads like a syntax error and is not one.

So the shape of a hand-off is:

> Redeploy `punch`:
> https://github.com/AnthonyAngOLY/mystarswim.com/blob/main/supabase/functions/punch/index.ts

Which means the change has to be **on `main` before you link it**. Ask
to merge first, then give the link.

Where order matters between a function deploy and a SQL run, say which
goes first and what breaks if they are swapped.

## Pushing

Ask before merging to `main` — his instruction, after a stretch where
work sat on a feature branch that Netlify does not build. Netlify builds
`main`; a push to the feature branch deploys nothing.

Develop on `claude/mystarswim-onboarding-9ytsvz`.

## The admin bundle

`app.js` is JSX and is **not** what the browser loads. `app.compiled.js`
is, and it is committed. After editing `app.js`, rebuild:

```
node build.js app.js app.compiled.js
```

with Babel configured as `@babel/preset-react` `{useSpread:true}`,
`compact:false`, `comments:true`,
`generatorOpts:{jsescOption:{minimal:true}}`. Those settings reproduce
the existing file byte-for-byte; without `jsescOption.minimal` every
box-drawing comment escapes to `\uXXXX` and the diff explodes.

A clean rebuild shows only the lines you changed. If the diff is larger
than your edit, the Babel settings are wrong — fix them rather than
committing the noise.

## The SQL is run, not read

`bash tests/run.sh sql` installs every migration in `tests/sql.test.js`'s
`FILES` list against a real Postgres and then calls what it created.
**Adding a file to that list is part of writing the file.** One not in it
is one still being checked by reading.

Reading let two faults through to the live database in an afternoon, and
neither is visible on the page:

`min(pa.id)` on a uuid column. There is no `min(uuid)`, and plpgsql
resolves function names when the body *runs* — so the file installed
cleanly, the confirm block reported success, and the first parent to ask
for a code got "we could not check that just now".

`revoke all ... from public` on a gate function, which also takes it from
`service_role` — the role the Edge Functions run as. `SECURITY DEFINER`
does not cover this: it decides whose privileges the body runs *with*,
not who may call it.

Each file is probed **the moment it installs**, before any later file can
redefine what it created. The first version of this suite probed only at
the end and caught neither fault, because a later migration re-creates
`parent_signin_check` and papered over both.

Without a local Postgres the suite skips itself and says so. A machine
without one is not a broken checkout.

## One result per file

The Supabase SQL editor shows the result of the **last statement only**.
A file that ends in three `select`s reports one of them, and the other
two are simply not there — which reads as the file having done less than
it did.

So a confirm block is one statement. Stack the parts with `union all`,
or put them in a single query with a column saying which part each row
belongs to, as `supabase_migration_check.sql` does.

This has gone wrong twice: the migration check reported only its
row-security list for two runs, hiding the file list that was the whole
point, and the training opening balance reported only its closing check.
Both times the output looked like a smaller answer rather than a partial
one.

## After any file that creates a table

Row security is the only thing between the anon key — which is printed
in every page we serve — and this database. A table created without it
is readable and writable by anyone who views source. `roster_weeks` sat
like that for a week.

So: whenever a file creates a table, hand over
`supabase_rls_guard.sql` with it and say it is the second half of the
job, not optional. Its last query names anything open, anything locked
with no policy, and gives the statement to fix it.

`supabase_rls_guard.sql` also tries to install an event trigger that
locks new tables on creation. Where the project allows it that makes
forgetting impossible; where it does not, the file says so and the check
is the control.

## Database functions are a published contract

An installed PWA runs whatever build it last cached, for as long as
nobody refreshes it. `mark_attendance` went from two arguments to three
and survived only because the third had a default.

So: never remove or reorder a parameter on a function a phone calls, and
never change what it returns in a way an old build cannot read. Add, with
a default. When that is genuinely impossible, ship the new client, then
raise the floor with `require_client_build`, and say in the hand-off that
the two go in that order — raising it first locks out every phone.

`BUILD` in `attendance/app.js` and `attendance/sw.js` must match. A test
asserts it.

## Records

Void, do not delete. Attendance, leave and voucher history is the point
of the system. The one documented exception is the test-data purge
script, which says so in its own header.

## The company's own particulars

Kept here because they are asked for constantly — invoices, LHDN
e-invoicing, provider sign-ups, compliance forms — and because getting
one of them wrong is expensive. The Twilio registration failed its
automated check twice on the strength of the wrong registration number
alone.

| | |
|---|---|
| Legal name | **STAR SWIM SDN. BHD.** — with the full stops, as the certificate prints it |
| SSM registration | **202501001260** (new 12-digit format) |
| Former SSM number | 1602674-U (pre-2019 format) |
| Incorporated | 8 January 2025 |
| **Registered address** | **B-2-13, Tingkat 2, Intan Business Centre 2, Lebuh Medan Ipoh, Bandar Baru Medan, 31400 Ipoh, Perak, Malaysia** |
| Operating address | 137, Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak — where lessons and the office are, and **not on the SSM register**: the Section 14 form records Business Address as NIL |
| Director / authorised representative | **ANG KANG KEAM** (Anthony), Director |
| Other directors | Chan Cheong Pin, Clara Chung Lai Sze |
| MSIC codes | 85411 sports instruction · 82301 event management · 47631 retail of sports goods |
| TIN (LHDN) | C59796139050 |
| Employer number | E9617129307 |
| SST number | none registered |
| MSIC code | 85411 — sports and recreation education |
| Business email | starswimsb@gmail.com |
| Class enquiries | 012 253 9655 |
| Anthony | 012 524 3477 |
| Website | https://www.mystarswim.com |

**Use 202501001260 on anything official.** SSM reissued every company a
12-digit number in 2019 and the old `1602674-U` is what most registries
and verification services will fail to find. Where both are wanted the
convention is `202501001260 (1602674-U)`.

**Which address depends on who is asking.** Anything that will be checked
against a register — a provider's compliance profile, LHDN, a bank —
takes the **registered address**, because that is the only one SSM holds
and the only one an authoritative lookup can confirm. Anything a customer
reads — an invoice, the website, a receipt — takes the **operating
address**, because that is where they actually come to swim. Twilio
rejected the profile with error 18603, "the address you provided could
not be verified", on the operating address alone.

**The legal name carries full stops.** `STAR SWIM SDN. BHD.`, not
`STAR SWIM SDN BHD`. An exact-match registry lookup fails on the
difference, and did.

**An authorised representative is the name on the IC**, not the name
people use. SSM and the NRIC both read ANG KANG KEAM; a form filled in
as "Anthony Ang" cannot be reconciled with the photo ID uploaded beside
it, which is what Twilio's error 18604 is about.

The invoice and receipt layouts in `app.js` still print only the old
number, in `printInvoice`, `printInvoiceAndReceipt` and `printReceipt`.
That is worth correcting — LHDN e-invoicing works off the new one.

**Not recorded here, deliberately:** the Maybank account number. A
payment instrument does not belong in version control, and nothing in
this repository needs it. It lives wherever the finance documents live.

### Twilio

The parent app signs people in with a phone code, so an SMS provider is
a hard dependency — Supabase does not send messages itself.

| | |
|---|---|
| Trust Hub primary profile | BUa702a6d2a2bce8d60716a5e4a0eb87a9 |
| Messaging Service | "Star Swim sign-in codes" |

The account SID and auth token are **not** written down here. GitHub's
push protection rejects an `AC...` account SID outright, and it is right
to: these live in the Twilio console, which is the only place that can
be authoritative about them anyway. The profile SID is kept because it
is what a support ticket has to quote.

Malaysia is a restricted destination and the rules are not optional.
From Twilio's own Malaysia guidelines:

- Every message **must** begin `RM 0.00`. Without it the content is
  truncated or the message fails outright.
- The message **must** carry the brand name, or operators filter it.
- **URLs are blocked**, as are phone numbers in the body and requests
  for personal details. Never put `mystarswim.com/get` in an SMS.
- Alphanumeric sender IDs are **not supported**. The sender is
  overwritten with a random approved shortcode whatever you register, so
  there is no point registering a branded sender.
- Malaysian long codes are person-to-person only. A2P traffic goes over
  an **international** long code — a plain US local number is correct
  and needs no regulatory bundle.

So the sign-in template is:

```
RM 0.00 Star Swim: your sign-in code is {{ .Code }}. Valid 5 minutes. Do not share it.
```

Set the OTP expiry to **300** seconds, not the 60 Supabase defaults to.
Sixty seconds is not enough time for a parent to find a message and type
six digits.
