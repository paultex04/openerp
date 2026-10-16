# ADR-007: Master Data CRUD (Phase 7, planned)

## Status

**Planned. Not started.** This ADR was written on `phase/07-master-data-crud` to
record a gap found while auditing Phase 6, before any code was written. Every
claim below was verified against `v1.2.0`, not inferred.

## Context

Asked who can add contracts and amendments, the honest answer turned out to have
two halves that do not agree.

**By permission, the capability exists and is assigned.** `contract.write` and
`amendment.write` are in the catalogue (`shared/src/rbac.ts:100,105`) and granted
to Commercial/QS via `COMMERCIAL_GRANTS`, plus Administrator. The endpoints are
fully implemented and audited:

| Capability       | Endpoint                    | Guard             |
| ---------------- | --------------------------- | ----------------- |
| Create contract  | `POST /api/contracts`       | `contract.write`  |
| Edit contract    | `PATCH /api/contracts/:id`  | `contract.write`  |
| Delete contract  | `DELETE /api/contracts/:id` | `contract.delete` |
| Create amendment | `POST /api/amendments`      | `amendment.write` |
| Edit amendment   | `PATCH /api/amendments/:id` | `amendment.write` |

**Through the application, nobody can.** The client makes exactly twenty mutating
calls. None of them is `POST /api/contracts`, `POST /api/amendments`, or
`POST /api/clients`. The Commercial screen _lists_ contracts
(`GET /api/contracts`, `commercial/page.tsx:200`) and stops. Only three things on
that screen are editable, each gated by `can(...)`: cost parameters, rate master
build-up, and the recipe builder.

So a contract, an amendment, a client, a project, a job, a contact, an employee,
a broker and an employee contract type can currently only be created by calling
the API by hand. This is the same shape as the gap closed in Phase 6 for users,
where `POST`/`PATCH` existed and the UI exposed only "Deactivate": the API runs
ahead of the interface.

## Verified gap matrix

Server side, per table. "Create" means a purpose-built endpoint, not a
side-effect of another route.

| Table                 | List          | Create           | Update    | Delete    | Note                                                   |
| --------------------- | ------------- | ---------------- | --------- | --------- | ------------------------------------------------------ |
| Broker                | no            | no               | no        | no        | **no routes at all**                                   |
| EmployeeContractType  | no            | no               | no        | no        | **no routes at all**                                   |
| Employee              | no            | side-effect only | no        | no        | created by `POST /api/admin/users` (`admin.ts:220`)    |
| Contact               | no            | no               | no        | no        | **no routes at all**                                   |
| Client                | yes           | yes              | yes       | **no**    | delete missing; delete blocked by `contract.read` data |
| Contract              | yes           | yes              | yes       | yes       | complete                                               |
| ContractAmendment     | yes           | yes              | yes       | **no**    | `amendment.delete` is granted but has no route         |
| ContractCostParameter | via amendment | via `PUT`        | via `PUT` | via `PUT` | complete, deliberate                                   |
| ServiceMasterRate     | yes           | yes              | yes       | yes       | complete                                               |
| ServiceCode           | yes           | yes              | yes       | yes       | complete                                               |
| Project               | yes           | yes              | yes       | yes       | complete                                               |
| Job                   | yes           | yes              | yes       | yes       | complete                                               |
| Invoice               | yes           | yes              | yes       | yes       | complete, lifecycle-governed                           |

Client side: **no create, edit or delete UI exists for any of** Broker,
EmployeeContractType, Employee, Contact, Client, Contract, ContractAmendment,
Project, Job, or JobAssignment. `components/admin/users-panel.tsx` is the only
entity in the application with a working create/edit/deactivate flow.

## Correction to ADR-006 D4

ADR-006 D4 omitted Crew Assignments on the grounds that `job.assign` "is enforced
by **no server route** - `grep` for it returns nothing outside
`shared/src/rbac.ts`", and that "there is no assignment endpoint".

**That was wrong.** Both exist, and did so at `v0.3.0`, two releases before
ADR-006 was written:

- `POST /api/jobs/:id/assignments` - `operations.ts:886`, guarded
  `app.requirePermission('job.assign')` at line 888
