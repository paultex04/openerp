# Deploying to Coolify

Two applications from one repository, both built from Dockerfiles. The API gets no
public domain: the web client proxies `/api/*` to it over Coolify's private network,
which keeps the session cookie first-party and means only one container needs TLS.

| Resource      | Buildpack     | Dockerfile       | Port | Domain              |
| ------------- | ------------- | ---------------- | ---- | ------------------- |
| `openerp-db`  | PostgreSQL 18 | managed          | 5432 | none                |
| `openerp-api` | Dockerfile    | `Dockerfile.api` | 4000 | **none**            |
| `openerp-web` | Dockerfile    | `Dockerfile.web` | 3000 | `erp.example.co.za` |

> **The API is not published.** Do not add a domain to `openerp-api`. Publishing it
> would expose the session cookie's origin and hand you a CORS surface you do not
> need.

---

## Why not Nixpacks

Nixpacks guesses monorepo workspace layout. This repository is three workspaces
sharing one hoisted `node_modules`, with a build step that has to run `prisma
generate` before the bundle, and a migration runner that is not Prisma's. Dockerfiles
state all of that explicitly.

## Do not deploy from `docker-compose.yml`

**Create two separate Applications using the Dockerfiles.** Do not point Coolify at
the Compose file.

Coolify offers "Docker Compose" and "Dockerfile" as separate base image types. Choosing
Compose makes Coolify build and manage all four services as one unit, which is not
what this document describes and does not match the runtime-variable table below:
Coolify injects build-time variables during `docker compose build` and expects runtime
variables per service, so `AUTH_JWT_SECRET` and `POSTGRES_PASSWORD` set only at build
time leave the containers without them and the API crash-loops on
`Invalid environment configuration`.

`docker-compose.yml` exists for **local parity only** — running the same two images
against a real Postgres on a laptop, so a deployment problem can be reproduced before
it reaches production.

### Choosing the right Coolify setup

| Coolify field           | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| Base image / Build Pack | **Dockerfile** (not "Docker Compose")                           |
| Dockerfile              | `/Dockerfile.api` for the API, `/Dockerfile.web` for the web    |
| Docker context          | `.` — the repo root, since the build needs the other workspaces |
| Docker Compose file     | leave empty                                                     |

---

## Before you start

**Rotate the demo accounts.** They share one `.env` password. This is the one thing
to fix before anything is reachable.

**Generate a JWT secret.** 32+ characters, or `loadConfig()` throws at boot and the
container crash-loops:

```bash
openssl rand -base64 48
```

Store it as a **runtime** variable in Coolify, never in the repository. Rotating it
later signs everyone out.

---

## 1. Create the database

1. **New Resource → Database → PostgreSQL 18**
2. Name it `openerp-db`.
3. Copy the internal connection URL. It looks like
   `postgresql://USER:PASSWORD@openerp-db:5432/openerp?schema=public`.
   Keep the password; you need it for the runtime variable.

## 2. Create the API

1. **New Resource → Application → Dockerfile**, pointing at this repository.
2. **Dockerfile**: `Dockerfile.api`
3. **Docker Context**: `.` (repository root — the build needs the other workspaces)
4. **Port**: `4000`
5. **Health check path**: `/health/ready`

   Use the readiness path, not `/health`. It actually probes Postgres, so a database
   blip is reported as degraded rather than silently passing. The container's own
   `HEALTHCHECK` uses `/health` on purpose — see "Health checks" below.

6. **No domain.** Leave it empty.
7. **Instances**: 1 for now.

### API runtime variables

| Variable              | Value                        |
| --------------------- | ---------------------------- |
| `NODE_ENV`            | `production`                 |
| `DATABASE_URL`        | the internal URL from step 1 |
| `AUTH_JWT_SECRET`     | your generated secret        |
| `AUTH_COOKIE_SECURE`  | `true`                       |
| `CLIENT_ORIGIN`       | `https://erp.example.co.za`  |
| `DEFAULT_CURRENCY`    | `ZAR`                        |
| `DEFAULT_VAT_RATE`    | `0.15`                       |
| `SEED_ADMIN_EMAIL`    | your real admin address      |
| `SEED_ADMIN_PASSWORD` | a strong password            |

