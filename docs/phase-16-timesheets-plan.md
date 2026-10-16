# Phase 16 — Timesheets & Job Costing

**Status:** implemented on `phase/16-timesheets` — see
[phase-16-timesheets.md](phase-16-timesheets.md) for what shipped and
[ADR-012](adr-012-timesheets-and-costing.md) for the design record
**Release target:** `v2.3.0`
**Branch:** `phase/16-timesheets`
**Related:** ADR-003 (operations engine), ADR-004 (billing engine), ADR-009 (job management)

> **Revision (2026-10-16, pre-release).** This plan was written first; three of its
> decisions changed on the business's instruction before the phase shipped, and the
> sections below have been updated to match. (1) A line's cost is the **employee's
> own rate**, not the job amendment's rate card — the card now only suggests labour
> types and prices _planned_ cost. (2) **Approval is capability-based** and includes
> your own week; the manager rule and the self-approval block are gone. (3) The
> entry screen is an **employee picker + week grid**, replacing the self-service
> "My time" tab, and an approved week can be **amended in place by an approver** as
> well as reopened.

---

## 1. The one idea

The business already records **revenue** per job: quantities × the charge-out rate
snapshotted at scoping (`job_service_code.applied_rate` → `actual_subtotal` →
invoices). It has **no idea what a job costs to deliver**, because nothing in the
system has ever recorded labour hours.

This phase adds one thing — **hours worked, assigned to a job** — and turns it
into the other half of the equation:

```
revenue (already known, from actuals/invoices)
  − labour cost (new, from timesheets)
  = job gross margin
```

Everything else in the phase exists to make that number trustworthy: a period
and approval workflow so hours can be frozen, a rate snapshot so a frozen hour
stays reproducible, and a costing engine so the arithmetic lives in one place.

## 2. What this module is not

The brief is explicit that timesheets are **separate** and run **in the
background**. Concretely:

- **No effect on actuals.** Hours are not quantities. `job_service_code`,
  `actual_subtotal` and the invoicing path are untouched. A timesheet can be
  wrong without corrupting a valuation pack.
- **No effect on revenue.** Revenue keeps coming from the commercial side.
  The timesheet never _creates_ revenue; it only supplies cost.
- **Its own tables, API, screens, permissions.** Deleting the module would
  leave operations and billing completely intact.
- **Background, not a workflow.** Nobody invoices a timesheet or transitions a
  job from it. It accumulates quietly; job and finance screens read the result.

## 3. Domain model

### 3.1 New tables (migration `0008_timesheet`)

```
Timesheet                          -- one person, one week
  id, employeeId → employee
  periodStart Date                 -- Monday
  periodEnd   Date                 -- Sunday
  status      TimesheetStatus      -- DRAFT | SUBMITTED | APPROVED | REJECTED
  submittedAt, submittedById → app_user
  decidedAt, decidedById → app_user
  decisionNote String?
  createdAt, updatedAt
  unique(employeeId, periodStart)
  index(status)

TimesheetEntry                     -- one (job, day, labour type, shift) line
  id, timesheetId → timesheet (cascade)
  jobId           → job            -- required: the whole point
  jobServiceCodeId → job_service_code (nullable, deliverable link)
  workDate        Date
  labourType      String(100)      -- matches service_master_rates.labour_type
  shiftType       ShiftType        -- reuses the existing enum (NT/OT/DT/NS/ST)
  hours           Decimal(6,2)     -- 0.25 step
  isBillable      Boolean default true
  notes           String?
  -- frozen at approval, null while editable:
  rateSnapshot    Json?  @db.JsonB -- { capturedAt, source, costRate, employeeId }
  costRate        Decimal(12,4)
  costAmount      Decimal(12,2)
  createdAt, updatedAt
  index(timesheetId), index(jobId, workDate)
```

**Why a header + lines.** The header is the unit of approval and the union
`(employee, week)` is the natural key a supervisor thinks in. It also gives
"freeze the row and its children" a single place to live.

**Why an enum for `TimesheetStatus`, not the Phase-15 status catalogue.** The
job status catalogue is admin-editable because the _business_ owns job stages.
Timesheet states are internal plumbing (draft/submitted/approved/rejected) that
no administrator should be renaming, so a Prisma enum is the honest model.

### 3.2 Rate resolution — where a cost rate comes from