- `PATCH /api/job-assignments/:id` - `operations.ts:955`
- `DELETE /api/job-assignments/:id` - `operations.ts:925`

Added in `61ff735` ("job lifecycle, deliverables and field actuals"). The grep
behind the ADR's claim was searching for the permission as a _definition_ and
missed its _usage_ in a route's `preHandler`.

The omission decision still stands, but for the correct and much smaller reason:
**there is no screen, and no endpoint to populate an employee picker** - there is
no `GET /api/employees` at all. See M2.

---

## Decisions taken

### D1 - Master data is one concern, not a screen per table

Nine entities with create/edit/delete is nine near-identical dialogs. A single
`MasterDataPanel` takes a field descriptor list and renders search, a `DataTable`,
a create/edit `Dialog` and a delete `AlertDialog`, so a new entity costs a
descriptor and a route rather than a bespoke screen. This is the same reasoning as
the shared `DataTable` in Phase 6, which removed nine bespoke tables.

### D2 - Deletion is refused, not cascaded, wherever history exists

Phase 2 set the precedent on contracts: `DELETE /api/contracts/:id` returns 409
when amendments or projects exist ("terminate or supersede it instead"). Every
new delete follows that shape. Cascade-deleting commercial history is
unrecoverable, and a `409` that names the blocking count is a better answer than
a `confirm()` dialog.

Two consequences worth stating plainly:

- An **employee with an `AppUser` cannot be deleted**, only deactivated, because
  `app_user.employee_id` is a non-nullable 1-to-1 (`admin.ts:214`).
- A **client with contracts cannot be deleted.** Contracts are never deleted in
  practice either (see D2 above), so deleting a client's last contract is a
  dead end by design. This is intentional.

### D3 - Referential pickers are typed, not free text

Contracts and amendments reference each other and both hang off clients. The
forms must use a picker constrained to the parent, never a numeric id field,
because `POST /api/amendments` validates `contractId` server-side and a typo
becomes a 400 the user has to decode.

### D4 - No DataTable where rows hold live inputs

Carried forward from Phase 6 and unchanged. The rate build-up sheet, the recipe
builder, cost parameters and `DeliverableGrid` keep their own tables: they hold
inline inputs bound to a draft, and TanStack row recycling would move an input out
from under the cursor mid-edit.

---

## Decisions, now resolved

All four were answered before implementation, and each answer changed the plan.

**Q1 - clients stay on `contract.write` / `contract.delete`.** The four genuinely
unowned tables (Broker, Employee, Contact, EmployeeContractType) get a new
`organisation` permission category. The accepted consequence: in the permissions
matrix a client write shows under Commercial rather than Administration, which is
where a reader would look for it anyway.

Ten new keys: `employee.read/write`, `broker.read/write/delete`,
`contracttype.read/write/delete`, `contact.read/write/delete`. All granted to
Administrator. The single exception is **`employee.read`, also granted to the
project manager**, because `job.assign` is theirs and the crew picker needs a list
to pick from - they may attach employees to jobs without being able to rewrite a
payroll-adjacent record.

**Q2 - built.** `DELETE /api/amendments/:id` exists and the permission is no
longer decorative. See M1.

**Q3 - under `/admin`.** Eight new tabs, grouped into Access / Records / Audit so
eleven tabs do not become one unreadable strip.

The objection raised before the decision was that hiding employees under `/admin`
behind `admin.user.read` would put the org chart out of reach of a PM who
legitimately holds `job.assign`. That is real, and it is handled by gating each
tab on its own permission rather than on the section header: the PM sees
**Projects** and **Employees** under Administration and nothing else. A deep-link
they may not use gets a plain "you do not have permission to open X. It needs
`contract.read`" rather than a screen of failed requests.

**Q4 - confirmed, no hard delete.** `DELETE /api/employees/:id` sets `endDate` and
deactivates any linked sign-in account. The row survives, and the UI says "End
employment" rather than "Delete" because saying otherwise would be a lie.

### Q4 has a consequence that bit the test suite

