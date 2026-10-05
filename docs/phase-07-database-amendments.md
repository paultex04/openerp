# Database Amendment Scenarios (Phase 7 review)

## Why this document exists

Phase 7 made the UI able to maintain every master-data table. Doing that exposed a
set of places where the **schema, not the interface, is what makes a workflow
awkward**. The user asked for these to be listed, so they are listed here with the
migration each one would need, what it would cost, and an honest judgement on
whether it is worth doing.

Nothing here has been implemented. Each item states its own risk, because most of
them touch tables that hold priced history, and this system has an explicit
principle about that: **do not cascade away commercial history** (ADR-002, ADR-003,
and the `409`-rather-than-cascade rule on every delete added in Phase 7).

Ordered by value per unit of risk. The first three are cheap and I'd do them; the
rest need a business decision first.

---

## 1. `JobAssignment` has no unique constraint — the database allows duplicate crew

**Today.** `JobAssignment` (`job_assignment`) has indexes on `jobId` and `employeeId`
but no uniqueness between them. Every sibling join table does:

| Table                   | Constraint                                       |
| ----------------------- | ------------------------------------------------ |
| `JobServiceCode`        | `@@unique([jobId, serviceCodeId])`               |
| `ServiceCodeLabourItem` | `@@unique([serviceCodeId, serviceMasterRateId])` |
| `ContractAmendment`     | `@@unique([contractId, amendmentNumber])`        |
| **`JobAssignment`**     | **none**                                         |

**Why it matters now.** Before Phase 7 there was no way to add an assignment, so
nothing could create a duplicate. M7 added the crew screen, which means the UI can
now — and a "crew of 12" where Sipho appears twice is a real payroll-shaped
mistake, not a cosmetic one. The Crew panel filters already-assigned employees out
of its picker, but a client-side filter is a courtesy, not a guarantee: two open
tabs, or a direct API call, both defeat it.

**The amendment.**

```sql
CREATE UNIQUE INDEX job_assignment_job_employee_key
  ON job_assignment (job_id, employee_id);
```

Before creating it, de-duplicate and report what was removed:

```sql
SELECT job_id, employee_id, count(*)
  FROM job_assignment
 GROUP BY job_id, employee_id
HAVING count(*) > 1;
```

**Cost.** One index. **Risk.** Low, provided the de-duplication is done first and
the report is read rather than piped into a `DELETE`. A migration that fails on a
duplicate is strictly better than one that silently keeps them.

**Verdict: do it.** This is the cheapest item here and the only one where the
database is currently weaker than the UI assumes.

---

## 2. `Employee.rate` is a bare `Decimal(10,2)` with no currency or effective dating

**Today.** `Employee.rate Decimal? @db.Decimal(10, 2)` — a single number, nullable,
no currency, no effective date, no history. It is the hourly rate used when pricing
labour.

**Why it matters.** The pricing engine has been careful about reproducibility:
`ServiceMasterRate` snapshots its costs at build time precisely so a historic
contract stays reproducible (ADR-001/002). But the **employee** side has no such
snapshot. Raise Sipho's rate from R 227.61 to R 240 next year and there is no way to
know what it was when last year's job was measured. Today that is survivable only
because `JobServiceCode.appliedRate` is snapshotted — so the _price_ is safe. What is
lost is any ability to answer "was this person correctly rated when this work was
done?", which is exactly the question an audit or a dispute asks.

**Two amendments, at different costs.**

_Cheap — currency only._ Add `rateCurrency String @default("ZAR") @db.VarChar(3)`.
The business is single-currency today and the billing gap list already names
multi-currency as out of scope, so this is mostly honesty about what the number
means. Cost: one additive column.

_Expensive — effective dating._ Replace the scalar with
`EmployeeRate { id, employeeId, rate, currency, effectiveFrom, effectiveTo?, source? }`
and make the rate read "the row in effect on the job's planned start date". This is
a genuine schema change to a table referenced by crew, supervisors and managed
reports, and it turns a one-field edit into a dated-entry workflow.

**Verdict: add the currency column; do not build the history table until
multi-currency is actually on the roadmap.** The price snapshot already protects the
money, so this is a defensible deferral rather than a hole.

---

## 3. No soft-delete or `isArchived` on master data, so "delete" is either a hard delete or a refusal

