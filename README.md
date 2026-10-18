# OpenERP

Type-safe ERP for an industrial **EC&I (Electrical, Control & Instrumentation)** contracting enterprise.
Covers contractual amendments, hourly rate-buildup mathematics, activity-based service codes with
labour recipes and material BOMs, planned-vs-actual job tracking, an invoice lifecycle, and RBAC.

## Stack

| Layer    | Technology                                                                       |
| -------- | -------------------------------------------------------------------------------- |
| Database | PostgreSQL 18 (`192.168.50.7:5432/openerp-dev`, `postgres:18-alpine` in Compose) |
| Backend  | Node.js 26 + TypeScript 7, Fastify 5, Prisma 7, Zod 4, sharp, Vitest 5           |
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui (Base UI), TanStack    |
| Shared   | Zod schemas + pure pricing / state-machine engines                               |

Exact versions live in the four `package.json` files; this table names the lines.

### Version notes

Four of these are majors whose migration is not a version bump, and each has a
note somewhere it can be found again:

- **Prisma 7** is Rust-free and requires a driver adapter. The client is generated
  to `server/src/generated/prisma` (gitignored) by `generator client { provider =
"prisma-client" }`, the connection string moved out of `schema.prisma` into
  `server/prisma.config.ts`, and the runtime uses `@prisma/adapter-pg` over `pg`.
  There is no `query_engine` binary any more, which is why the Dockerfiles no
  longer need to regenerate an engine for the runtime platform.
- **TanStack Table 9** replaced `useReactTable`/`getCoreRowModel` with `useTable`
  and an explicit feature set built by `tableFeatures({ ... })`. Registering a
  feature is what makes its options and column properties exist, so a missing
  feature is a type error rather than a silent no-op. `ColumnDef` also gained a
  leading feature-set generic, which is why the register column arrays are typed
  `ColumnDef<any, Row, unknown>` — see the note in
  `client/src/components/data-table/data-table.tsx`.