Because an employee row is never deleted, it holds its `contractTypeId` forever,
so that contract type can never be deleted either - and while the employee holds a
broker, that broker cannot be either. A first draft of `smoke:phase7` created all
three per run and cleaned them up, which **cannot work**: every run would have
leaked three rows, permanently. They are now fixed fixtures, created-if-missing
and reused, which is also what makes the run idempotent. This is the same lesson
Phase 5 records in its own residue note, reached from the other direction.

---

## Implementation notes worth keeping

### The generic panel wraps its own cells, so accessors must not

`DataTable` renders a cell by wrapping whatever the accessor returns in a
`TableCell` - or a `NumericCell` when the column declares `meta.align === 'right'`.
An accessor returning its own `<TableCell>` therefore emits `<td><td>…</td></td>`,
which is invalid markup the browser silently repairs by hoisting. Nothing crashes
and nothing looks wrong; the content simply appears twice in the accessibility
tree. Money and count columns opt into right-alignment through `meta`, never
through markup.

### The edit dialog must seed from the record, not from an empty draft

A `useState({})` initialiser makes the edit form open blank. Because the panel
keys the dialog on the record id, the correct shape is a `useState` _initialiser_
that reads the record - a remount then arrives already filled, with no cascading
render and no frame of empty inputs.

### Select fields cannot be deskewed by a predicate on a sibling field

Projects take both a contract and an amendment, but the amendment dropdown needs
to narrow by the chosen contract. The generic form has no field-to-field logic, so
the amendment picker is populated with contracts and the server resolves the rest.
This is a known simplification, not a finished behaviour: the honest version needs
a dependent-picker concept the descriptor does not have yet.

### The Admin page distinguishes "asked for this tab" from "said nothing"

`useUrlParam` cannot tell those apart, and the difference matters. A PM who opens
`/admin` should land on a tab they can use; a PM who was linked to
`?tab=clients` should be told plainly that they may not open it. Reading
`searchParams.has('tab')` once settles both cases.

---

## What shipped

| Step | Work                                                              | Status |
| ---- | ----------------------------------------------------------------- | ------ |
| M1   | `DELETE /api/clients/:id`, `DELETE /api/amendments/:id`           | done   |
| M2   | Organisation routes: brokers, contract types, employees, contacts | done   |
| M3   | `MasterDataPanel` + descriptors                                   | done   |
| M4   | Admin tabs: clients, contacts, contracts, amendments              | done   |
| M5   | Admin tab: projects                                               | done   |
| M6   | Admin tabs: employees, brokers, contract types                    | done   |
| M7   | Crew Assignments screen, closing ADR-006 D4                       | done   |
| M8   | `smoke:phase7.mjs` (66 checks) incl. per-role refusals            | done   |

`verify` exit 0; smoke phase2 52, phase3 87, phase4 67, phase5 46, phase6 71,
phase7 66, all 0 failed; client build clean; `db:check` 24 tables / 8 enums.

## A retraction: the Jobs Board "hang" was not a defect

An earlier draft of this ADR reported a pre-existing bug: `/operations?view=board`
renders the shell and then sits on its `Loading…` Suspense fallback forever. It
called that "confirmed by stashing the branch and reproducing on the baseline
commit".

**That confirmation was invalid, and the bug is not established.** What is actually
known:

- It **never reproduced in a production build.** Every route renders on a cold load
  against `next start`.
- It **does not reproduce once a route has been compiled** in dev. Forcing a
  recompile by touching the page file still resolved it instantly, on the first
  sample.
- **Every** route showed it at one point, including `/billing`, `/admin` and
  `/dashboard` - so it is not a property of any one page.
- The baseline reproduction was worthless because stashing the branch rewrites
  files, which restarts and recompiles the dev server. That is the same event that
  precedes the stall, so the test did not isolate anything.

Client-side navigation has always worked, including during the stalls. The honest
description is an **intermittent dev-server stall, cause unknown, no production
impact**, seen only on a cold `next dev` with many browser tabs open.

It is retracted rather than fixed, because there is no defect to fix and inventing
one - marking a route dynamic on a hunch, say - would add a real cost to every
request for a symptom nobody can reproduce. If it returns, the useful artefact is
the browser console captured on the failing load, before anything is changed.

