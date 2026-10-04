# OpenERP

Type-safe ERP for an industrial **EC&I (Electrical, Control & Instrumentation)** contracting enterprise.
Covers contractual amendments, hourly rate-buildup mathematics, activity-based service codes with
labour recipes and material BOMs, planned-vs-actual job tracking, an invoice lifecycle, and RBAC.

## Stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Database | PostgreSQL 18 (`192.168.50.7:5432/openerp-dev`)                  |
| Backend  | Node.js + TypeScript, Fastify 5, Prisma 6, Zod, Vitest           |
| Frontend | Next.js 15 (App Router), React 19, Tailwind, shadcn/ui, TanStack |
| Shared   | Zod schemas + pure pricing / state-machine engines               |

## Repository layout

```
shared/   domain types, Zod schemas, pricing engine, job state machine (pure, isomorphic)
server/   Fastify REST API, Prisma schema/migrations, auth + RBAC guards, seed
client/   Next.js App Router UI
scripts/  operational tooling (db connectivity gate, env loader)
docs/     architecture and decision records
```

## Getting started

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

| Command                | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `npm run db:check`     | Verify TCP + authenticated DB connectivity |
| `npm run verify`       | format + lint + typecheck + test           |
| `npm run test`         | Run all workspace test suites              |
| `npm run db:generate`  | Regenerate the Prisma client               |
| `npm run db:push`      | Apply schema changes to the database       |
| `npm run seed`         | Provision default roles + super admin      |
| `npm run smoke:phase2` | HTTP smoke test against a running API      |
| `npm run smoke:phase3` | As above, for the operations surface       |
| `npm run smoke:phase4` | As above, for billing and invoicing        |
| `npm run smoke:phase5` | As above, for admin and the audit log      |

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

Leave it empty to use same-origin `/api/*` requests via the rewrite proxy in
`client/next.config.mjs`. Note that the proxy currently does not match, so direct calls are the
supported path.

With the API running, `npm run smoke:phase2` asserts both published pricing vectors (227.61 ZAR/hr
and 17.5226 ZAR/m) end-to-end over HTTP, together with the 401 paths and the cookie security
attributes.

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

## Branching and releases

Production code lives on `main`. Each phase is developed on a `phase/NN-*` branch and merged only
after its automated tests and verification gates pass:

| Branch                               | Tag      | Contents                                   |
| ------------------------------------ | -------- | ------------------------------------------ |
| `main`                               | `v0.0.1` | Repo init and connectivity                 |
| `phase/01-db-auth-rbac`              | `v0.1.0` | Schema, migrations, auth, RBAC             |
| `phase/02-commercial-pricing-engine` | `v0.2.0` | Contracts, amendments, pricing engine, VAT |
| `phase/03-operations-lifecycle`      | `v0.3.0` | Projects, job lifecycle, actuals           |
| `phase/04-billing-invoicing`         | `v0.4.0` | Invoice lifecycle and billing              |
| `phase/05-admin-audit-hardening`     | `v1.0.0` | Admin suite, audit log, E2E                |

The schema in `server/prisma/schema.prisma` is the source of truth, but the
migrations are hand-written and additive-only. `prisma migrate deploy` refuses
this database because the baseline predates Prisma, and
`prisma migrate diff --from-url` emits a destructive migration against it. Apply
a new migration's SQL and then `prisma generate`; see
[ADR-001](docs/adr-001-baseline-findings.md).

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