**Today.** Every master-data table is either deletable-if-unreferenced or refused
with a `409`. There is no third option. `Employee` got a special case — `DELETE` sets
`endDate` — which works, but `endDate` means "left the company", not "this is a typo,
remove it". A broker created by mistake and immediately deleted is fine; a client
created by mistake whose contract has since been raised cannot be removed at all,
because the delete refuses and there is no "this was never real" flag.

**The amendment.** `isArchived Boolean @default(false)` (or `archivedAt DateTime?`)
on `Client`, `Contract`, `ContractAmendment`, `Broker`, `EmployeeContractType` and
`Contact`. Archived rows are excluded from pickers by default, still resolve for
historic documents, and report themselves as archived rather than pretending not to
exist.

**What it would fix.** A mis-entered contract that has already been scoped would
become archivable instead of immortal. It also gives the UI something honest to say
— today "cannot delete" with a count is accurate but leaves the user stuck.

**Cost.** Six additive boolean columns, plus a `where: { isArchived: false }` on every
picker query and every list. **Risk.** Medium, and mostly _risk of forgetting_: an
archived row leaking into a picker is a worse bug than a row that cannot be deleted,
because it is invisible until someone prices against a dead contract. Every exclusion
is a place to get it wrong.

**Verdict: worth it, but only bundled with a deliberate decision about how archived
rows behave everywhere.** It is a cross-cutting change disguised as six columns, and
it should not be done opportunistically.

---

## 4. `Contact` has no role, so a client contact cannot be distinguished from a signatory

**Today.** `Contact { clientId, name, mobile, email }` and that is all. A job names
one via `Job.clientContactId`. There is no way to say that one contact is the
financial signatory, another is the day-to-day site contact, and a third is an
accounts-receivable email.

**Why the UI is awkward without it.** The crew/contact picker offers a flat list of
every contact on every client. On a client with five contacts the user picks by
memory. Adding a `role String?` (or a small lookup) is one nullable column and makes
the picker honest.

**Verdict: cheap, do it with the next schema migration.** One nullable column, no
backfill needed, no risk. Lower value than items 1–3 but nearly free.

---

## 5. Job dates are four nullable columns where two ranges would express intent

**Today.** `plannedStartDate`, `plannedEndDate`, `actualStartDate`, `actualEndDate` —
four nullable `Date` columns with no constraint that a range is ordered.

**What the schema does not prevent.** `plannedEndDate < plannedStartDate` is
accepted. A job with an actual start but no actual end is normal; a job with an
actual end _before_ its actual start is a data error the database is silent about.
The UI cannot express the rule either, so nothing catches it.

**The amendment.** A `CHECK` constraint:

```sql
ALTER TABLE job ADD CONSTRAINT job_planned_range_ordered
  CHECK (planned_end_date IS NULL OR planned_start_date IS NULL
         OR planned_end_date >= planned_start_date);
-- and the same for actual_*.
```

Plus, optionally, a partial index for "in progress":
`CREATE INDEX job_in_execution ON job (planned_start_date) WHERE actual_end_date IS NULL;`

**Cost.** Two check constraints and one index. **Risk.** Low — but a check constraint
on an existing table fails if any current row violates it, so run the violation
query first. `db:check` reports table and enum counts only, so a failed migration
here is the _only_ signal, which is an argument for adding the pre-flight query to
the migration itself.

**Verdict: do it.** Cheap, and it moves a real invariant out of "nobody thought to
check" and into the engine.

---

## 6. `JobServiceCode.appliedRate` is a snapshot but has no snapshot of _what_ it was

**Today.** `JobServiceCode` snapshots `appliedRate` from the service code at scoping
time, with the comment "Immutable pricing snapshot taken at scoping time". That is
the right instinct, and ADR-001's published vectors depend on it.

**What is still missing.** The snapshot is a rate. It does not record the _inputs_
that produced it: which `ServiceMasterRate` row, which cost parameters, what
material markup. So the number is reproducible but its provenance is not — you can
see what was charged, not why.

**The amendment.** Denormalise the provenance onto the snapshot:
`snapshotSource Json @db.Jsonb` (or `snapshotAmendmentId`, `snapshotServiceCodeId`,
`snapshotRateId` plus a hash of the cost parameters).

**Cost.** One column plus a write-time change, or four FKs. **Risk.** Low technically,
but it is _retrospective_: rows scoped before the migration have no provenance and
would need backfilling from data that has since moved. It is therefore worth doing
only if it is done before the historical data grows further.

