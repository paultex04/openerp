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

## Open decisions, needed before implementation

**Q1 - Permission naming for the organisation tables.** There is no permission
for Broker, Employee, Contact or EmployeeContractType; the catalogue has no
`organisation` category. Clients currently ride on `contract.write`, which is
defensible ("clients are commercial") but makes a client delete a
`contract.delete` action, which is not obviously right. Options: add a
`client.*`/`employee.*` set, or add an `organisation` category. **Recommendation:
add an `organisation` category** with explicit `client.*`, `employee.*`,
`broker.*`, `contact.*` and `contracttype.*` keys, and keep `contract.*` for
contracts only. It makes the permissions matrix honest, which is the screen Phase
6 built for exactly this purpose.

**Q2 - `amendment.delete`.** Commercial/QS and Administrator hold a permission
that no route honours. Either build `DELETE /api/amendments/:id` (409 if the
amendment has rates, service codes, projects or jobs) or drop the key from the
catalogue and re-seed. **Recommendation: build it.** An amendment with cost
parameters and rates hanging off it is exactly the "terminate or supersede"
case, and removing a granted permission to tidy a catalogue is the wrong fix for
a UI that is merely missing.

**Q3 - Where do master data screens live?** Under `/admin` (consistent with
"administration is where records are maintained"), or split by domain - clients
and contacts under Commercial, employees and brokers under a new
Administration? **Recommendation: split by domain.** A Site Supervisor needs to
find their own record, and hiding employees under `/admin` behind
`admin.user.read` makes the org chart unavailable to a PM who legitimately holds
`job.assign`. This is the one decision that changes the nav tree, and it is
reversible, but it should be settled before code is written.

**Q4 - Employee delete vs deactivate.** Employees with job history are the
largest referential web in the schema (supervisor, assignments, managed reports).
**Recommendation: no hard delete for employees at all** - deactivate via
`endDate`, matching the user rule in D2. Employee _records_ are payroll-adjacent
and deleting one voids the history of work someone actually did.

---

## Proposed sequence

Each step is independently shippable and leaves the gates green.

| Step | Work                                                                                                                                  | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M1   | `DELETE /api/clients/:id`, `DELETE /api/amendments/:id` (409 where referenced)                                                        | Q2         |
| M2   | `GET /api/employees`, `GET/POST/PATCH /api/brokers`, `/employee-contract-types`, `/contacts`, `/employees` with `search` + pagination | Q1         |
| M3   | `MasterDataPanel` + descriptors                                                                                                       | D1         |
| M4   | Commercial screens: clients, contacts, contracts, amendments                                                                          | M1, M3     |
| M5   | Operations screens: projects, jobs                                                                                                    | M3         |
| M6   | Organisation screens: employees, brokers, employee contract types                                                                     | M2, M3, Q3 |
| M7   | Crew Assignments screen, closing ADR-006 D4 correctly                                                                                 | M2         |
| M8   | `smoke:phase7.mjs` + RBAC gate that every role is refused every write it lacks                                                        | -          |

M8 is not optional. Every new write endpoint is a chance to ship a permission
hole, and the existing per-role refusal tests are the reason the admin surface
is trustworthy today.

## Risks

- **Re-seeding changes `RolePermission` rows.** Any new permission key must be
  added to `PERMISSIONS` _and_ to the relevant role grant list, then re-seeded,
  or existing accounts silently lack the capability. The permissions matrix
  reads from the code catalogue, so a half-applied change looks fine on screen
  and fails in the hand.
- **Employee is the widest referential surface.** Ordering the columns: brokers
  and contract types first (they are leaves), then employees, then contacts
  (which need a client), then the commercial chain.
- **`JobAssignment` has no unique constraint** on `(jobId, employeeId)`, unlike
  `JobServiceCode` and `ServiceCodeLabourItem`. An assignment screen will make
  duplicates easy to create. Add the constraint, or de-duplicate on write.