### On `DATABASE_URL` and the Dockerfile

`Dockerfile.api` declares:

```dockerfile
ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"
ENV DATABASE_URL="${DATABASE_URL}"
```

That is an **inert placeholder**. It exists so `prisma generate` has something to
parse, and it will not connect from inside the image.

It is editable, and you can point a build anywhere by changing that one line — but
do not put a real password there. A value written into a Dockerfile is baked into an
image layer and stays readable in `docker history` to anyone who can pull the image.
The live credential arrives as the Coolify **runtime** variable, which overrides
whatever the Dockerfile says.

The web container deliberately has no database URL at all: it reaches Postgres only
through the API.

## 3. Create the web client

1. **New Resource → Application → Dockerfile**, same repository.
2. **Dockerfile**: `Dockerfile.web`
3. **Port**: `3000`
4. **Health check path**: `/login`
5. **Domain**: `https://erp.example.co.za` — generate a TLS certificate.
6. **Instances**: 1 to start.

### Web runtime variables

| Variable     | Value                     |
| ------------ | ------------------------- |
| `NODE_ENV`   | `production`              |
| `API_ORIGIN` | `http://openerp-api:4000` |

`API_ORIGIN` is a **server-side** variable, read per request by the proxy — not
inlined into the bundle. So you can change it without a rebuild, which is what a
private-network hostname should be.

Leave these **unset or empty**:

```
NEXT_PUBLIC_DEMO_LOGIN
NEXT_PUBLIC_DEMO_PASSWORD
NEXT_PUBLIC_DEMO_ADMIN_PASSWORD
```

`NEXT_PUBLIC_*` values are inlined into the JavaScript at build time. Setting
`NEXT_PUBLIC_DEMO_LOGIN=1` would publish the demo password in the page source. The
flag is off unless it is exactly `1`, and the seed refuses to create demo accounts
under `NODE_ENV=production` — this is the second lock on the same door.

## 4. Run the migrations — once

**Do not make this a boot step.** Two replicas or two restarts would migrate
concurrently.

Coolify has no one-off primitive, so deploy the API once first (it will start and
stay unhealthy until the schema exists), then run the migration from your machine
against the same database:

```bash
# From a checkout, on the same network as the database
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/openerp?schema=public" \
  npm run db:migrate -- --dry     # prints the plan, writes nothing
```

Then, once satisfied:

```bash
DATABASE_URL="..." npm run db:migrate
```

Or from the API container, which has the runner baked in:

```bash
docker exec -it <openerp-api-container> \
  node server/scripts/apply-migrations.mjs --dry
```

Use `npm run db:migrate`, not `prisma migrate deploy`. Deploy fails P3005 because
the baseline predates Prisma, and `migrate diff` is destructive. The runner is
transactional and records applied migrations in `schema_migration_ledger`, so
re-running is safe.

## 5. Seed the first administrator

Once, from a checkout:

```bash
DATABASE_URL="..." SEED_ADMIN_EMAIL="you@company.co.za" \
  SEED_ADMIN_PASSWORD="..." npm run seed --workspace server
```

The seed refuses to create demo accounts under `NODE_ENV=production`. Do not set
`SEED_DEMO_PASSWORD` for this run.

## 6. Deploy

Deploy `openerp-web`. It proxies to the API, so the API must be up first.

---

## Health checks

Two paths, deliberately different:

- `GET /health` — liveness. Returns `ok` without touching Postgres. The
  `HEALTHCHECK` in both Dockerfiles uses this, because a dependency health check
  that fails on a database blip makes the orchestrator restart healthy containers.
  That converts a recoverable outage into a crash loop.
- `GET /health/ready` — readiness. Runs `SELECT 1`. Point Coolify's _deployment_
  health check here.

## Troubleshooting

### Build failures

