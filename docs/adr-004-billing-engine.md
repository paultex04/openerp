# ADR-004: Billing Engine (Phase 4)

## Context

Phase 4 turns measured job actuals into invoices and takes those invoices through
financial control. The acceptance criteria are that every figure is derived rather
than supplied, that VAT treatment is correct, and that the document lifecycle is
as unskippable as the job lifecycle was in Phase 3.

## Decisions

### D1 — Every financial figure is derived; the caller supplies no money

`generateDraft` accepts at most a line subset, a due date and a note. Quantities
come from `job_service_code.actual_quantity`, unit prices from the `applied_rate`
snapshot, VAT from the contract amendment, and every total from the shared
`computeVat`. The edit endpoint accepts `notes` and `dueDate` only — no total is
editable on any status.

Correcting a figure therefore means the underlying actual was wrong, and that
correction belongs in the field view, after which the draft can be deleted and
regenerated. Letting totals be edited in place would let an invoice fork from the
actuals it claims to bill, and the fork would be invisible.

As a belt-and-braces check, generation compares its own per-line subtotals against
the VAT engine's and refuses to persist on any divergence (`500 TOTALS_DIVERGED`).

### D2 — Generation is gated on billing owning the job

Invoices may only be raised from `07. Pack Ready` onward (plus `08`, `09`, `10`,
`11`). Before that the job belongs to planning or execution, and recognising
revenue against unscored or unexecuted work would be wrong regardless of who asked.
Refusal is `409 JOB_NOT_BILLABLE` naming the last editable stage.

### D3 — Only Draft / Submitted / Approved / Partially Paid / Disputed are "open"

Generation is refused while a job holds an invoice in an open state, because two
concurrent documents billing the same actuals double-bill.

`Partially Paid` was initially excluded from that set. The Phase 4 smoke test
caught it: a progress invoice was raised on top of a part-settled one and the same
lines were billed twice. Money received against an invoice does not make the
outstanding balance go away, so a part-settled document is still a live claim. Only
`Paid` and `Cancelled` are closed. This is the kind of defect the unit suite missed
because it only exercised the Draft-blocks case.

### D4 — Approving an invoice settles the job, derived from money

`Submitted → Approved` requires `invoice.approve` and then compares recognised
billed totals (Approved or better) against the job's actual total. At or above it
marks the job `10. Invoiced`; below it marks `11. Partially Invoiced`. Partial
invoicing therefore falls out of billing a subset of lines — there is no separate
flag, so no flag can disagree with the money.

A consequence worth stating: **voiding an approved invoice does not rewind the
job.** The document is corrected; the fact that the work happened and was invoiced
does not become untrue. Rewinding would need a `10 → 07` edge the state machine
deliberately has no way to authorise.

### D5 — Cancellation always needs `invoice.status`, even for a draft

A draft can still be edited or deleted by its author, but cancellation is a status
event with downstream meaning: it closes the document and releases the
double-billing guard. Keeping every cancellation behind `invoice.status` means the
QS can draft and submit but never cancel — withdrawal is always a billing
decision. `Disputed → Draft` uses `invoice.write`, since that is sending a document
back for correction, not withdrawing it.

### D6 — Terminal states are `Paid` and `Cancelled`

`Paid` is undeletable, uncancellable and unwritable, so a Paid document is
permanent financial history. Corrections need a credit note, which is out of
scope. This has a practical consequence the smoke script had to design around: a
Paid fixture invoice is permanently unremovable, so the HTTP fixture stops at
`Partially Paid`.

### D7 — Compliance warnings are advisory and surfaced, not enforced

`checkInvoiceCompliance` reports rather than blocks, because a missing VAT number
is a data-completeness problem, not a reason to refuse to bill. The seeded client
is VAT-registered with **no VAT number on file**, so every new VAT-charging invoice
raises a warning; the seeded invoice is VAT-exempt at 0%. The UI shows the warning
block above the lines and the seeded document's amber banner is that warning firing
correctly. (Phase 15: the seeded client's VAT fields are operator data now — the
suites no longer write, null or assert them; the warning rule itself is unchanged.)

The `effectiveTaxRate` is re-derived on read rather than trusted from storage, so a
non-registered client always displays 0 even if the stored rate says otherwise.

## Defects found and fixed

- **F1 — `Partially Paid` was not an open state**, so a progress invoice could be
  raised on top of a part-settled one and bill the same lines twice. Found by the
  Phase 4 smoke test, not the unit suite. Fixed in `OPEN_INVOICE_STATUSES` with a
  named regression test.
- **F2 — no `Partially Paid → Cancelled` edge.** A part-settled invoice could never
  be written off or cleaned up: `Paid` was unreachable-for-cleanup and there was no
  cancellation out of the state. Added, with the reason distinguishing it from a
  clean void (money was received).
- **F3 — smoke fixture billed a zero-rated service code.** `S00167371` carries a
  0.0000 unit rate in the baseline; scoping it snapshotted 0.0000 and every money
  assertion passed against a derived expectation of zero. The fixture now requires a
  non-zero rate.
- **F4 — smoke fixture could not clean up after itself.** It only deleted invoices,
  so a failure mid-run leaked a job and project and the next run reported phantom
  drift. Cleanup is now a full FK-safe sweep, runs at startup and in a `finally`,
  and asserts its own result.
- **F5 — the `category` query filter rejects the Prisma key.** `?category=ACTIVITY`
  500s with `Unknown enum label`; the parameter takes the business label
  (`Activity`). Pre-existing Phase 2 route behaviour, surfaced by the Phase 4
  fixture. The fixture filters in code instead; the endpoint behaviour is unchanged
  and consistent with the API-uses-labels convention.

## Consequences

- Phase 5 (reporting, close, audit) inherits a settled job-billing position:
  recognised totals are computed from approved-or-better invoices, so receivables
  need no separate ledger.
- Credit notes, multi-currency and payment allocation are out of scope and are the
  natural next additions to the invoice lifecycle.
- Demo accounts still share one `.env` password; rotate before shared use.