The job amendment's `ServiceMasterRate` (ADR-001) holds a fully built-up labour rate
per `(amendment, labourType, shiftType)`, and the costing engine still uses it — but
only to price **planned** hours and to suggest labour types in the entry grid. It is
**not** the cost of an actual hour.

A worked hour costs the **employee's own rate**:

```
costRate = overrideRate ?? employee.rate        -- the full rate-vector build-up is not used for actuals
```

Resolution order for an entry (first hit wins):

1. **Manual override** on the entry (rare; needs a reason, audited).
2. The employee's `employee.rate`.

If neither yields a positive rate the line is saved but shown **unpriced**, and the
week cannot be approved (`EMPLOYEE_RATE_REQUIRED`). `employee.rate` is required and
strictly positive at creation, so this is only reachable for legacy records.

Approval stores a small `rateSnapshot` (`{ capturedAt, source, costRate,
employeeId }`) beside the frozen `costRate`/`costAmount`, so a frozen hour is
defensible and a later edit to the employee's rate cannot rewrite it. The audit log,
not a stored component vector, is what records how a past figure was reached.

### 3.3 Planned hours — the other side of the variance

`ServiceCodeLabourItem` already carries `crewQuantity` and `hoursPerUnit`, so a
job has a computable **planned hours** figure:

```
plannedHours(line) = crewQuantity × hoursPerUnit × job_service_code.plannedQuantity
```

This means the costing engine can show **planned vs actual hours and cost**, not
just revenue vs actual cost — the same planned/actual spirit as the deliverable
table, applied to labour. No new data is required for this; it falls out of the
existing pricing model.

## 4. The costing engine (`shared/src/costing.ts`)

Pure and isomorphic, like the rest of `shared/` — the client uses it for live
previews in the entry grid, the server uses it authoritatively. All arithmetic
goes through `shared/src/money.ts` (`round`, `roundMoney`, `sumExact`), rounding
once on output.

```ts
resolveCostRate({ amendmentRates, labourType, shiftType, employeeRate, override })
  -> { costRate, basis, source, components }

entryCost(entry) -> number                 // roundMoney(hours × costRate)

plannedLabour({ lines }) -> { hours, cost } // from ServiceCodeLabourItem

summariseJobCosting({ plan, actuals, invoiced, entries, materials })
  -> {
       revenueActual,          // Σ job_service_code.actual_subtotal
       revenueInvoiced,        // Σ non-cancelled invoice.subtotal_amount
       hoursPlanned, costPlanned,
       hoursActual,  labourCostActual,
       materialCostActual,     // Σ snapshot_source BOM line cost × actual qty
       costActual,             // labourCostActual + materialCostActual
       grossMargin,            // revenueActual − costActual
       grossMarginPct,
       hoursVariance, costVariance,
       byLabourType: [...],
     }
```

`costing.ts` knows nothing about Prisma or HTTP — it takes plain objects. That is
what makes it testable with the same published-vector style as the pricing engine
(ADR-001/002).

## 5. Permissions & roles (`shared/src/rbac.ts`)

New category **`timesheet`**:

| Permission            | Meaning                                          |
| --------------------- | ------------------------------------------------ |
| `timesheet.write.own` | Draft, edit and submit **your own** week         |
| `timesheet.write`     | Draft/edit/submit **anyone's** week (on behalf)  |
| `timesheet.read.own`  | See your own weeks and your own hours            |
| `timesheet.read`      | See all weeks, approvals and costing views       |
| `timesheet.approve`   | Approve / reject / reopen **any** submitted week |
| `timesheet.override`  | Enter a manual cost-rate override (audited)      |

Default grants:

| Role            | Grants                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ |
| administrator   | every `timesheet.*`                                                                              |
| project_manager | `write`, `read`, `approve`, `write.own`, `read.own` — the role already "monitors cost variances" |
| site_supervisor | `write.own`, `read.own` — logs their own field hours                                             |
| commercial_qs   | `read`, `approve` — costing/margin interest, and a sign-off on hours                             |
| billing_clerk   | `read` — revenue-vs-cost for finance                                                             |

Cost rates and margins are commercially sensitive; they are visible to anyone
holding `timesheet.read` and hidden from `read.own`.

## 6. API surface (`server/src/routes/timesheets.ts`)

Fastify plugin, `authenticate` + `requirePermission`, Zod validation, the
existing error-code/status conventions, audit via the model extension.

