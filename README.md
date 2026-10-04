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

| Command               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `npm run db:check`    | Verify TCP + authenticated DB connectivity |
| `npm run verify`      | format + lint + typecheck + test           |
| `npm run test`        | Run all workspace test suites              |
| `npm run db:generate` | Regenerate the Prisma client               |
| `npm run db:push`     | Apply schema changes to the database       |
| `npm run seed`        | Provision default roles + super admin      |

## Branching and releases

Production code lives on `main`. Each phase is developed on a `phase/NN-*` branch and merged only
after its automated tests and verification gates pass:

| Branch                               | Tag      | Contents                              |
| ------------------------------------ | -------- | ------------------------------------- |
| `main`                               | `v0.0.1` | Repo init and connectivity            |
| `phase/01-db-auth-rbac`              | `v0.1.0` | Schema, migrations, auth, RBAC        |
| `phase/02-commercial-pricing-engine` | `v0.2.0` | Contracts, amendments, pricing engine |
| `phase/03-operations-lifecycle`      | `v0.3.0` | Projects, job lifecycle, actuals      |
| `phase/04-billing-invoicing`         | `v0.4.0` | Invoice lifecycle and billing         |
| `phase/05-admin-audit-hardening`     | `v1.0.0` | Admin suite, audit log, E2E           |

Commits follow Conventional Commits: `<type>(<scope>): <summary>`.

## Security notes

- `.env` is gitignored and must never be committed; `.env.example` holds placeholders only.
- Every application user is linked 1-to-1 to an `employee` record; there are no "orphan" accounts.
- Passwords are hashed with Argon2id. Sessions are issued as short-lived JWTs in HTTP-only cookies.
