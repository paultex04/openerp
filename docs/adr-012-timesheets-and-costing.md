# ADR-012: Timesheets own hours; costing reads hours and revenue

- **Status:** accepted (revised 2026-10-16, before release — see _Revision_ below)
- **Date:** 2026-10-16
- **Supersedes:** nothing. Extends [ADR-003](adr-003-operations-engine.md)
  (planned-vs-actual labour) and [ADR-009](adr-009-job-management.md) (the
  deliverable is the commercial record), and leans on
  [ADR-001](adr-001-baseline-findings.md) for the "authoritative once written"
  rule it copies.

## Revision (2026-10-16, pre-release)

Three decisions below were changed after the first cut, on the business's
instruction, and the sections that follow already reflect the revised position:

1. **Cost is the employee's own rate.** The rate-card-first resolution was
   dropped: a person costs their `employee.rate` per hour whatever trade code the
   line carries. `employee.rate` is now required and strictly positive.
2. **Approval is capability-based.** The manager rule and the self-approval block
   were both removed: the project managers, the commercial desk and administrators
   (`timesheet.approve`) approve any week, including their own.
3. **Approved weeks can be amended two ways.** Reopening still returns a week to
   draft, and an approver can now also correct a line **in place** on an approved
   week (re-freezing just that line, with the change in the audit log).

The records of the original decisions are replaced rather than appended, because
the phase never shipped; nothing depends on the superseded behaviour.

## Context

The system could answer _what was a job worth?_: a deliverable (`job_service_code`)
carries an immutable `applied_rate` and an `actual_subtotal`, invoices follow, and
the pack proves the value. Nothing answered _what did it cost to deliver?_ There
were planned hours in the recipe (`service_code_labour_item`) and actuals recorded
against a deliverable, but no record of who actually worked, for how long, at what
cost — and therefore no margin.

Three constraints shaped the requirement:

1. The ask was a **Timesheet module**, and it had to be **separate** from Job
   Management, not another tab on the job screen.
2. Hours are **not quantities**. A fringe hour does not move an invoice, a
   deliverable or an actual; conflating the two would corrupt the commercial
   records the pack depends on.
3. It had to work out the **cost of each job against its revenue** in the
   background, without a job queue or a scheduled worker in the stack.

The obvious shortcut — let the job screen accumulate a "labour cost" column as
people enter hours — fails constraint 2 and quietly makes the job record a ledger
of guesswork. The obvious second shortcut — a nightly rollup into a cost cache —
fails constraint 3's spirit: it needs infrastructure that does not exist here, and
a stale margin is a wrong number that looks right.

## Decision

### Hours live in their own tables, keyed to the employee and the week

`timesheet` is one row per **(employee, Monday)**; `timesheet_entry` is one line of
that week — `job_id`, `labour_type`, `shift_type`, `work_date`, `hours`. The
timesheet module writes only these two tables. It never writes
`job_service_code`, never records an actual, never touches an invoice. The arrow
between the two worlds points one way, and it points _out of_ timesheets: costing
reads them.

### The week is the unit of approval, never a line

Approving hours is a statement about a person's week, not about one job's
afternoon, so the header is DRAFT → SUBMITTED → APPROVED → REJECTED and a line has
no status of its own. Approving the header freezes every line's cost in one pass.
There are exactly two ways back from an approved week, both audited:

- **Reopen.** Returns the week to DRAFT and clears every line's frozen cost, so it
  must be re-submitted and re-approved. This is the whole-week correction.
- **Amend in place.** An approver edits, adds or removes a line on an approved week
  directly; the corrected line is re-priced and re-frozen immediately and the week
  stays APPROVED. This is the single-line correction, and the frozen cost only ever
  moves because someone with `timesheet.approve` moved it.

Neither path lets a line's frozen cost drift silently: the automatic audit
extension records the before/after of every `timesheet_entry` write, and the
request actor is captured from the request context.

### Cost is the employee's own rate

A line costs `hours × employee.rate`, or a manual override typed on the line
(`cost_rate_override`, which requires `timesheet.override` and a reason). The job
amendment's rate card is **not** consulted: a person costs their own rate per hour
whatever trade code the line carries, so `/api/costing/rates` and the card's
labour-type list only survive as _suggestions_ in the line editor and as the basis
for **planned** cost — never as the cost of an actual hour. `employee.rate` is
required and strictly positive.

