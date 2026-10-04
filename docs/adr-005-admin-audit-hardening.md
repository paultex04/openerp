# ADR-005: Admin Suite, Audit Log and Hardening (Phase 5, v1.0.0)

## Context

Phase 5 closes the build out. Three things were named: an admin suite, an audit
log, and end-to-end coverage. A fourth turned up while doing them and is recorded
here because it was the most serious defect of the phase.

## The audit log

### D1 — Capture is zero-miss, not opt-in

Every `create`, `update`, `delete`, `createMany`, `updateMany` and `deleteMany`
in the application is recorded, through a Prisma client extension
(`db/client.ts`). The alternative — an `audit()` call inside each service
function — was rejected because a trail that depends on every future author
remembering has gaps, and the gaps are always where it matters.

Reading is deliberately not audited: it would drown the signal.

### D2 — An UPDATE records the change, not the row

`before` is read first (one extra indexed read per write), and `after` is
narrowed to the keys that actually differ, listed in `changed_fields`. Storing
the whole row would duplicate every table into the log and bury the one column a
reviewer came for. An entry that only held new state could not answer "who
changed the rate from 17.5226 to 20", which is the question it exists to answer.

### D3 — The actor is denormalised

`actor_user_id` is `ON DELETE SET NULL`, and `actor_email` / `actor_employee_id`
are copied onto the row. An entry must keep naming who acted after the account is
deactivated or deleted. Asserted by a test that has a throwaway account write
something, hard-deletes the account, and checks the entry still names them.

### D4 — Audit failure must not fail the business write

An audit insert that fails is logged and counted (`auditWriteFailures`, surfaced
on `/api/admin/audit/summary` and rendered as a banner), never rethrown. Losing an
audit entry is bad; refusing a paid invoice because the audit table was briefly
unavailable is worse. The count exists so the loss cannot be silent.

### D5 — Compliance warnings stay advisory

Unchanged from Phase 4: a missing VAT number is reported, not enforced.

## The admin suite

### D6 — Users are deactivated, never hard-deleted

`DELETE /api/admin/users/:id` deactivates and bumps `token_version`, so every
live session dies immediately rather than at token expiry. A hard delete would
cascade away the operational record of who was on a job (`job.supervisor_id`,
`job_assignment`) for no benefit.

### D7 — Self-lockout and last-administrator lockout are both refused

An administrator cannot deactivate themselves or drop their own administrator
role, and the last active administrator cannot be demoted or disabled. Either
mistake leaves the system with no way back in short of direct SQL against a
production database. The UI disables the buttons for your own row; the API refuses
independently.

### D8 — The role matrix shows granted _and_ expected

`GET /api/admin/roles` returns the live grants from the database and the
catalogue's expectation from the shared RBAC module. A mismatch is highlighted in
the UI. Adding a permission without re-seeding is a real failure mode — a role
silently lacks a capability — and it was previously invisible.

## The defect worth recording

### F1 — `AsyncLocalStorage.enterWith` in a preHandler does not reach the handler

The first implementation bound the audit actor in the `authenticate` preHandler
with `storage.enterWith`. This looks correct and is not: Fastify schedules hooks
and handlers on its own promise chain, which breaks the ALS continuation. Every
audited write was recorded as `system` with a null route.

The unit tests passed. They use `app.inject()`, which shares the caller's async
context, so attribution appeared to work for the wrong reason. It was only
caught by running a probe over **real HTTP** and querying `audit_log` directly —
the log looked completely plausible, full of entries, naming nobody.

The fix wraps each route handler in `storage.run` via an `onRoute` hook, which
establishes a genuine ALS scope around the handler's whole execution. Measured
afterwards over HTTP with interleaved requests:

| actor                        | action | model  | route               |
| ---------------------------- | ------ | ------ | ------------------- |
| `bongani.d@contractor.co.za` | CREATE | Client | `/api/clients` POST |
| `admin@contractor.co.za`     | CREATE | Client | `/api/clients` POST |

`onRoute` is used rather than another hook because only `onRoute` can replace the
handler. The same fix also makes `app.inject()` behave, since `run` establishes a
fresh scope regardless of the caller's context.

**The lesson:** for request-scoped state in Fastify, `enterWith` from a hook is
not equivalent to `run` around the handler, and an in-process harness can hide the
difference. Anything request-scoped is now asserted over a real socket in
`smoke:phase5`.

### F2 — Fire-and-forget audit writes read the actor too late

The first version resolved the actor inside the async write path, after the
query had already awaited. By then the context belonged to a later request. The
actor is now captured synchronously, before the query runs. A misattributed entry
is worse than a missing one, because it looks trustworthy.

### F3 — The fixture sweep reintroduced the FK-order bug

The audit suite's `afterAll` sweep deleted clients before the contracts
referencing them. The delete failed on the foreign key, was swallowed by a
`.catch`, and left both behind — so the next run collided on unique constraints
and failed for a reason unrelated to the code. Exactly the defect recorded in
Phase 3, reintroduced two phases later. Contracts now go first.

## End-to-end coverage

`server/src/e2e/business-flow.e2e.test.ts` runs over a real socket and carries one
job from a new contract through pricing, scoping, field actuals, invoicing and
approval, then asserts the audit trail names the right actor for each step and
that every entry carries a real route.

It exists because every earlier phase shipped at least one defect that `tsc`,
ESLint and the full unit suite all passed — webpack resolution, `.env` scoping in
Next, a null-state query guard, an enum-mapped status key, and now the ALS
attribution bug above. Per-module tests do not check that the modules join up.

## Consequences

- The audit log grows without bound; retention and archival are future work.
  Nothing prunes it, which is correct for an append-only record but is a real
  operational consideration.
- Credit notes, payment allocation, multi-currency and a month-end close remain
  out of scope, and are the natural next additions to billing.
- Demo accounts still share one `.env` password; rotate before any shared use.
