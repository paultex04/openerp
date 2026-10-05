# ADR-008: Schema Amendments and Phase 8 (v1.3.0)

## Status

Shipped. Migration `0004_master_data_workflow`, applied and verified.

## Why this is Phase 8 and not more Phase 7

Phase 7 was UI and endpoints: the application could not maintain its own reference
data. This ADR is a **schema** change, which is a different kind of risk — it is
the first time since Phase 1 that the database itself has moved, and it needs its
own version line so a reviewer can see the boundary. It draws up **v1.3.0**.

## The data this migration was allowed to touch

The user was explicit that the database is seed data with one exception that
matters. That shaped the whole approach:

| Tables                                                                                                                                             | Treatment                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `contract_cost_parameters` (12), `service_master_rates` (22), `service_code` (6), `service_code_labour_item` (8), `service_code_material_item` (3) | **Real commercial input. Not read, not written, not migrated.** |
| Clients, contracts, projects, jobs, users, crew                                                                                                    | Seed. Safe to amend or remove.                                  |
| `job_service_code` (3 rows)                                                                                                                        | Seed, but _touched_: a column added and backfilled.             |

The published acceptance vectors were re-checked after the migration, not assumed:
`S00250451` still prices at **227.61 ZAR/hr** and `S00247970` at **17.5226 ZAR/m**,
and the five table counts are unchanged.

## What was implemented

| Item | Change                                                             | Where                              |
| ---- | ------------------------------------------------------------------ | ---------------------------------- |
| 1    | Unique index on `job_assignment(job_id, employee_id)`              | migration                          |
| 3    | `is_archived` on six master-data tables + live indexes             | migration, routes, UI              |
| 4    | `contact.role`                                                     | migration, schema, form, picker    |
| 5    | Two `CHECK` constraints ordering the job date ranges               | migration                          |
| 6    | `job_service_code.snapshot_source` JSONB, captured at scoping time | migration, `operations/service.ts` |
| —    | `scripts/apply-migrations.mjs`, a transactional migration runner   | new                                |

## What was declined, and the reasoning recorded

**Item 2 — `employee_rate` effective dating.** The user's reason is the deciding
fact, and it is a better one than mine: the employee rate does not affect any
implemented workflow, because a job's cost derives from its **labour service
codes**, not from the person. It becomes load-bearing the moment revenue is
compared against cost, which is a future module. Adding a currency column was
declined alongside it. Revisit with that module, not before.

**Item 7 — `contract.status` cached roll-up.** Declined. Recorded for whoever picks
it up: it would have to be a _cache_ and never authoritative, because a second
source of truth for "is this contract live" drifts from the amendments unless
something maintains it, and the pricing engine must keep reading the amendments.

**Item 8 — `audit_log` partitioning.** Declined, with the cheap half noted: an index
on `(created_at DESC)` for the audit panel's default ordering is worth adding on
its own if that screen is ever slow. Better loading strategy before better schema.

**Item 9 — `app_user.employee_id`.** Explicitly not to be changed, and the user's
clarification corrects an assumption this ADR previously made. The constraint runs
one way only: **an Employee may exist with no User, and always could** — the Phase 7
employee routes create records with no linked account. What must hold is that a
_user of the system_ is an employee, so every audit-log write has a real actor. The
employee side is expected to get considerably richer when the HR module lands, and
relaxing this would regress the actor guarantee to serve that. Leave it alone.

## D1 - Archiving is a separate verb from deleting, with separate permissions

Six `*.archive` keys, distinct from `*.delete`. Delete removes a row nothing
references; archive retires one that something does, reversibly. Giving both the
same button is precisely what made "cannot delete" feel like a dead end — a
mis-entered contract that had already been scoped was unremovable, with nothing
recording that it was never real.

### How archived records behave, which was the question asked

Four rules, applied without exception:

1. **A list hides archived rows by default**; `?includeArchived=true` shows them.
   The default is the point. A register that quietly fills with retired rows stops
   being readable, and every picker would offer dead records.
2. **A picker excludes archived rows, always, with no flag.** You cannot scope new
   work against an archived contract or attach a retired broker to a crew. This is
   what makes archiving _safe_, and it is why the mechanism is a server-side
   default rather than a client-side filter — a picker that filtered client-side
   would still offer a dead contract to someone who had not ticked a box.
3. **Archived rows stay visible in registers behind a "Show archived" toggle, with
   an explicit `Archived` badge.** Never silently vanish. If a contract is missing
   from a picker, the register has to say _why_.
4. **Archiving never cascades.** One row, explicitly, every time. A cascade would be
   invisible, one keystroke wide, and could retire a contract that four live jobs
   depend on.

Where the engine, not the interface, has to be the judge:

- **Archiving a contract** is refused while any of its jobs is neither cancelled nor
  invoiced. Those jobs are priced against it and its amendments are their legal
  basis.
- **Archiving an amendment** is refused while any job is priced against it.
- **Archiving a broker, a contract type or a contact** is refused while anything
  holds it — an employee, employees, a named job respectively.

The block check lives in the route, not the browser. A count the client rendered
thirty seconds ago is not a fact about the row.

Archiving a **client** is deliberately _not_ refused when it has contracts. A client
with a contract is a client doing its job, and refusing would recreate the exact
dead end this item exists to remove. The contract remains visible and reachable.

### Employee archiving is not this mechanism

An employee is _terminated_ with `endDate`, which is already a soft delete with
better semantics: it means "left the company" rather than "this record is wrong",
and it is reversible by clearing the date. `is_archived` is not on `employee`, and
should not be — two overlapping soft-delete mechanisms on one table is a question
nobody can answer later.

## D2 - A pricing snapshot that records what it was, not just the rate

`job_service_code.applied_rate` already snapshots the unit rate at scoping time,
and that is why the published vectors hold. It could not answer "why was this priced
that way?" — which is the question a client query or an audit actually asks.

`snapshot_source` captures, at the moment of scoping: the service code and its
amendment, its markup, every labour line with the rate card it priced from, every
material line, and the amendment's cost parameters. Decimals go over as **strings**
so the JSON round-trips them exactly — `JSON.stringify` on a Decimal loses trailing
zeros and can render 0.15 as 0.15000000000000002. A `digest` over the canonical
form makes the record tamper-evident; nothing in the application edits a snapshot in
place, so a digest that stops matching would be a real signal.

Two deliberate limits:

- **It never throws.** Provenance is valuable but not worth refusing to scope a job
  over: a job with no provenance is recoverable by recomputing from the inputs,
  whereas a refused scope loses the user their work.
- **The three existing rows are backfilled and labelled.** The backfill
  reconstructs their inputs from current state, which is truthful about the inputs
  as they stand now and is **not** a record captured at scoping. Those rows carry
  `"backfilled": true` so nobody later mistakes a reconstruction for a fact.

## D3 - Migrations get a runner, because "applied by hand" does not scale

`prisma migrate deploy` fails on this database with P3005 — the baseline predates
Prisma — and `prisma migrate diff --from-url` emits a destructive migration. So
migrations were hand-written SQL applied by hand, which worked for three and would
have started failing in the way that matters: silently.

`server/scripts/apply-migrations.mjs` makes "by hand" mean _one command, in order,
once each, transactionally_. Its properties, in order of importance:

1. Refuses to run twice — a ledger table records what applied.
2. **Each migration is one transaction**, so a failure leaves nothing applied. This
   was not theoretical: the first attempt failed on a mis-named table
   (`service_master_rate` is `service_master_rates`) and the rollback was total.
3. A checksum is recorded, and an edited applied migration is reported loudly.
4. Files apply in numeric order.
5. `--baseline` records already-present migrations **without running them**, and
   refuses once the ledger has entries.

It uses `pg` rather than Prisma's client because Prisma's extended query protocol
uses prepared statements, and Postgres rejects a multi-statement script through one.

The ledger table is named `schema_migration_ledger`, deliberately **not**
`_prisma_migrations`: that name would make `prisma migrate deploy` believe it had a
baseline when it does not, turning a loud P3005 into a silent wrong answer.

**Every migration therefore ships with its pre-flight query inline**, because
`db:check` reports table and enum counts only — a failed migration would otherwise
be the only signal that a constraint was going to violate existing data.

## A defect the archive work introduced, and the lesson

The archiving smoke section created a contract on its client fixture and **did not
record the contract id**. The contract was never cleaned up, so the client always
had a reference, so the client could never be deleted — and every run leaked one
client, permanently. Six rows accumulated before it was caught.

It surfaced only because the suite asserts `no fixtures are left behind`, which is
the check that exists precisely to catch this. The lesson is the one Phase 5's own
residue note records: **a fixture that cannot be removed must be detected, not
assumed removable**, and the detection has to be an assertion rather than a
reviewer's eye. Eight leaked rows were removed by hand and the suite now proves
idempotency across consecutive runs.

## Gates

`verify` exit 0 (177 shared + 140 server). Smoke phase2 52, phase3 87, phase4 67,
phase5 46, phase6 71, phase7 **86**, all 0 failed. Client build clean. `db:check`
24 tables / 8 enums.

Migration verified by probe, not by inspection: all three new guards were confirmed
to _reject_ bad input (inverted planned range, inverted actual range, duplicate
crew member), and both published pricing vectors plus all five pricing table counts
were re-read afterwards.
