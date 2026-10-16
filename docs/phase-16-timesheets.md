# Phase 16 — Timesheets and Labour Costing

**Release target:** `v2.3.0`  
**Branch:** `phase/16-timesheets`  
**Design record:** [ADR-012](adr-012-timesheets-and-costing.md)

## Scope

One module, delivered as its own top-level section:

1. **A Timesheets module, separate from Job Management.** Its own nav section, its
   own tables, its own lifecycle. It writes hours and nothing else — never a
   `job_service_code`, an actual or an invoice.
2. **A week grid to record hours against jobs.** One row per (job, labour type,
   shift), days across; clicking a cell opens the line editor for that job and day.
   Deliverables are an optional link on a line, pre-filled from the job.
3. **Week-level approval.** DRAFT → SUBMITTED → APPROVED → REJECTED. Approval is
   capability-based: any holder of `timesheet.approve` — project manager, commercial
   desk, administrator — may approve any submitted week, including their own. A
   non-approver may not.
4. **Cost frozen at approval.** A line costs the **employee's own hourly rate** (or a
   manual override), and approval writes the resolved cost rate, the cost amount and
   a small rate snapshot onto the line, so the figure is reproducible. The job
   amendment's rate card is not a cost source for hours.
5. **Job costing computed on read.** A profitability register
   (`/timesheets?tab=profitability`) and a Labour & margin panel on the job detail,
   both fed by `GET /api/costing/jobs`. Revenue is work-done actuals, with invoiced
   shown alongside; cost is labour (approved hours, at the employee rate) plus
   materials (snapshotted BOM × actual quantity), with planned hours and planned cost
   from the recipe for the variance.

## Decisions captured

- **Hours are not quantities.** The module is additive and read-only with respect to
  the commercial records; this is the constraint the whole design protects.
- **Time is recorded for a selected employee, not only yourself.** The entry screen
  is an employee picker plus a week grid: a `timesheet.write` holder may pick anyone,
  a `write.own` holder only themselves. This replaced a self-service "My time" tab.
- **Cost is the employee's own rate.** An hour costs `employee.rate` (or a typed
  override). The rate card is only a source of labour-type _suggestions_ and of the
  **planned** cost, never of an actual hour. `employee.rate` is required and strictly
  positive, enforced in the shared schema, the employee form, the admin user-create
  form and the timesheet guard.
- **The week is the unit of approval.** A line has no status. Two audited ways back
  from an approved week exist: **reopen** (returns it to draft and unfreezes it, so it
  is re-approved as a whole) and **amend in place** (an approver corrects a single
  line on the approved week; the corrected line is re-priced and re-frozen at once).
  The Prisma audit extension records the before/after of every entry write.
- **Approval is capability-based.** `timesheet.approve` is the whole rule, and it
  includes your own week. There is no manager rule and no self-approval block.
- **No cache.** Costing recomputes from base rows on every read; a cache would need
  invalidating from three writing modules. See ADR-012 §"computed on read".
- **Non-productive hours (leave, training), payroll export, time-versioned rate
  cards and nightly rollups are out of scope** for this phase.

## Upgrading an existing install

An employee now needs a **cost rate** before their time can be recorded: opening a
week for a rate-less employee is refused with `EMPLOYEE_RATE_REQUIRED`, and an
un-priced line cannot be approved. The column itself stays nullable, so the upgrade
is additive — but an install that predates this phase (or one whose employees were
created without a rate) should set a rate on each employee in **Master data →
Employees** before those people log time. The seed gives the administrator and the
demo accounts a rate; baseline-imported employees already carry one.

The timesheet permissions are seeded from the RBAC catalogue, and the seed has a
long-standing rule: a **non-administrator role that has been customised does not
silently receive a newly-added grant**. A fresh install gets the six timesheet
permissions on the default roles automatically; an install whose built-in roles have
been edited needs an administrator to grant them in **Administration → Roles &
permissions** (or to reset `app_role.permissions_customized` for the role so the
next seed applies). This matters for the commercial desk specifically: its
`timesheet.approve` grant is new in this revision, so a customised `commercial_qs`
role needs it added. An administrator account always has every permission.

## Release checks

- Apply migration `0008_timesheet` with `npm run db:migrate`, then
  `npm run db:generate` (CI uses `db:push`, and `schema.prisma` already matches).
- `npm run seed` to place the six `timesheet.*` permissions in the catalogue.
- `npm run verify` (format, lint, typecheck, 216 shared + 207 server tests).
- `npm run build` (Turbopack production build; the client now builds the
  `/timesheets` route).
- `npm run check:docker`.
- `npm run smoke:phase2` … `smoke:phase7`, `smoke:phase13` against a running API.
