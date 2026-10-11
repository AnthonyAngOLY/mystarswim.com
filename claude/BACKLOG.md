# Star Swim — pinned for later

Things agreed as worth doing, deliberately not built yet. Each says what
already exists, so picking one up does not start from a blank page.

---

## 1. Worker self-service: hours and records, weekly and monthly

**Asked for:** 11 Oct 2026.

The worker app's own view of their month, beside Leave. Scheduled hours,
hours actually worked, and the counts that explain the gap between them.

**Already there.** The Summary tab reads `v_attendance_monthly` and shows, by
category, per calendar month:

| | |
|---|---|
| Sessions | yes |
| Hours attended | yes |
| Late count | yes |
| Absent count | yes |

**Missing, and what each needs.**

- **Weekly, not only monthly.** `v_attendance_weekly` exists for the admin
  report; the worker app only ever queries the monthly one. Mostly a UI
  change plus a period toggle.
- **Scheduled hours beside worked hours.** The view carries
  `attended_hours`; scheduled hours is `sum(end_time - start_time)` over
  non-void sessions regardless of punches. Needs a column in both views. This
  is the number that makes the rest legible — "28 scheduled, 25.5 worked" is
  a sentence; "25.5 worked" on its own is not.
- **Early-leave count.** `shifts.early_min` is recorded and the admin report
  already counts it. Add to the views.
- **Leave taken.** Approved `leave_requests` days falling in the period, by
  type. Separate from absence: a day on approved leave is not a day missed,
  and showing them in one column would undo the distinction the leave module
  exists to draw.

**Worth deciding first:** whether a worker seeing their own lateness tally
helps them or just makes the app somewhere they avoid looking. The counts are
already visible to the admin; putting them in the worker's hand is a
different thing from recording them.

---