**`npm ci can only install packages when your package.json and package-lock.json are in sync`.**
The lockfile is stale. Run `npm install` and commit `package-lock.json`. Nothing fails
locally in this case, because `npm install` in a working tree reconciles the lock by
itself — only a clean `npm ci`, which is what the Dockerfiles do, notices. This
happened once: `esbuild` was added to `server/package.json` without regenerating the
lock, and it broke both images.

**`error TS5083: Cannot read file '/app/tsconfig.base.json'`.**
`tsconfig.base.json` is at the repository root and every workspace `tsconfig.json`
extends it. Both Dockerfiles now `COPY` it into their build stage; this error means
either that line is missing or the Docker context is not the repo root. Same
local-invisibility as above: the file is present on a checkout.

**A build fails in Docker but passes locally, with no useful message.**
Usually the lockfile or a missing `COPY`. Run `npm run check:docker` — it validates
the lockfile against every workspace manifest and asserts that each build stage copies
the files the build reads. It found both of the above.

### Runtime

**Every API request returns 502 `API_UNREACHABLE`.**
`API_ORIGIN` is wrong. `localhost` inside the web container is the web container.
It must be the API resource's service name: `http://openerp-api:4000`.

**Login sets a cookie, then the next request is unauthenticated.**
`AUTH_COOKIE_SECURE=true` over plain HTTP means the browser silently discards the
cookie. Terminate TLS at Coolify and serve the site over HTTPS.

**The API crash-loops at boot with `Invalid environment configuration`.**
A runtime variable is not reaching the container. `loadConfig()` throws and the
process exits deliberately rather than starting with a weak or missing secret, so
this is a refusal, not a crash. Read the logs: the message names the field, e.g.
`- AUTH_JWT_SECRET: Required`.

The usual cause is a variable set as a **build variable** rather than a runtime one.
Coolify passes build variables to `docker build` and never injects them into the
running container, so the image builds fine and then starts with nothing. Every
variable in this document belongs under Runtime Variables; there are no build
variables to set.

`AUTH_JWT_SECRET` needs 32+ characters, and `NODE_ENV=production` additionally
requires `AUTH_COOKIE_SECURE=true`. Both are enforced at boot.

**Coolify warns "the healthcheck needs a curl or wget command".**
Both images install `curl` and `wget`, so this should not appear. If it does, the
deploy is using a cached build from before that change — redeploy, or check the
Dockerfile on the branch being built. Coolify runs a healthcheck of its own inside
the container in addition to the image's own `HEALTHCHECK`.

**`PrismaClientInitializationError` / "did not initialize engine".**
`prisma generate` did not run, or ran on a different base image. All stages in
`Dockerfile.api` are deliberately the same `node:26-bookworm-slim`; mixing slim and
alpine is the usual cause.

**Migrations run twice, or the schema is half-applied.**
Something is starting migrations automatically. It must be a deliberate single
action — see step 4.

---

## Verifying a deploy

```bash
curl -fsS https://openerp-api:4000/health/ready          # {"status":"ready","database":"up"}
curl -fsS https://erp.example.co.za/login | head -20      # the sign-in page renders
```

Then sign in and check the acceptance values, which should be unchanged:

| Check       | Expected                                                     |
| ----------- | ------------------------------------------------------------ |
| `S00250451` | 227.61 ZAR/hr                                                |
| `S00247970` | 17.5226 ZAR/m                                                |
| Job 1       | planned R 26 748,81 / actual R 26 784,45 / variance +R 35,64 |

---

## Local parity

`docker-compose.yml` builds the same two images against a real Postgres, so a
deployment problem can be reproduced before it reaches production:

```bash
POSTGRES_PASSWORD=dev AUTH_JWT_SECRET=<32+ chars> docker compose up --build
```

Then, in another terminal:

```bash
docker compose --profile tools run --rm migrate
```

This is not a development stack — both services build and run exactly as they will
in Coolify. Development remains `npm run dev`.

## Deployment-file checks

```bash
npm run check:docker
```

Parses both Dockerfiles as instruction sequences, resolves every `COPY --from=` to a
declared stage, and asserts no literal database password can reach an image layer. It
exists because these files cannot be exercised without a Docker daemon, and a
malformed instruction is otherwise found only at deploy time.
