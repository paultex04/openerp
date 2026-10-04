# ADR-003: Operations Engine (Phase 3)

## Context

Phase 3 adds the operations surface: projects, the 13-status job lifecycle,
deliverables (`job_service_code`), crew assignments, and the field-supervisor
view. The acceptance criteria centre on two guarantees: the state machine cannot
be bypassed (not even by an administrator), and the `applied_rate` snapshot can
never move after scoping.

## Decisions

### D1 — Legality is judged before capability (`shared/src/job-status.ts`)

`transitionJob` consults the state machine first and the RBAC catalogue second.
A jump that does not exist in the pipeline returns `422 ILLEGAL_TRANSITION` even
for a caller holding all 42 permissions; a legal move by an unauthorised caller
returns `403 TRANSITION_FORBIDDEN`. The distinction matters: the first is a bug
in the requested move, the second a missing grant, and conflating them sends the
caller to fix the wrong thing. Verified live: `01. Scoping → 10. Invoiced` is
422 for the administrator too.

### D2 — The 13 statuses form a pipeline with two documented rewinds

`01A. Scoped → 01. Scoping` (reopen scoping before release) and
`09. Awaiting change order → 04. WIP` (execute the change) are the only backward
moves. Everything else backward is `ILLEGAL`, including `09 → 04` for callers
without `job.transition.execute`. Invoicing transitions (`07/08 → 10/11`,
`10 ↔ 11`) require `job.transition.invoice`; `markJobInvoiced` in the service
layer is reserved for the Phase 4 invoice lifecycle, not the interactive route.

### D3 — Amendment inheritance is resolved centrally, never in handlers

A null `job.amendment_id` inherits `project.amendment_id` via
`resolveJobAmendmentId`, called by every read and write path. The job detail
payload reports both the resolved id and `amendmentInherited`, so the UI shows
which commercial basis a job prices against. Service codes attached to a job
must belong to the resolved amendment (`422 AMENDMENT_MISMATCH` otherwise).

### D4 — `applied_rate` is write-once, and the API proves it

The snapshot is written in `addDeliverable` and never recomputed: planned and
actual subtotal updates re-derive from the stored rate, and the deliverable view
exposes `appliedRate` alongside `rateHasDrifted`/`currentRate` so a QS can see
that a rate card moved without the job's figures moving. The integration suite
re-prices a fixture service code 10.00 → 20.00 and asserts the snapshot stays at
10.00 with drift flagged.

### D5 — Scope locks are status-derived, explained, and mirrored — not guessed

`canEditPlanned` (01/01A/02) and `canEditActuals` (04/05/06) live in shared and
are enforced server-side with `409 SCOPE_FROZEN` / `409 ACTUALS_LOCKED` plus a
human-readable reason. The UI renders the server's verdict rather than
reimplementing the rule, so a locked cell is always genuinely locked.

### D6 — Demo accounts are seeded, guarded, and documented

Only the administrator account existed, so every permission check passed and
role-gated workflows shipped unverified. The seed now creates one account per
non-admin role (three reuse baseline employees, so David Mokoena really does
supervise job 1). Guards: opt-in via `SEED_DEMO_PASSWORD`, hard refusal under
`NODE_ENV=production`, idempotent, password-policy enforced. Quoting rule
recorded in `.env.example`: an unquoted `#` starts a comment, silently
truncating the password (found the hard way).

### D7 — Tests assert consistency with the state machine, not baseline position

Seeded jobs are live data that move through the pipeline — job 1 advanced
`06 → 07` during interactive verification (a legal, authorised transition).
Tests that pinned its stage broke. The suite now derives expectations from the
shared machine (`canEditActuals(status)`, `allNextStatuses(status)`) and asserts
aggregation consistency (counts sum to the job total) instead of fixed stages.
The smoke test derives its probe targets from `/transitions` for the same
reason: hardcoding jumps assumes a stage, and from `07` a jump to `10` is legal.

## Defects found and fixed

- **E1 — `tsc` passed on a syntactically invalid file.** `client/tsconfig.json`
  carries Next's `incremental: true`, and stale build info masked a real syntax
  error my PowerShell string surgery had introduced. `typecheck` now runs with
  `--incremental false`; the fast path remains for local iteration.
- **E2 — Fixture cleanup leaked a rate card.** The snapshot test's `finally`
  deleted the service code before its labour line, failed on the FK, and aborted
  — leaving a row that broke an unrelated Phase 2 count assertion (23 vs 22).
  Fixed with FK-safe ordering, per-step guards, and an `afterAll` backstop sweep.
- **E3 — `00. Cancelled` rendered as a completed stepper bar.** It sorts first
  in the label list but is a terminal exit, not a pipeline step. Excluded via an
  explicit `PIPELINE` list with the reason documented at the omission.
- **E4 — Projects-list payload mixed enum keys and labels.** `statusCounts` used
  business labels while the embedded jobs array carried raw Prisma keys. The UI
  never noticed (it fetches per-project detail); the integration suite did. The
  route now maps both to labels.
- **E5 — Smoke harness tripped the login rate limit.** Eight logins per run plus
  back-to-back re-runs hit 10/min. Sessions are now memoised per run and 429s
  back off and retry instead of failing.

## Consequences

- Phase 4 (billing) inherits: the amendment/VAT basis per job, the frozen
  `appliedRate` for invoice lines, and `markJobInvoiced` for the invoice
  lifecycle.
- The dev database's job 1 now sits at `07. Pack Ready` (reached legally during
  verification). This is a legitimate state, not drift — but any future test or
  script must treat baseline lifecycle positions as movable (D7).
- Five demo accounts share one `.env` password. Rotate before shared use.