```
GET    /api/timesheets                    list (filters: employee, status, period, job)
GET    /api/timesheets/employees          employees the caller may record time for
POST   /api/timesheets                    get-or-create draft for (employee, week)
GET    /api/timesheets/:id                header + entries (+ totals)
PATCH  /api/timesheets/:id                notes / period while editable
POST   /api/timesheets/:id/entries        add a line
PATCH  /api/timesheet-entries/:id         edit a line (DRAFT, or an approver amending)
DELETE /api/timesheet-entries/:id         delete a line (same rule)
POST   /api/timesheets/:id/submit         DRAFT → SUBMITTED
POST   /api/timesheets/:id/approve        SUBMITTED → APPROVED (freezes cost)
POST   /api/timesheets/:id/reject         SUBMITTED → REJECTED (note required)
POST   /api/timesheets/:id/reopen         APPROVED → DRAFT (note required)

GET    /api/timesheets/approvals          every submitted week, for any approver
GET    /api/costing/jobs                  per-job profitability register
GET    /api/costing/jobs/:jobId           one job's full costing breakdown
GET    /api/costing/rates                 rate lookup for planned cost / suggestions
```

Error codes follow the Phase-15 style: `EMPLOYEE_RATE_REQUIRED`, `TIMESHEET_LOCKED`,
`EMPTY_TIMESHEET`, `DATE_OUTSIDE_WEEK`, `JOB_NOT_ASSIGNED`, `OVERRIDE_FORBIDDEN`,
`OVERRIDE_REASON_REQUIRED`, `FORBIDDEN`.

**Who may be entered.** `GET /api/timesheets/employees` is the picker's source: a
`timesheet.write` holder sees every active employee, a `timesheet.write.own` holder
sees only themselves. The server decides the list; the client only renders it.

**Approval is capability-based.** Any holder of `timesheet.approve` — PM, commercial,
administrator — may decide any submitted week, **including their own**. There is no
manager rule and no self-approval block.

## 7. "Background" computation — computed on read, no cache

There is no job queue in the stack, so "background" means **computed server-side,
surfaced without the user managing it** — not a cron worker, and not a cache.

Costing is recomputed from base rows on every read (`server/src/timesheets/costing.ts`,
behind `GET /api/costing/jobs` and `/:jobId`). This is a deliberate step back from the
in-process cache the plan first proposed:

- A job's costing inputs move from three different modules — `job_service_code`
  (revenue, planned quantity), `timesheet_entry` (approved cost, frozen at
  approval), `invoice` (billed). A cache would have to be invalidated from all
  three writing paths, and the one invalidation that gets forgotten is exactly
  where a margin is silently wrong.
- The computation is a handful of indexed queries over rows the request is already
  reading; there is nothing to gain by caching it.
- Correctness over latency: a stale margin is a wrong number that looks right. See
  ADR-012.

A **nightly rollup** (historical snapshots for trend reporting) is explicitly
_out of scope_ for this phase. "Background" here means "no manual rollup step", not
"a scheduled worker".

## 8. Client experience

### 8.1 Navigation

A new top-level **Timesheets** section (its own icon, separate from Operations
and Billing), because the brief calls the module separate:

| Entry                | Route                           | Shown when                                   |
| -------------------- | ------------------------------- | -------------------------------------------- |
| Enter time           | `/timesheets?tab=enter`         | `timesheet.write.own` / `read.own` / `write` |
| Approvals            | `/timesheets?tab=approvals`     | `timesheet.approve`                          |
| Labour profitability | `/timesheets?tab=profitability` | `timesheet.read`                             |

Everything lives under `/timesheets` rather than putting the profitability
register on `/billing`: keeping the whole module on one route is what makes the
separation structural rather than a matter of where a link points. The costing
views read `job_service_code` and `invoice`, but neither they nor the week grid
ever write them.

There is no separate "All Timesheets" register. A raw all-employees week list was
planned but not built: it duplicated the approvals queue minus the decision, and
the genuine read need — "what did labour cost this job?" — is answered by the
profitability register and the job panel. `GET /api/timesheets` is still there and
permissioned (`timesheet.read`), so a register can be added later without a
server change.

Each entry gets an `anyOf` in `client/src/lib/nav.ts` exactly like every other
section; no nav item points at a route that does not exist.

### 8.2 Enter time — an employee picker over a week grid

