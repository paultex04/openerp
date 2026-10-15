# ADR-009: Job Management uses a server-searched register and dedicated job details

- **Status:** accepted
- **Date:** 2026-10-06
- **Supersedes:** nothing. Amends [ADR-003](adr-003-operations-engine.md) (the job
  detail screen) and [ADR-006](adr-006-enterprise-ui-overhaul.md) §on sidebar
  destinations.

## Context

Operations was three sidebar entries over one route with a `?view=` parameter:

| Entry             | View                                | What it was for                                       |
| ----------------- | ----------------------------------- | ----------------------------------------------------- |
| Projects Register | `?view=dashboard`                   | projects with per-status job counts and cost exposure |
| Jobs Board        | `?view=board`                       | a kanban by status, later a table                     |
| Valuation Packs   | `?view=board&status=07. Pack Ready` | a deep link to a pre-filtered board                   |

None of them answered the question the screen exists for — _here is job X, what is on
it and what does it cost_ — and the old drill-down destroyed your place in the list.
The separate detail screen did not preserve the register's filters or scroll position
when returning to the list.

The board was also already failing at three jobs. Thirteen statuses means thirteen
columns of horizontal scroll on a kanban, which ADR-007 had already replaced with a
table; the table then inherited a client-side search that would stop working at
exactly the scale a jobs register is built for.

## Decision

### Register plus dedicated detail route

`/operations` is **Job Management**, a full-width, server-searched register. Each job
opens at `/operations/[id]`, where the existing job summary and service-code line items
are reused. This gives each job a stable, shareable URL and keeps the detailed work
surface focused instead of squeezing it beneath the register.

### Register state is URL state; scroll is session state

Search, status, project, page, and page size are mirrored into `/operations` query
parameters. Opening a detail page carries those parameters along. Returning to the
register reconstructs its filters/page from the URL and restores its scroll position
from `sessionStorage`, so navigation does not restart the work queue at the top.

### The register searches and paginates on the server

`GET /api/jobs` gained `?search=`, `?page=` and `?pageSize=`, and returns
`total`/`page`/`pageSize` when paginated.