Approval writes the resolved `cost_rate` and `cost_amount` onto the line, plus a
small `rate_snapshot` (`{ capturedAt, source, costRate, employeeId }`) recording
where the rate came from and whose it was. This copies ADR-001: a later edit to the
employee's rate cannot rewrite yesterday's cost, so a margin reported today is
reproducible in a year. Because the snapshot is small, the audit trail — not a
frozen component vector — is what proves how a past figure was reached.

### Costing is computed on read — there is no cache

`GET /api/costing/jobs` and `/:jobId` recompute from base rows every time, in
`server/src/timesheets/costing.ts`. A job's inputs move from three modules —
`job_service_code` (revenue, planned quantity), `timesheet_entry` (approved cost),
`invoice` (billed) — so a cache would need invalidating from all three writing
paths, and the forgotten one is exactly where a margin would be silently wrong.
The computation is a handful of indexed queries over rows the request is already
loading. Rejecting the cache is the decision; "background" here means _no manual
rollup step_, not _a scheduled worker_.

### Approval is capability-based, and includes your own week

`timesheet.approve` is the whole rule: any holder — a project manager, the
commercial desk, an administrator — may approve any submitted week, including the
week they submitted themselves. The earlier per-row "the employee's manager
approves, and never the employee" rule was dropped on the business's instruction:
the three roles that sign off hours are held to a professional standard, and a
self-approval block just stalled a supervisor's week when their manager had no
account. The route demands the permission; the service re-checks it, because the
amend-in-place path is also an approver action. No non-approver can approve.

### Revenue is work done; invoiced is reported alongside

Headline revenue is `job_service_code.actual_subtotal` (work done), because margin
is a statement about delivery and should not move because billing is slow. Invoiced
non-cancelled subtotals are shown beside it so the gap is visible, not hidden.
Material cost is included (each deliverable's snapshotted BOM × actual quantity) on
its own cost line, so labour and materials can be read apart. Labour cost has two
sources that must not be mixed: **actual** from approved hours, each priced at the
employee's rate; **planned** from the recipe costed at the amendment's rate card.

## Consequences

**Better.** Labour cost is a first-class, auditable figure instead of a spreadsheet
beside the system. The separation is structural: the Timesheets section can be
reasoned about, permissioned and tested without touching the commercial pipeline,
and no timesheet code path can corrupt a deliverable or an invoice. Because each
hour is priced at the employee's own rate, the number is the obvious one a
contractor expects and needs no rate-card upkeep to be right.

**Worse.** Costing re-reads and re-derives on every request, so a large profitability
register is more DB work than a cached read would be — accepted, because it cannot
be stale. Two cost bases exist in the code (planned from the recipe, actual from
hours) and every screen has to say which one it is showing. Approved hours are
frozen to the day they are approved, so a back-dated rate correction cannot rewrite
them; it is an explicit reopen-and-re-approve or an approver's amend-in-place, both
of which are the intended friction. Because an approved week is now editable by an
approver, the permission is the control — the audit log, not immutability, is what
makes the correction traceable.

**Neutral.** `job_service_code` gains no columns; the campaign-hours variance the
job already tracked and the new labour-cost variance are different questions asked
of different data, and both are reported. Leave, training and other non-productive
hours, payroll export and time-versioned rate cards are out of scope for v1 and
listed in the phase plan.

## Verification

- `shared/src/costing.test.ts`: the rate-basis arithmetic (`entryCost`,
  `costRateForBasis`), the summary assembly and its rounding, and the planned-cost
  derivation.
- `shared/src/rbac.test.ts`: the commercial desk can approve but cannot enter time;
  a billing clerk can do neither; administrators hold the full catalogue.
- `server/src/timesheets/timesheets.integration.test.ts` (DB-backed): week
  normalisation and idempotency, `DATE_OUTSIDE_WEEK`, an hour priced at the
  employee's own rate while the job's rate card is ignored (R79/h, R632 for 8h),
  `EMPLOYEE_RATE_REQUIRED` when the employee has no rate, an unpriced line when the
  rate is cleared after the week opened, `JOB_NOT_ASSIGNED`, override allowed /
  forbidden / requiring a reason, the approval freeze, an approver amending an
  approved week in place (refused for the week's own author), self-approval allowed
  for a project manager and refused for a site supervisor, reopen unfreezing and
  re-approval re-freezing, and the costing register reflecting approved labour cost.
- Full suites green on the development database: 216 shared, 207 server; client
  production build (Turbopack) includes the `/timesheets` route.