Hours are recorded **for a selected employee**, not only yourself: the screen leads
with an employee picker (populated from `GET /api/timesheets/employees`) and a week
navigator, then the grid. A `write.own` holder sees only their own name; a `write`
holder sees the crew.

The distinctive UI decision is that a timesheet _is_ a grid of days, so the screen
is a real week grid, not a list of rows.

```
                 Mon   Tue   Wed   Thu   Fri   Sat   Sun    Total
 JOB-1042  Fitter  8     8     8     8     4     –     –      36.0
 JOB-1051  Rigger  4     –     6     6     –     –     –      22.0
 Leave              –     –     –     –     4     –     –       4.0
                                              Week total        58.0
 [ + Add job line ]                         [ Submit week ]
```

- Rows are `(job, labour type, shift)`; columns are days; the hour in a cell is
  the total for that combination on that day.
- A cell is a **button**, not an input: clicking it opens the line dialog for
  exactly that `(job, type, shift, day)` — creating when the cell is empty, editing
  when it holds a line. Inline cell editing was rejected because the cell has to
  carry validation, the optional deliverable link and the audited override, and
  scattering those into a grid of uncontrolled inputs is how a timesheet silently
  saves the wrong thing. The dialog keeps them in one place; the grid stays a
  read-out.
- Tabular (`tabular-nums`) figures, a weekend-inclusive day header, a totals row
  under the grid, and unpriced lines marked with a warning glyph rather than a
  zero.
- Built from **shadcn/ui** primitives (`Table`, `Input`, `Badge`, `Button`,
  `Dialog`, `Field`, `Empty`, `Skeleton`, `Toast`), respecting the vendored
  `components/ui/**` rule.
- Live cost preview uses the values the API already computed with
  `shared/src/costing.ts`; the server remains authoritative and there is no second
  implementation of the maths on the client.
- Status banner: DRAFT (editable) → SUBMITTED (read-only, awaiting approval) →
  APPROVED (frozen, rate snapshot) → REJECTED (editable, with the approver's note
  shown back to the employee).

### 8.3 Approvals

A queue of every submitted week, for any approver — whoever submitted it, including
their own — with hours total, cost total, and any unpriced lines flagged. Approve /
reject (with a required note) in place.

### 8.4 Recently approved (not a separate "All Timesheets" register)

The approvals panel's second mode lists approved weeks (`GET /api/timesheets?status=Approved`)
so an approver can reach a week to reopen it. It is the same `DataTable` and the
same review dialog as the queue — a week is either awaiting a decision or has one,
and both live on the screen where decisions are made.

### 8.5 Labour profitability (`/timesheets?tab=profitability`)

One row per job: hours, labour cost, material cost, revenue (actuals), invoiced,
gross margin, margin %. Supports the "costs vs revenue per job" view the brief asks
for, defaulting to jobs that actually have approved hours. Sorting, search and the
filter run in the `DataTable`, matching every other register.

### 8.6 Job detail — Labour & Margin panel

A compact panel on the existing job detail summary: planned hours vs actual
hours, labour cost, revenue, margin — the same numbers, in the place a project
manager already looks. Gated on `timesheet.read`.

## 9. Migration, seed and configuration

- Hand-written `server/prisma/migrations/0008_timesheet/migration.sql`, applied
  with `npm run db:migrate`; `schema.prisma` gains the two models and the enum;
  `npm run db:generate` regenerates the client.
- New permissions are seeded by the existing RBAC seed (`shared/src/rbac.ts`
  drives it); the administrator is kept equal to the full catalogue. Note the
  seed's existing rule: a non-administrator role that has been customised does
  **not** silently receive a newly-added catalogue grant. A fresh install seeds
  the timesheet grants to the default roles; an upgraded install where the four
  built-in roles were customised needs an administrator to grant them in the
  roles matrix (Administration → Roles & permissions), or a reset of
  `app_role.permissions_customized`. This is deliberate and unchanged from
  Phase 5 — an operator's grant edits are not overwritten by a deploy.
- The cost-basis constant `DEFAULT_COST_BASIS = 'fully_loaded_ex_profit'` in
  `shared/src/costing.ts` now applies only to **planned** cost — the recipe priced at
  the amendment's rate card. Actual hours cost the employee's own rate, so no basis
  is applied to them. The rate-resolution helper still supports a component vector
  (it is unchanged and unit-tested), but the timesheet no longer feeds it one.

## 10. Testing