## A real pre-existing defect: a race in the billing test

`billing.integration.test.ts:401` (`reports compliance as clean once a VAT number is
on file`) mutates shared `client id 1`, and both `e2e/business-flow` and
`commercial.integration` write clients in parallel. It failed once in six runs and
passed the rest, and passed three consecutive runs on both the branch and the
baseline. It is not a regression, and it will flake again.

Not fixed here; it wants its own issue, and the fix is to stop sharing `client 1`
across parallel test files rather than to add a retry.

**Resolved in Phase 15**, and the prescription above was followed: the suite no
longer shares client 1 at all. Gate 1 dropped its assertion on the seeded client's
VAT state, and Gate 2 builds dedicated fixture clients (`numberless` / `numbered`)
for every VAT assertion, deleted in teardown. The same change removes the reason
`scripts/restore-baseline-fixture.mjs` used to force the seeded client's VAT number
back to NULL, so it no longer does; that field is operator data.

---

## The Jobs Board became a table, not a bespoke screen

`BoardView`'s kanban is replaced by `JobsPanel`, built on the shared `DataTable`.

**Why the kanban had to go.** There are thirteen statuses. A populated board is
thirteen fixed-width columns of horizontal scroll, and a job is findable only by
already knowing its status - which is the one thing a board is supposed to help you
discover. A table with a status _filter_ and a sortable status column answers the
same question ("what is stuck in pack ready?") without the scroll, and it paginates.

**Status is not a field.** `JobMasterRow` deliberately has no `status` field. A
job's status is lifecycle state: it moves only through
`POST /api/jobs/:id/transition`, which enforces the 13-step machine and the
permission each step needs. A `PATCH` form offering status would either silently
do nothing or bypass the gate - the exact failure ADR-003 exists to prevent. The
status _column_ is read-only; the transitions stay on the job card.

For the same reason `actualStartDate` / `actualEndDate` are not fields either. Those
are entered by the field supervisor at the point of work, alongside the actuals.
So the panel owns a job's **paperwork**, and the job card owns its **lifecycle and
its actuals**. Splitting it this way is the reason this fit the generic panel at
all.

`GET /api/jobs` had to grow: `projectId`, `supervisorId`, `clientContactId`,
`workOrderReceivedDate` and `purchaseOrderReceivedDate` were not in the projection,
and the edit dialog seeds itself from the row. A missing column there means the form
opens blank and PATCHes nothing back - the same failure the M1 cost-parameter bug
had, in a different place.

The deep-linked `?status=` is **seeded** into the table's own filter rather than kept
as a second select beside it. Two status filters on one screen is a control that
disagrees with itself. The sidebar's "Valuation Packs (Ready for Signature)" entry
still works; it just pre-fills a filter the user can then clear.

---

## Still open

- **Database amendments.** Ten scenarios where the schema, not the interface, is
  what makes a workflow awkward: a missing unique constraint on crew assignments,
  no soft-delete on master data, job dates with no ordering constraint, and seven
  more. Each is costed, risk-ranked, and split into "do it now" versus "needs a
  business decision" in
  [phase-07-database-amendments.md](phase-07-database-amendments.md). The three cheap
  ones - a unique index on `job_assignment`, two `CHECK` constraints on job date
  ranges, and a `Contact.role` column - are the obvious next migration: no
  retroactive data problem and no way to lose history.
- **The dependent-picker fix is general but narrow.** `optionsFor` resolves any
  select's options from the form's current values, and clears a value that the
  sibling selection has invalidated. That covers project -> amendment and
  job -> project -> amendment. It does not yet cover a _multi-level_ chain where the
  third level depends on the second, which the descriptor shape cannot express
  without a small extension.
- **Live/employed filter on job pickers.** The job form's supervisor list is already
  filtered to active employees. The same is not true of a _job_ picker used to create
  a deliverable or an invoice: a cancelled or completed job is still selectable.
  That is correct for invoicing a completed job and wrong for scoping a new one, so
  it needs the lifecycle to say which — see item 7 in the amendments document.