- **Next 16** builds with Turbopack by default, and that is now the build. Until
  Phase 14 the build passed `--webpack` because `@openerp/shared` used explicit
  `.js` specifiers on some relative imports, which Turbopack has no
  `resolve.extensionAlias` equivalent to resolve (vercel/next.js#82945). The
  shared package now uses extensionless imports only, both builders resolve them,
  and the `webpack()` hook is gone. `npm run build:webpack --workspace client`
  remains as a fallback; `npm run check:docker` pins both script names.
  `middleware.ts` was also renamed to `proxy.ts` in Phase 14 (the Next 16
  convention, applied via the official codemod).
- **TypeScript 7** has no compatible `typescript-eslint`: the current release
  (8.71.2, re-checked at Phase 14) still declares `typescript >=4.8.4 <6.1.0` and
  throws at import time under TS 7. ESLint therefore reads only JavaScript, and
  **oxlint** is the gate that covers `.ts`/`.tsx` — it parses TypeScript itself, so
  it does not care which compiler version the repo uses. `npm run lint` runs both.
  `npm run typecheck` remains the only type-aware check. Re-add
  `typescript-eslint` once it supports TS 7; keep the oxlint layer either way.

## Repository layout

```
shared/   domain types, Zod schemas, pricing engine, job state machine (pure, isomorphic)
server/   Fastify REST API, Prisma schema/migrations, auth + RBAC guards, seed
client/   Next.js App Router UI
scripts/  operational tooling (db connectivity gate, env loader)
docs/     architecture and decision records
```

## Getting started

Node **26** is required (`engines` enforces it, and both Dockerfiles build on
`node:26-bookworm-slim`).

```bash
npm install
cp .env.example .env      # then fill in DB_PASSWORD and the AUTH_* secrets
npm run db:check          # TCP + authenticated connectivity gate
```

Generate auth secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Scripts

| Command                      | Purpose                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `npm run db:check`           | Verify TCP + authenticated DB connectivity                                   |
| `npm run verify`             | format + lint (ESLint + oxlint) + typecheck + schema check + test            |
| `npm run verify:ci`          | `verify` minus the suites that need the seeded business baseline (CI gate)   |
| `npm run test`               | Run all workspace test suites                                                |
| `npm run db:generate`        | Regenerate the Prisma client                                                 |
| `npm run db:push`            | Apply schema changes to the database                                         |
| `npm run db:studio`          | Open Prisma Studio against the configured database                           |
| `npm run db:migrate`         | Apply the hand-written SQL migrations — building an empty database first     |
| `npm run db:schema:write`    | Regenerate `server/prisma/schema.sql` from `schema.prisma`                   |
| `npm run db:schema:check`    | Prove `schema.sql` has not drifted from `schema.prisma`                      |
| `npm run db:restore-fixture` | Restore the seeded fixture rows the suites mutate (the seeded invoice)       |
| `npm run seed`               | Provision default roles + super admin                                        |
| `npm run smoke:phase2`       | HTTP smoke test against a running API                                        |
| `npm run smoke:phase3`       | As above, for the operations surface                                         |
| `npm run smoke:phase4`       | As above, for billing and invoicing                                          |
| `npm run smoke:phase5`       | As above, for admin and the audit log                                        |
| `npm run smoke:phase6`       | As above, for routing, nav and RBAC (needs **both** API and web up)          |
| `npm run smoke:phase7`       | As above, for master-data CRUD and archiving                                 |
| `npm run smoke:phase13`      | As above, for the Phase 13 register/RBAC surfaces                            |
| `npm run check:docker`       | Validate the Dockerfiles and Compose stack (no daemon required)              |
| `npm run self-host`          | Build the Compose stack, start it, migrate and seed — the one-command deploy |

## Running the stack

Two terminals:

```bash
# API on http://localhost:4000
npm run dev --workspace server

# Web client on http://localhost:3000
npm run dev --workspace client
```

Then open <http://localhost:3000/login> and sign in with the seeded administrator
(`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`).

**How the browser reaches the API.** Set `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` and the
client calls the API directly. This is safe because `localhost:3000` and `localhost:4000` are the
same _site_ — the port is not part of the site calculation — so a `SameSite=Lax` session cookie is
still sent, and the API allows the origin via `CLIENT_ORIGIN` with `credentials: true`.

Leave it empty to use same-origin `/api/*` requests, which are served by the Route Handler at
`client/src/app/api/[...path]/route.ts`. That is the supported path; direct calls to the API's
absolute origin are also supported (see the paragraph above), but the path is not a rewrite proxy.

With the API running, `npm run smoke:phase2` asserts both published pricing vectors (227.61 ZAR/hr
and 17.5226 ZAR/m) end-to-end over HTTP, together with the 401 paths and the cookie security
attributes.

## Continuous integration

`.forgejo/workflows/verify.yml` runs on every push and pull request against a disposable
`postgres:18-alpine` service container that is schema-synced (`db:push`) and seeded from scratch on
each run.

It runs `npm run verify:ci`, which is `verify` minus three test files — `commercial`, `billing` and
`operations`. Those suites assert against the seeded **business baseline** (the contract chain, the
service rates and codes, and the legacy invoice `INV-2026-03-0042`), which exists only in the
development database: it predates Prisma and no artifact in this repository recreates it, so on a
fresh database the suites fail for lack of data rather than for lack of correctness. CI therefore
covers format, ESLint, oxlint, typecheck and the other six test files — the audit gates and the
business-flow E2E included — and `npm run verify` remains the full gate to run locally. When a
committed baseline-fixture provisioner exists, the workflow can switch to plain `verify`.

## Design notes worth knowing

**Pricing.** The arithmetic lives in `shared/src/pricing/` as pure functions used by _both_ the API
and the browser, so the inline build-up preview is produced by the same code that persists the
figure. See [ADR-002](docs/adr-002-pricing-engine.md) for the full rationale.

- `overhead_cost` / `sga_cost` on a rate card are **authoritative**. They are seeded from the
  amendment's cost parameters only when a rate card is created and are not recomputed afterwards.
  Recomputing them from the 7% / 15% parameters yields 226.72, not the published 227.61.
- Recomputing a service code **never** overwrites a stored rate that disagrees. The variance is
  returned, and accepting it is a separate explicit action.
- Percentages are **fractions** in the engine (0.07 = 7%). The baseline database is inconsistent
  here: `contract_cost_parameters.numeric_value` holds percent numbers while `*_pct` columns hold
  fractions. `readCostParameters` normalises on read, because reading it wrong inflates a rate
  roughly tenfold.
- Money is rounded half-away-from-zero to 2dp; unit rates to 4dp, which `S00247970` at 17.5226
  requires.

**Database.** Migrations are hand-written and additive only. Do **not** generate them with
`prisma migrate diff` against this database: the baseline was not created by Prisma and the
generated migration is destructive. See
[ADR-001](docs/adr-001-baseline-findings.md).

**Frontend design system.** There is **no `tailwind.config.ts`** — Tailwind v4 is
CSS-first, and the theme lives in `client/src/app/globals.css`, where `@theme inline` maps the
`:root` tokens onto utilities. Two rules matter:

- `client/src/components/ui/` is owned by the shadcn registry and is replaced wholesale by
  `shadcn add --overwrite`. It is excluded from lint for that reason. Anything OpenERP adds on
  top of it must live **outside** that directory, or the next component update deletes it.
  (oxlint also excludes that directory, so the exclusion holds for the TypeScript lint layer
  too.)
- shadcn's base here is **Base UI**, so components take a `render` prop rather than Radix's
  `asChild`. The two are not interchangeable, and `asChild` is a type error rather than a soft
  failure.

**Colour and themes.** Five themes — Harbour (default), Steel, Ember, Verdant and
Midnight (dark) — chosen from the palette icon in the header or on the sign-in screen. A theme
is a `[data-theme='<id>']` block of custom-property overrides in `globals.css`; switching one
attribute on `<html>` restyles everything, including the sidebar, badges, tables and focus rings.
The choice persists per device.

The consequence to respect: **never hardcode a colour.** A literal `bg-amber-50` or
`text-red-700` ignores the palette and looks wrong under four of the five themes. Use the
semantic tokens, and `--success` / `--warning` / `--info` / `--positive` / `--negative` for
status. `smoke-phase6.mjs` Gate 7 asserts every theme is chromatic, precisely so a near-grey
`--primary` cannot come back unnoticed.

The application shell, navigation and RBAC filtering are documented in
[ADR-006](docs/adr-006-enterprise-ui-overhaul.md), which also records the browser-only defects
found during the UI pass — including the two found by _using_ the app: a dropdown that crashed
the page on open, and the fact that `--primary` was near-black, which is why the UI looked
colourless.

## Branching and releases

Production code lives on `main`. Each phase is developed on a `phase/NN-*` branch and merged only
after its automated tests and verification gates pass:

| Branch                                | Tag      | Contents                                                                   |
| ------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `main`                                | `v0.0.1` | Repo init and connectivity                                                 |
| `phase/01-db-auth-rbac`               | `v0.1.0` | Schema, migrations, auth, RBAC                                             |
| `phase/02-commercial-pricing-engine`  | `v0.2.0` | Contracts, amendments, pricing engine, VAT                                 |
| `phase/03-operations-lifecycle`       | `v0.3.0` | Projects, job lifecycle, actuals                                           |
| `phase/04-billing-invoicing`          | `v0.4.0` | Invoice lifecycle and billing                                              |
| `phase/05-admin-audit-hardening`      | `v1.0.0` | Admin suite, audit log, E2E                                                |
| `phase/06-enterprise-ui-overhaul`     | `v1.1.0` | App shell, command centre, shadcn, UI pass                                 |
| `phase/06-theming-and-menu-fix`       | `v1.2.0` | Five themes, shared DataTable, full-bleed                                  |
| `phase/07-master-data-crud`           | `v1.3.0` | CRUD for every master-data table, schema amendments, Job Management        |
| `phase/09-container-deployment`       | `v1.4.0` | Container images, production API build, Coolify runbook                    |
| `phase/10-invoicing-workflow`         | `v1.5.0` | Invoicing workflow UI: raise a draft from a job, manual add                |
| `phase/11-data-import`                | `v1.6.0` | Spreadsheet template, dry-run validation, apply                            |
| `phase/12-dependency-upgrades`        | `v2.0.0` | Next 16, Prisma 7, TypeScript 7, Node 26 and the rest of the majors        |
| `phase/13-workflow-and-operations-ux` | `v2.1.0` | Amendments, RBAC editing, invoice register popup, job detail route         |
| `phase/14-hardening-and-automation`   | `v2.1.1` | Proxy rename, Turbopack default, version source, admin locking, oxlint, CI |
| `phase/15-job-management-and-ux`      | `v2.2.0` | Job workflow editor, invoices from the register, My Profile, DataTable fit |
| `phase/16-timesheets`                 | `v2.3.0` | Timesheets, week approval, employee-rate labour costing, job margin        |

Phases 7 and 8 shipped together in `v1.3.0`: Phase 7 is
[ADR-007](docs/adr-007-master-data-crud.md) — the API supported creating contracts,
amendments, clients, projects and jobs while the UI exposed none of it, and four
tables (Broker, EmployeeContractType, Employee, Contact) had no routes at all — plus
a rebuild of Operations into the single Job Management page. Phase 8 is the schema
work drawn up from
[phase-07-database-amendments.md](docs/phase-07-database-amendments.md): ten
scenarios costed and risk-ranked, of which items 1, 3, 4, 5 and 6 were implemented.
See [ADR-008](docs/adr-008-schema-amendments.md) and
[ADR-009](docs/adr-009-job-management.md).

Phase 9 is deployment. It started by finding that the API had no production build at
all: `server/package.json` claimed `node dist/index.js`, but the `build` script ran
`tsc` against a `noEmit` tsconfig, so `dist/` had never existed and the API had only
ever run under `tsx`. Phase 9 adds an esbuild bundle, two Dockerfiles, a
`.dockerignore` and a local-parity Compose stack. There are two deployment runbooks,
sharing the same images and environment contract:
[docs/self-hosting.md](docs/self-hosting.md) for the whole stack on one host behind
Caddy, and [docs/coolify-deployment.md](docs/coolify-deployment.md) for Coolify.
`npm run check:docker` validates the deployment files without needing a Docker daemon.

Phases 10–13 followed the deployment work. Phase 10 (`v1.5.0`) made the Billing
screen usable: a draft invoice can be raised from a job or added by hand on the
register, and job creation was restored there. Phase 11 (`v1.6.0`) added the
spreadsheet importer — template generated from the schema, dry-run validation,
explicit `--apply` — see [ADR-010](docs/adr-010-data-import.md). Phase 12
(`v2.0.0`) moved the whole stack to its current majors: Next 16, Prisma 7,
TypeScript 7, Node 26. Phase 13 (`v2.1.0`) is the workflow and operations UX
pass: amendment type/status edits persist, the five contract types are seeded,
users link to a real employee (or create one atomically), non-administrator
role grants are editable while `admin.*` stays locked, the invoice register is
full-width with an invoice-number detail popup, and job detail is a separate
route with URL-backed register state — see
[phase-13-workflow-and-operations-ux.md](docs/phase-13-workflow-and-operations-ux.md).
Phase 14 (`v2.1.1`) closed the post-Phase 13 review: the route guard is now
`proxy.ts`, Turbopack is the default builder again with a webpack fallback,
`/health` reports the one version source, administrator mutations serialise on
row locks, oxlint joins ESLint, and CI runs the gates against a disposable
database. Phase 15 (`v2.2.0`) is the job management and UX pass: the job
workflow becomes administrator-editable data
([ADR-011](docs/adr-011-job-workflow-editor.md)), a draft invoice can be raised
from the register, the job detail summary follows the agreed mock, the Field
Measurements page is retired (its API stays), every DataTable fits its screen,
and a My Profile screen adds avatar upload — see
[phase-15-job-management-and-ux.md](docs/phase-15-job-management-and-ux.md).
Phase 16 (`v2.3.0`) adds the Timesheets module: a separate top-level section where
hours are recorded against jobs on a week grid, for a **selected employee**, and
approved whole-week by any project manager, commercial or administrator — including
their own week. Each hour costs that **employee's own rate**, frozen when the week is
approved; an approved week can be corrected by reopening it or, by an approver,
amending a line in place. That cost, with materials and the job's work-done revenue,
feeds a profit-per-job register and a Labour & margin panel on the job — computed on
read, with no cache to go stale. Hours never write a deliverable, an actual or an
invoice; see [ADR-012](docs/adr-012-timesheets-and-costing.md) and
[phase-16-timesheets.md](docs/phase-16-timesheets.md).

**Migrations.** `prisma migrate deploy` cannot be used here — the baseline predates
Prisma, so it fails P3005 — and `prisma migrate diff --from-url` emits a
destructive migration. Apply them with `npm run db:migrate` instead: one command, in
order, once each, one transaction per migration, with a ledger and change
detection. See ADR-008 D3. In a container this must be a deliberate one-off, never a
boot step — two replicas migrating concurrently leaves a half-applied schema.

**Two kinds of database, and only one of them can run those migrations.** The
original database carries a baseline this repository does not create, and
`0001_auth_rbac` extends it — `app_user.employee_id` is a foreign key to `employee`.
On an empty database the first migration therefore fails with `relation "employee"
does not exist`, which reads like a broken migration rather than a database that has
not been built yet. A new database is built from `schema.prisma`, the same diff
`prisma db push` applies in CI, and the migrations are then recorded as _already
present_, because that schema already contains them. `npm run db:migrate` does both
in one transaction and refuses to touch a database that already has a schema;
`node server/scripts/apply-migrations.mjs --init` asks for that explicitly.

The DDL it applies is committed as `server/prisma/schema.sql`, generated from
`schema.prisma`. Committed rather than generated during the image build, because the
API runtime image installs with `--omit=dev` and has no Prisma CLI to generate it
with. `npm run db:schema:check` — part of `verify` — fails if the two drift apart, and
`npm run db:schema:write` regenerates the file after a schema change.

The schema in `server/prisma/schema.prisma` is the source of truth, but the
migrations are hand-written and additive-only. Apply a new migration's SQL and then
`prisma generate`; see [ADR-001](docs/adr-001-baseline-findings.md).

Commits follow Conventional Commits: `<type>(<scope>): <summary>`.

## Security notes

- `.env` is gitignored and must never be committed; `.env.example` holds placeholders only.
- Every application user is linked 1-to-1 to an `employee` record; there are no "orphan" accounts.
- Passwords are hashed with bcrypt. Sessions are issued as short-lived JWTs in HTTP-only cookies.
  (Argon2id was the original intent; bcrypt was chosen in ADR-002 to avoid native
  builds in every environment. Revisit if Argon2 becomes available without one.)
- Every write to application data is recorded in an append-only audit log, naming
  the actor, the action, the changed fields, the route and the request. See
  [ADR-005](docs/adr-005-admin-audit-hardening.md).
- **Dependency advisories** are reviewed with `npm audit`. Phase 14 closed the
  server/runtime tree with `overrides` in the root manifest (`mysql2 ^3.24.6`,
  `deepmerge-ts ^8.0.2`, both transitive under `prisma`). Two dev-only chains
  remain open, and both are upstream-blocked rather than ignored:
  - `braces` (via `micromatch` → `fast-glob` → `@shadcn/registry` → `shadcn`, a
    devDependency used only by the component-registry CLI). The advisory covers
    **every published version** — there is no fixed release to move to.
  - `uuid` (via `exceljs`, used only by the import script, which calls `v4()`
    with no buffer; the advisory affects v3/v5/v6 **with** a `buf` argument).
    The fix is a semver-major `overrides` jump (uuid 8 → 14) under a package
    that pins `^8`, which needs exceljs re-validated first.
    Both are `npm audit fix --force` bait: it "resolves" them by downgrading
    `shadcn` to 1.0.0 and `exceljs` to 3.4.0. Do not run it. Re-check with every
    dependency phase.