- **Shared unit tests** for `costing.ts`: rate resolution order, override
  precedence, `fullLoadedRate − profitCost`, planned-hours derivation, rounding
  at the boundary, margin percentage, empty/zero cases. Published-vector style.
- **Server integration tests** (`timesheets.integration.test.ts`): CRUD, the
  DRAFT→SUBMITTED→APPROVED/REJECTED lifecycle, employee-rate pricing (the rate card
  ignored for actuals), `EMPLOYEE_RATE_REQUIRED` and unpriced lines, permission and
  own-vs-all scoping, an approver amending an approved week in place, self-approval
  allowed for a project manager and refused for a supervisor, override requires a
  reason, reopen unfreezes and re-approval re-freezes, and the costing endpoints.
  This is the end-to-end pass (draft → lines → submit → approve → profitability
  reflects the cost) — no separate HTTP smoke script this phase, matching
  Phases 14–15.
- **Client checks**: `npm run build` (Turbopack) plus a manual pass of the week
  grid, approvals and profitability views on a production build; `check:docker`.

## 11. Delivery sequence

1. **Shared** — schemas (Zod), `costing.ts`, permissions; unit tests.
2. **Database** — migration `0008`, Prisma models, seed; `db:migrate`.
3. **Server** — timesheet service + routes, approval workflow, costing routes
   (computed on read), integration tests.
4. **Client** — nav, week grid, approvals queue, profitability register,
   job-detail Labour & Margin panel.
5. **Docs & release** — this plan stays as the design record; the shipped state is
   summarised in `docs/phase-16-timesheets.md`, with a new ADR for the costing
   model ([ADR-012](adr-012-timesheets-and-costing.md)), the README stack/branch
   table, then `verify`, `build`, `check:docker`.

## 12. Decisions

### Settled (confirmed in planning)

| #   | Decision                     | Answer                                                                                                                                         |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cost-rate basis              | the **employee's own rate** (or a typed override); a small `{ capturedAt, source, costRate, employeeId }` snapshot is frozen per approved hour |
| 2   | Period model                 | Weekly header per employee (Mon–Sun); the header is the unit of approval                                                                       |
| 3   | Non-productive time          | Job-only in v1; leave/training/standby deferred                                                                                                |
| 4   | Revenue definition           | Actuals as the headline margin; invoiced shown alongside                                                                                       |
| 5   | Approval owner               | any `timesheet.approve` holder (PM/commercial/admin), **including their own week**                                                             |
| 6   | Deliverable link             | Optional `job_service_code` link; job-level variance always available                                                                          |
| 7   | Costing placement            | `/timesheets?tab=profitability` register + job-detail panel (moved off `/billing` so the module stays one route)                               |
| 8   | Entry UI                     | Employee picker + week grid (days across, job lines down)                                                                                      |
| 9   | Cost when a rate is missing  | the line is unpriced and approval is refused (`EMPLOYEE_RATE_REQUIRED`); `employee.rate` is required at creation                               |
| 10  | Payroll export / rate dating | Out of scope for v1                                                                                                                            |

### Explicitly out of scope (v1)

- Payroll export / CSV.
- Time-versioned rate cards — a job's amendment supplies "the rate on the day".
- Non-productive / leave / training hours.
- Nightly historical rollups; costing is computed on read, so there is no rollup
  step and no cache to go stale.

### Settled (round 2)

| #   | Decision                    | Answer                                                                                                                                                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11  | Approval ownership          | any `timesheet.approve` holder may decide any submitted week, including their own; a week is approved/rejected **whole**, never split per job                                                                      |
| 12  | Crew without logins         | a supervisor enters and submits on behalf (`timesheet.write`) after picking the employee; the week records whose hours, audit records the actor; bulk crew entry is a fast-follow                                  |
| 13  | Materials in margin         | included in v1, derived from `job_service_code.snapshot_source` × actual quantity; labour and materials shown as separate lines                                                                                    |
| 14  | Correcting an approved week | **both** paths: the approver **reopens** it to DRAFT (cost unfreezes, re-freezes on re-approval), or **amends a line in place** on the approved week (that line is re-priced and re-frozen at once) — both audited |
| 15  | Grid row granularity        | a row is `(job, labourType, shiftType)`; choosing a deliverable pre-fills labour type/shift from its labour items; flat grid, no sub-rows                                                                          |

**The frontier is empty — this plan is decision-complete.**