**Verdict: decide by how much history exists.** This is the one item where "do it
now" and "too late" are genuinely different answers, and the deciding number is the
row count in `job_service_code`, not anything about the schema.

---

## 7. `Contract` has no status, so a contract cannot be "expired" without an amendment that says so

**Today.** Contract lifecycle is inferred entirely from its amendments'
`ContractAmendmentStatus` (`Draft` / `Pending Approval` / `Active` / `Superseded` /
`Terminated`). The UI computes "current amendment" as "the one whose status is
Active".

**The awkwardness.** A contract that has simply run out — no renewal signed yet — has
no active amendment and so reads as having no terms at all. There is no way to
distinguish "we never scoped this" from "the agreement lapsed". And "does this client
have a live contract?" cannot be indexed, because the answer is a join over child
rows.

**The amendment.** `Contract.status ContractStatus @default(DRAFT)` maintained
alongside the amendments, as a cached roll-up with the amendments remaining the
source of truth. Or, more honestly, a `ContractPeriod` child table modelling that a
contract has many dated periods — which is really what an amendment already is, so
the honest version is a rename and a re-parent rather than a new concept.

**Verdict: the cached roll-up is worth it; the re-parent is not.** A cached status is
a second source of truth and will drift, so it needs a trigger or a periodic
recompute, and it must never be the thing the pricing engine reads. The re-parent
would be a large migration for a naming improvement.

---

## 8. `AuditLog` has no retention policy and grows without bound

**Today.** Append-only, never pruned, no partitioning. Every write to every table
lands there, forever.

**Why it is on this list.** It is a database question, not a UI one, and it interacts
with the UI: the audit panel queries it with filters and a limit, and it will get
slower as it grows, and eventually the tab becomes the slowest screen in the
application. It was already flagged in ADR-006 and is unchanged.

**The amendment.** Time-based partitioning by month (`PARTITION BY RANGE (created_at)`)
with a drop-old-partitions job, and/or archiving to cold storage beyond a retention
window. A partial index on `(created_at DESC)` for the panel's default query.

**Cost.** Partitioning a live table is a migration with real operational weight;
an index alone is trivial. **Risk.** Partitioning mistakes lose audit history, which
is the one thing this table must never lose.

**Verdict: add the index now, partition only when there is a measured problem.** The
index is the cheap 80%. Partitioning early risks the data for a performance problem
that has not arrived.

---

## 9. `AppUser.employeeId` is a non-nullable 1-to-1, which is right, and worth protecting explicitly

Not an amendment — a note, because it looks like a candidate and is not.

`AppUser.employeeId` is non-nullable and unique, so an account can never exist
without a person behind it, and `POST /api/admin/users` creates the employee
first (ADR-005). This is _why_ an employee cannot be hard-deleted: doing so would
either fail on the FK or cascade an account away. Q4's "no hard delete for
employees" is a consequence of this constraint, not an independent preference.

The temptation is to relax it so employees can exist without logins. That would be a
regression: the whole audit-trail design depends on every write having a real actor.
Leave it alone.

---

## Summary

| #   | Amendment                                    | Cost               | Risk       | Verdict                         |
| --- | -------------------------------------------- | ------------------ | ---------- | ------------------------------- |
| 1   | `JobAssignment` unique `(jobId, employeeId)` | 1 index            | Low        | **Do it**                       |
| 5   | `CHECK` constraints on job date ranges       | 2 constraints      | Low        | **Do it**                       |
| 4   | `Contact.role`                               | 1 column           | Very low   | **Do it**                       |
| 2   | `Employee.rateCurrency`                      | 1 column           | Low        | Do the column only              |
| 8   | `AuditLog` index on `(created_at DESC)`      | 1 index            | Low        | Do it                           |
| 6   | Snapshot provenance on `JobServiceCode`      | 1 column           | Low        | Decide by row count             |
| 3   | `isArchived` on master data                  | 6 columns          | Medium     | Bundle, don't improvise         |
| 7   | `Contract.status` cached roll-up             | 1 column + trigger | Medium     | Cache only, never authoritative |
| 2b  | `EmployeeRate` effective-dated history       | New table          | High       | Defer until multi-currency      |
| —   | Relax `AppUser.employeeId`                   | —                  | Regression | **Don't**                       |

Items 1, 4 and 5 together are four columns/indexes and two constraints, with no
retroactive data problem and no way to lose history. They are the obvious next
migration. Everything else needs a decision from someone who knows the business,
not from me.