This is the one list in the application that does. Every other register fetches
everything and filters in the browser (`DataTable`'s documented design), which is the
right trade while the result fits in memory and wrong for a table that grows with every
job the company ever runs. The Jobs Board was unusable at three jobs; a jobs register
has to work at three thousand.

Two consequences, both load-bearing:

**An unpaginated call still returns every job.** `page` and `pageSize` must both be
supplied to paginate. `/field`, the dashboard and the smoke tests depend on the
unpaginated shape, and silently truncating their result to a default page size would be
data loss rather than an error. Asserted explicitly in `smoke-phase3`.

**Search terms are ANDed, not ORed.** Mirroring the client-side `matchesSearch`: every
whitespace-separated term must match _some_ field, so "pack sasol" narrows. A server
search that ORs its terms is worse than useless — it looks like narrowing and instead
widens the result.

### `DataTable` gains `manualPagination`, all-or-nothing

Server mode supplies all five of `pageIndex`, `pageSize`, `rowCount`,
`onPageIndexChange`, `onPageSizeChange`, or none of them. In that mode the table stops
filtering, sorting and slicing locally.

TanStack computes `rowCount` from the rows it holds, so a server-paged table reports
"page 1 of 1" forever unless told to trust `rowCount`. And mixing the modes is the
genuinely broken case: the search box would filter one page of a many-page result and
report a count unrelated to the total. Rather than produce wrong answers quietly, the
prop is refused unless the caller commits to server mode.

Sorting is disabled in server mode. Sorting one page locally produces an order that
contradicts every other page.

### Status is a dropdown over the state machine, not a free field

The screen was specified as a live system where jobs move constantly, so status is one
control rather than a stepper walked through several clicks. It is still the 13-step
state machine: the list is built from `GET /api/jobs/:id/transitions` and every move goes
through `POST /api/jobs/:id/transition`, which re-authorises per step.

All thirteen statuses are listed. The unreachable ones are **disabled**, with the
server's reason as the tooltip. Hiding them would make the machine's shape
undiscoverable; leaving them enabled would produce nine 409s. A terminal job says so in
prose next to a disabled control, because a permanently greyed-out box reads as a bug.

Note that this endpoint returns the machine's _legal neighbours_, not all thirteen
annotated. Absence is the meaningful case: a status not in the response is not
reachable. The first implementation inverted this and rendered every status enabled.

### Job metadata is one compact editable card

Description, work order and received date, purchase order and received date, supervisor,
client contact, amendment, area, priority, and planned/actual dates are consolidated in
one compact card and PATCH `/api/jobs/:id` on blur or change. Editor controls respect
`permissions.canEditJob`; picker choices are loaded from the corresponding contacts,
employees, and amendments endpoints when the viewer has read permission. Status is
excluded — it has its own endpoint and its own rules.

All inline editors share one mutation, so the toast wording, error handling and cache
invalidation are decided once. A per-field component that forgot to invalidate would
leave the panel showing a value the server had rejected.

The draft carries the server value it was seeded from and compares during render, rather
than syncing in an effect. An effect that syncs state runs _after_ the render that showed
the stale value, so the field visibly flickers; this way the first frame is correct. An
in-progress edit wins over an unrelated refetch.

### Line items: a read-only table, a dialog to edit, a picker to add

The second table shows each line's planned quantity, actual quantity, applied rate,
planned value, actual value and variance. Totals sit **above** the table, not in a
footer — a footer scrolls out of view, and the planned/actual comparison is the reason to
read the table at all.

Each line opens a dialog. This replaces inline quantity editing, which put an editable
number in a column of read-only figures with no visual distinction and no way to see a
line's whole state at once.

Planned and actual are edited through their own endpoints, because they have two
permissions and two lock rules. Only the changed one is PATCHed — sending both would
surface an error for the field the user did not touch. Lock reasons are shown next to a
disabled input rather than the input merely being greyed out.

**The applied rate is not editable**, and `rateHasDrifted` is surfaced as a read-only
warning instead. The rate is the price snapshot the job invoices at; changing it after
scoping would silently rewrite what was agreed with the client. The fix for drift is a
re-scope, not an edit here.

"Add line item" searches service codes **scoped to the job's resolved amendment**.
Service codes and rates are amendment-scoped and the server refuses a mismatch with
`AMENDMENT_MISMATCH`, so filtering in the picker means the user is never offered
something the server will reject. The _resolved_ amendment matters: a job with
`amendmentId: null` inherits its project's, and the detail endpoint already reports
which one it resolved to.

Quantity defaults to 1 and rate to the code's current calculated rate. Both are
editable — both are routinely overridden — but defaulting them makes the common case one
click instead of seven keystrokes.

### Deletions

Four components had no remaining caller and were deleted: `DeliverableGrid`,
`JobStepper`, `ProjectDashboard`, `CrewPanel`, plus `JobsPanel` and the `JOBS` resource
descriptor. `/field` never used `DeliverableGrid` — it has its own inline
actual-quantity input, sized for a phone — so it had nothing left to serve.

`amendmentOptionsFor` and `selectedId` moved to `master-data/columns.ts`, because the
projects panel needs the same dependent-picker behaviour and they were about to be
copied and drift.

## Consequences

**Better:** a job is directly linkable, its metadata and service lines have a focused
detail surface, and the register returns with its filters, page, and scroll position.
Search works at any scale; status is one control that still cannot bypass the state
machine.

**Worse:** opening a job leaves the register temporarily. The dashboard's two Operations
tiles now point at the same destination as each other, since the Projects Register is
gone — variance is read from the job's totals rather than a project rollup.

**Neutral:** `/operations?view=…` is now ignored. The old query parameters are not
redirected; anyone with a bookmark lands on the register, which is the destination they
wanted. The detail route's Back control returns to its carried register query state even
when the detail URL was opened directly.

## Verification

In-browser, on live data (contract `CW169692`, project `MT26-00195`, three jobs):

- register lists 3 jobs, search for `9844210` returns exactly 1, nonsense returns 0
- selecting job #1 shows its details with planned R 26 748,81 / actual R 26 784,45 /
  variance +R 35,64 — the acceptance vectors, unchanged
- the status dropdown offers 4 enabled and 9 disabled, matching
  `GET /api/jobs/1/transitions` exactly; job #2211 shows 1 enabled
- job #1 (Pack Ready): both quantity inputs disabled with lock reasons; job #2
  (Scoping): planned enabled, actual disabled
- add line item on job #2: picker showed 6 amendment-scoped codes, search narrowed,
  selecting one prefilled rate R 23 782,00, adding at qty 4 produced planned
  R 95 128,00 = 4 × 23 782,00; editing to qty 5 produced R 118 910,00; removing returned
  the job to zero lines, confirmed against `GET /api/jobs/2/deliverables`

Gates: `verify` exit 0 (177 shared + 140 server); smoke phase2 52, phase3 101, phase4
67, phase5 46, phase6 71, phase7 101 — all 0 failed; client build clean; `db:check` 25
tables / 8 enums.

Pricing data untouched: 12 cost parameters, 22 master rates, 6 service codes, 8 labour
items, 3 material items.
