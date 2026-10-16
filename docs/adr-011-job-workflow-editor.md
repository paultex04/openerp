# ADR-011: The job workflow is administrator-editable data

- **Status:** accepted
- **Date:** 2026-10-15
- **Supersedes:** nothing. Amends [ADR-003](adr-003-operations-engine.md) (the
  job state machine) and [ADR-009](adr-009-job-management.md) §on the status
  dropdown.

## Context

The job pipeline — thirteen statuses and the legal moves between them — was a
PostgreSQL enum type plus a frozen TypeScript table in `@openerp/shared`. The
server authorised transitions against it, the register listed its statuses, the
detail screen built its dropdown from it, and the dashboard ordered its pipeline
card by it.

Two things were true at once:

- every change to the pipeline — relabelling a stage, moving one, changing which
  capability a move needs — required a code change and a deploy; and
- the people who run the workflow are the ones who should be able to edit it.

The requirement was an administration screen to edit the job status workflow.
That rules out the "keep it a constant" option: the ask was not just "permit
different roles to make different moves", it was "let us own the stages".

## Decision

### The catalogue is two tables

`job_statuses` (key, label, sort_order, is_terminal, editable_planned,
editable_actuals) and `job_transitions` (id, from_key, to_key, permission,
reason). Migration `0007_job_workflow` creates both, seeds the exact catalogue
the constant held — thirteen statuses, sixteen forward edges and the twelve
cancellation edges that the old "any non-terminal status may be cancelled" rule
produced — and retires the enum: `job.status` becomes `VARCHAR(40)` with
`ON DELETE RESTRICT` against `job_statuses(key)`. Behaviour is byte-identical
the moment the migration commits.

### Key vs label

The **key** is the identity: it is what `job.status` stores, what
`job_transitions` points at, and what the audit log names. Keys are immutable
after creation, and the seed deliberately sets `label = key` so nothing changes
visibly on day one. The **label** is presentation and is freely editable.

This split is what makes renaming safe. Relabelling `04. WIP` to "Work in
progress" changes what every screen shows and nothing about what history says,
because history never stored the label.

`sort_order` is numeric and unique, for the same reason the old array order was
authoritative: the register's filter order, the dropdown's order and the
dashboard's pipeline order all have to agree, and "backward" has to be
well-defined.

### The shared engine is parameterised, not replaced

`shared/src/job-status.ts` keeps its pure functions —
`nextStatuses(workflow, key)`, `checkTransition(workflow, from, to)`,
`canEditPlanned(workflow, key)` and friends — but every one of them now takes
the workflow as its first argument. `DEFAULT_JOB_WORKFLOW` remains the exported
constant, and it is load-bearing three times over:

1. it is what the seed inserts into an **empty** catalogue (it never upserts, so
   an edited database is never overwritten);
2. it is what the client renders while the workflow query is in flight;
3. it is the fixture the shared tests assert against.

The migration's SQL and `DEFAULT_JOB_WORKFLOW` must stay identical; the server
`seedJobWorkflow()` refuses to touch a non-empty catalogue precisely so the two
can never disagree in a running system.

### Read for job readers, write for administrators

- `GET /api/jobs/workflow` returns the catalogue to anyone holding `job.read`
  **or** `job.read.assigned` — the same rule that lets them see a job. A manual
  403, because the permission is an either/or.
- `GET /api/admin/workflow` returns the same catalogue with two extras only the
  editor needs: a per-status job count (so the screen can say why a delete is
  refused before it is attempted) and the assignable transition capabilities.
- Writes live under `/api/admin/workflow` behind `admin.workflow.read` /
  `admin.workflow.write`, which the seed grants to administrator only.

### Guardrails are server rules with specific error codes

The admin routes are the only writers, and they refuse:

| Rule                                                                         | Error                        |
| ---------------------------------------------------------------------------- | ---------------------------- |
| Key already exists                                                           | `STATUS_KEY_TAKEN` (409)     |
| Sort order already used                                                      | `STATUS_ORDER_TAKEN` (409)   |
| Transition pair already exists                                               | `TRANSITION_EXISTS` (409)    |
| Status still has jobs standing on it                                         | `STATUS_IN_USE` (409)        |
| Removing the last terminal status                                            | `LAST_TERMINAL_STATUS` (409) |
| Flipping a status to terminal while it still has exits                       | `TERMINAL_HAS_EDGES` (409)   |
| Capability outside the `job.transition.*` namespace, or not in the catalogue | `UNKNOWN_PERMISSION` (422)   |
| Edge from and to the same status                                             | `SELF_TRANSITION` (422)      |
| Edge naming a status that does not exist                                     | `UNKNOWN_STATUS` (422)       |
| Edge out of a terminal status                                                | `TERMINAL_SOURCE` (422)      |

Every accepted write calls `invalidateJobWorkflow()`, dropping the server's
process-local cache. That cache exists because the transition endpoint runs on
every move; it does not exist to make the workflow stale. There is no publish
step — an edit is live on the next request.

The UI mirrors only the two rules it would be absurd to let a user trip over
(deleting an occupied status is disabled with the count as the tooltip; the
source picker omits terminal statuses). The rest are deliberately left to the
server: a second implementation of the rules is a second place for them to be
wrong, and the error codes exist so the UI does not have to guess.

### Capabilities, not roles

Each edge names a permission from the seeded `job.transition.*` family:
`scope`, `execute`, `pack`, `billing`, `invoice`, `cancel`. Authorisation reads
the _edge's_ capability, so an administrator can re-permission a move without
touching role grants. The namespace is closed by construction: new capabilities
are added in the permission seed, and the admin route refuses to point an edge
at anything else — `job.write` is not a transition capability, however tempting
it looks in a dropdown.

### Billing keeps two hard-coded targets — and checks them

`markJobInvoiced` still targets `10. Invoiced` / `11. Partially Invoiced`,
because the billing engine has to know where "billed" lives; that is not a
decision to delegate to configuration. But it now checks the targets exist in
the catalogue first, and returns a readable `409 JOB_STATUS_MISSING` instead of
dribbling out a foreign-key error if an administrator has deleted them.

### The UI reads labels live

`useJobWorkflow()` is the one place the client asks for the catalogue; it
caches for five minutes and the admin panel invalidates it on every write. The
status pill resolves its label through it, the register's filter options come
from it, and the job detail dropdown renders it. An unknown key — a status the
catalogue has since lost, or one created without a colour — falls back to the
key itself and the neutral `outline` badge variant. That fallback is honest:
showing the raw key is more useful than inventing a label or a colour.

## Consequences

**Better.** The pipeline is editable without a deploy. Relabelling is safe by
construction. Adding a stage is a data operation, and because the register,
detail dropdown and dashboard all read order and labels from the catalogue,
they follow the edit without code. The old "cancel from anywhere" convention
became ordinary edges, so it can be taken away from a stage or handed to a
different capability.

**Worse.** Every consumer of the state machine now has to fetch the workflow
before it can render a status name; that is one extra cached request in the app
shell. The shared engine's functions gained a first argument, which touched
every call site — a mechanical change, but the sort that is easy to get half
right, so the shared test suite runs the parity assertions once per default
status against both `DEFAULT_JOB_WORKFLOW` and a synthetic custom workflow.

**Neutral.** Existing jobs keep their stage: the enum's stored values were the
keys, so the column retype preserves every row. `getStatusDefinition` — the
"may this status do X" helper — is gone; editability now comes from the
workflow rows and surfaces through `jobEditability(jobId)`.

## Verification

- Migration applied to the development database; job rows preserved
  (`10. Invoiced` ×3, `11. Partially Invoiced` ×1); seed then confirmed the
  catalogue was already present and left it untouched.
- `admin-workflow.integration.test.ts`: 31 gates covering RBAC on every admin
  route, the read-only endpoint, the seeded catalogue's shape, job counts,
  status CRUD, every guardrail in the table above, edge CRUD, and three
  end-to-end proofs — a job moves across a newly created edge (proving the
  cache is dropped on write), re-permissioning an edge changes who may use it,
  and deleting an edge stops the move being offered or performed.
- In-browser: creating `ZZ. QA Demo` through the panel made it appear in the
  register's status filter and the job detail dropdown (disabled, no edge) on
  the next navigation; editing and deleting it round-tripped with the confirm
  dialog, and the register dropped it again.
