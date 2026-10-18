# Deploying to Coolify

Two applications from this one repository, both built from Dockerfiles, plus one
Coolify-managed database. The API gets **no** public domain: the web client proxies
`/api/*` to it over Coolify's private Docker network, which keeps the session cookie
first-party and means only one container needs TLS.

| Resource      | Build pack    | Dockerfile        | Port | Domain                      |
| ------------- | ------------- | ----------------- | ---- | --------------------------- |
| `openerp-db`  | PostgreSQL 18 | managed           | 5432 | none                        |
| `openerp-api` | Dockerfile    | `/Dockerfile.api` | 4000 | **none**                    |
| `openerp-web` | Dockerfile    | `/Dockerfile.web` | 3000 | `https://erp.example.co.za` |

> **The API is not published.** Do not add a domain to `openerp-api`. Publishing it
> would expose the session cookie's origin and hand you a CORS surface you do not
> need. All browser traffic goes through `openerp-web`.

This guide is written against the current Coolify documentation
(<https://coolify.io/docs/>). Where a Coolify setting name is quoted, it is the
label you will see in the dashboard.

---

## Dockerfile applications, or the Compose build pack?

Both work. They are different shapes and the choice changes almost every step below,
so pick one before you start.

**Two Applications — the rest of this page.** A managed Postgres, an API Application
and a web Application, each on the **Dockerfile** build pack. Coolify clones the
repository for each, so build contexts are the ordinary ones and every service gets
its own logs, terminal, health check and rollback.

**The Compose build pack.** One resource, built from
[`docker-compose.coolify.yml`](../docker-compose.coolify.yml) — note that it is _not_
`docker-compose.yml`. Four rules apply, and the last two are why a first attempt
normally fails:

1. **It must be a Git-based Application, not a pasted definition.** Coolify's
   "Docker Compose Empty" path creates a Service that "has no Git source", so
   `build:` can never resolve. See [step 8](#8-alternative-the-compose-build-pack).
2. **No `caddy` service.** Coolify's proxy already owns ports 80 and 443 on the
   host; a second process binding them fails and rolls the deploy back.
3. **No published ports.** A published host port bypasses Coolify's proxy routing.
4. **`Preserve repository during deployment` should be on**, so the repository is
   present in the deployment directory at build time.

Full instructions: [the Compose build pack](#8-alternative-the-compose-build-pack).

**Not Nixpacks.** Nixpacks guesses monorepo workspace layout. This repository is
three workspaces sharing one hoisted `node_modules`, with a build step that must run
`prisma generate` before the bundle, and a migration runner that is not Prisma's.
The Dockerfiles state all of that explicitly.

---

## 0. Prerequisites — Coolify on a Proxmox LXC

Coolify runs Docker. **Docker inside an LXC needs nesting enabled.** Without it the
Docker daemon fails to start with obscure cgroup errors, and nothing you do in the
Coolify UI will help.

### Create the LXC

Unprivileged, with `nesting` (and `keyctl`) enabled — in the Proxmox UI, **Create CT**,
then under **Options → Features** tick **nesting** and **keyctl**. The equivalent
`pct` command is:

```bash
pct create 200 local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst \
  --hostname coolify \
  --cores 4 \
  --memory 8192 \
  --swap 2048 \
  --rootfs local-lvm:60 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1,keyctl=1
pct start 200 && pct enter 200
```

Sizing matters more than usual because **image builds run on this container**, not on
your laptop: `npm ci` for three workspaces plus a Next production build plus esbuild.
**4 cores / 8 GB RAM / 60 GB on SSD** is the working floor. A 20 GB disk will fill up
mid-build and the failure will look like a build error rather than a disk error.

> An unprivileged LXC with nesting is the safer arrangement. Do not reach for a
> privileged container to "fix" Docker — it makes the container's root the host's
> root. Nesting is the requirement; privilege is not.

Give the container a **stable IP** (a DHCP reservation or a static address). The
domain's DNS record and TLS issuance both point at it, so an address that moves
breaks both.

There are two supported ways to install Coolify:

**A — the Proxmox community script** (creates the container and installs Coolify in
one step). From the Proxmox host shell:

```bash
bash -c "$(curl -fsSL https://github.com/community-scripts/ProxmoxVE/raw/main/ct/coolify.sh)"
```

**B — manually**, inside the container you created above. Confirm Docker works
_before_ installing Coolify:

```bash
apt update && apt install -y curl ca-certificates
docker run --rm hello-world          # must print "Hello from Docker!"
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

The dashboard comes up at `http://<container-ip>:8000` — open it, create the first
Coolify admin account, and finish the setup wizard.

### Before you create any resource

- **Rotate the demo accounts.** They share one `.env` password. This is the one thing
  to fix before anything is reachable.
- **Generate a JWT secret.** 32+ characters, or `loadConfig()` throws at boot and the
  container crash-loops. Store it as a **runtime** variable in Coolify:

  ```bash
  openssl rand -base64 48
  ```

  Rotating it later signs everyone out.

- **Decide on a domain and TLS** before deploying the web app. TLS is not optional
  here — see [step 4](#4-tls-on-a-homelab-network).

---

## 1. Create the project and the database

1. **New Project** (name it anything, e.g. `OpenERP`). Coolify places the project's
   resources on the server's shared Docker network, `coolify`, which is where the
   API, web and database will find each other. Resources in _different_ projects
   cannot resolve each other by name, so keep all three together.
2. **New Resource → Databases → PostgreSQL**. Coolify defaults to the PostgreSQL 18
   image, which matches this project's development database (18.6).
3. Select the **server** and the default **destination** (`coolify`).
4. Name it **`openerp-db`**. Keep the generated username, password and database.
5. **Start** it and wait until it is running and healthy.
6. On the database's **General** page, copy the **Postgres URL (internal)**. It looks
   like:

   ```
   postgresql://USER:PASSWORD@openerp-db:5432/postgres?schema=public
   ```

   The host is the resource name, `openerp-db`, and it resolves **only** inside the
   `coolify` network. That is exactly what the API will use.

You do **not** need to expose the database publicly. Migrations and the seed are run
from inside the API container (steps 5 and 6), so port `5432` can stay private for the
life of the deployment.

---

## 2. Create the API application

**New Resource → Application**, pointing at this repository. The repository is
private, so connect it with a **deploy key** (read-only) or a Git App; a plain public
URL will not authenticate.

| Coolify field                   | Value                                                             |
| ------------------------------- | ----------------------------------------------------------------- |
| **Build pack** / Build strategy | **Dockerfile**                                                    |
| **Base Directory**              | `/` — the repo root, because the build reads the other workspaces |
| **Dockerfile Location**         | `/Dockerfile.api`                                                 |
| **Ports Exposes**               | `4000`                                                            |
| **Domain**                      | _leave empty_                                                     |
| **Instances**                   | `1`                                                               |
| **Healthcheck**                 | _leave disabled_ — see the note below                             |

The process already listens on `0.0.0.0:4000` (the image sets `API_HOST=0.0.0.0` and
`API_PORT=4000`), which is what the "listens on `0.0.0.0`, not `127.0.0.1`"
requirement demands.

### Health checks: leave Coolify's switched off

`Dockerfile.api` carries its own `HEALTHCHECK` hitting `GET /health` (a liveness check
that does **not** touch Postgres, so a database blip cannot make Docker restart a
healthy container). When a Dockerfile defines `HEALTHCHECK`, Coolify **detects it and
uses it instead of** a dashboard-configured check — so leave the **Healthcheck** page
disabled and do not "fix" it.

Two endpoints exist, deliberately different:

- `GET /health` — liveness. Returns `ok` without touching Postgres. This is what the
  image `HEALTHCHECK` uses, and therefore what Docker and Coolify use.
- `GET /health/ready` — readiness. Runs `SELECT 1`. Use this by hand to check that
  the API can see the database: `curl -fsS http://openerp-api:4000/health/ready`.

Pointing the container healthcheck at `/health/ready` instead would turn a brief
database outage into a crash loop, so it is deliberately not the default.

### API runtime variables

**Environment Variables → Normal view.** Coolify's "Build time" and "Runtime" are two
independent dropdowns, and new variables default to _both_. What matters is that
**Runtime is "Available in the container"** for every row; whether the value is also
available at build time is irrelevant here (there are no build arguments to feed).
A variable set with Runtime _disabled_ is the classic cause of the crash loop
described in Troubleshooting.

| Variable              | Value                                    |
| --------------------- | ---------------------------------------- |
| `NODE_ENV`            | `production`                             |
| `DATABASE_URL`        | the internal URL copied in step 1        |
| `AUTH_JWT_SECRET`     | your generated secret (32+ characters)   |
| `AUTH_COOKIE_SECURE`  | `true`                                   |
| `CLIENT_ORIGIN`       | `https://erp.example.co.za`              |
| `DEFAULT_CURRENCY`    | `ZAR`                                    |
| `DEFAULT_VAT_RATE`    | `0.15`                                   |
| `SEED_ADMIN_EMAIL`    | your real admin address (used in step 6) |
| `SEED_ADMIN_PASSWORD` | a strong password (used in step 6)       |

`DEFAULT_CURRENCY` and `DEFAULT_VAT_RATE` have code defaults; set them anyway so the
deployed behaviour does not depend on a default that could move.

`NODE_ENV=production` additionally requires `AUTH_COOKIE_SECURE=true`, and
`AUTH_JWT_SECRET` must be at least 32 characters. Both are enforced at boot — that is
the whole point of validating config once and refusing to start.

### On `DATABASE_URL` and the Dockerfile

`Dockerfile.api` declares an inert placeholder:

```dockerfile
ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"
```

It exists so `prisma generate` has something to parse and nothing more. It will not
connect from inside the image, and a real credential must **never** be written there:
a value in a Dockerfile is baked into an image layer and stays readable in
`docker history`, to anyone who can pull the image. The live credential arrives as the
Coolify **runtime** variable, which overrides the placeholder.

The web container deliberately has no database URL at all: it reaches Postgres only
through the API.

---

## 3. Create the web application

**New Resource → Application**, same repository, same deploy key.

| Coolify field                   | Value                                                |
| ------------------------------- | ---------------------------------------------------- |
| **Build pack** / Build strategy | **Dockerfile**                                       |
| **Base Directory**              | `/`                                                  |
| **Dockerfile Location**         | `/Dockerfile.web`                                    |
| **Ports Exposes**               | `3000`                                               |
| **Domain**                      | `https://erp.example.co.za`                          |
| **Healthcheck**                 | _leave disabled_ (image `HEALTHCHECK` hits `/login`) |
| **Instances**                   | `1`                                                  |

### Web runtime variables

| Variable     | Value                     |
| ------------ | ------------------------- |
| `NODE_ENV`   | `production`              |
| `API_ORIGIN` | `http://openerp-api:4000` |

`API_ORIGIN` is a **server-side** variable, read by the Next.js route handler
(`client/src/app/api/[...path]/route.ts`) on each request — not inlined into the
bundle. You can change it without a rebuild, which is what a private-network hostname
should be.

`openerp-api` here is **the API application's Name**. Coolify attaches each resource
to the shared `coolify` network with a network alias, so a container resolves its
peers by that name. If the name you gave the API differs, use yours. To confirm the
name resolves, open the **web** container's Terminal (step 7) and run:

```bash
getent hosts openerp-api || curl -fsS http://openerp-api:4000/health
```

If it does not resolve, list the containers on the host instead:

```bash
# on the LXC shell, outside Docker
docker ps --format '{{.Names}}' | grep -i openerp
```

Any name in the shared network's DNS works; the resource Name is the readable one.

### Leave these unset or empty

```
NEXT_PUBLIC_DEMO_LOGIN
NEXT_PUBLIC_DEMO_PASSWORD
NEXT_PUBLIC_DEMO_ADMIN_PASSWORD
NEXT_PUBLIC_API_BASE_URL
```

`NEXT_PUBLIC_*` values are inlined into the JavaScript at build time. Setting
`NEXT_PUBLIC_DEMO_LOGIN=1` would publish the demo password in the page source. The
flag is off unless it is exactly `1`, and the seed refuses to create demo accounts
under `NODE_ENV=production` — the second lock on the same door.

The client needs no public configuration at all: it calls `/api/*` on its own origin
and the proxy forwards to `API_ORIGIN`.

---

## 4. TLS on a homelab network

**You must serve the site over HTTPS.** `AUTH_COOKIE_SECURE=true` makes the browser
silently discard the session cookie over plain HTTP, so login appears to work and
every following request is unauthenticated. In production the API refuses to start
unless the flag is `true`, so HTTP-only is not an option.

Coolify's default is the Traefik **HTTP challenge**, which validates a certificate by
fetching `http://<domain>/.well-known/acme-challenge/...` from the public internet.
That needs **ports 80 and 443 forwarded to the LXC**. If your lab is reachable that
way, add `https://erp.example.co.za` on the web app, point a DNS `A` record at the
LXC, and you are done.

If the lab is **not** exposed to the internet, use the **DNS challenge** instead. It
proves domain control with a temporary `_acme-challenge` TXT record, so no inbound
port is needed. In Coolify: **Servers → your server → Proxy → Configuration**, keep
the existing Traefik config, add your provider's credentials under `environment`, and
swap the two `httpchallenge` flags for `dnschallenge`. Cloudflare example:

```yaml
services:
  traefik:
    environment:
      - CF_DNS_API_TOKEN=<cloudflare-api-token>
    command:
      # Keep the other existing command values.
      - '--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare'
      - '--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=0'
      - '--certificatesresolvers.letsencrypt.acme.storage=/traefik/acme.json'
```

Save, **Restart Proxy**, then redeploy the web app to trigger issuance. For a
`*.example.com` wildcard (one certificate for every app in the lab), add the
wildcard dynamic configuration described in Coolify's _Wildcard Certificates_ page.

Whichever you choose, the browser still has to resolve `erp.example.co.za` to the
LXC. On a LAN that means a local DNS record (Pi-hole, AdGuard, your router) or a hosts
file entry; the public `A` record can point at the LXC's LAN address if only you use
it.

> `sslip.io` generated domains are **HTTP-only** and cannot be switched to `https://`
> (Let's Encrypt rate-limits the shared zone). They are fine for a first smoke test of
> the proxy, but this app needs TLS to keep a session, so do not stop there.

---

## 5. Apply the schema — once, from inside the API container

**Do not make this a boot step.** Two replicas or two restarts would migrate
concurrently, and a half-applied schema is worse than a stopped one.

The API image ships the migration runner, so the cleanest path is Coolify's own
**Terminal**, which needs no public database:

1. Deploy `openerp-api` (it starts and stays healthy even before the schema exists —
   `/health` does not touch Postgres).
2. Open the API application → **Terminal** → connect to the running container.
3. Dry-run first, then apply:

   ```bash
   node server/scripts/apply-migrations.mjs --dry    # prints the plan, writes nothing
   node server/scripts/apply-migrations.mjs          # applies what is outstanding
   ```

Use this runner, **not `prisma migrate deploy`**. Deploy fails P3005 because this
database's baseline predates Prisma, and `migrate diff` is destructive against it
(ADR-001). The runner applies each migration in its own transaction and records it in
`schema_migration_ledger`, so re-running is a no-op and safe.

If you would rather run it from a checkout against the same database, temporarily
give `openerp-db` a public port (**Public access → Access → Public through TCP
proxy**), point `DATABASE_URL` at the public URL, run `npm run db:migrate`, then turn
the public port back off. The container Terminal avoids opening the database at all
and is the recommended route.

---

## 6. Create the first administrator — once

The image also ships a bundled `server/dist/seed.js` for exactly this, so the seed runs
from the same **Terminal** without `tsx` or dev dependencies (which the runtime image
does not carry). It provisions the RBAC catalogue, the default job workflow, the
employee contract types, and the super administrator.

With `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` set as API runtime variables
(step 2), just run:

```bash
node server/dist/seed.js
```

Or supply them for that one command:

```bash
SEED_ADMIN_EMAIL="you@company.co.za" \
SEED_ADMIN_PASSWORD="a strong password" \
node server/dist/seed.js
```

The seed is **idempotent**: roles, permissions and grants are upserted, and the admin
is only created if it does not already exist — re-running never resets a password an
operator has since changed.

The bundled seed always runs with `NODE_ENV=production` compiled in, so it **refuses
to create the shared-password demo accounts**. That is deliberate: those accounts must
never exist in a live environment.

---

## 7. Deploy in order, and verify

Deploy in dependency order:

1. `openerp-db` — running and healthy.
2. `openerp-api` — deployed (then schema + seed, steps 5–6).
3. `openerp-web` — deployed **last**, because it proxies to the API.

Verify from the **web container's Terminal**:

```bash
curl -fsS http://openerp-api:4000/health/ready     # {"status":"ready","database":"up"}
curl -fsS http://127.0.0.1:3000/login > /dev/null  # the sign-in page renders
```

Then open `https://erp.example.co.za` in a browser, confirm the padlock, and sign in
with the administrator you seeded.

A fresh deployment carries the **schema, the RBAC catalogue, the job workflow, the
employee contract types and your administrator** — enough to sign in and exercise the
app end to end. It does **not** carry the original EC&I business data (clients, jobs,
contracts, the seeded invoice); that baseline predates this repository and cannot be
regenerated from scratch (ADR-001). If you want that data too, it is loaded with the
import tool from a checkout (`npm run import:template`, then
`npm run import:data -- --file import/OpenERP-import-template.xlsx`) against a
`DATABASE_URL` pointed at a temporarily-public database. Only once that baseline
exists do the published acceptance values (job 1 at R 26 784,45, etc.) apply.

---

## 8. Alternative: the Compose build pack

One resource instead of three. The file is
[`docker-compose.coolify.yml`](../docker-compose.coolify.yml), and it differs from the
standalone stack in exactly three ways — no Caddy, no published ports, no one-off
migrate/seed services — each because of a Coolify rule rather than a preference.

### Why it is not `docker-compose.yml`

`docker-compose.yml` runs the app on one host and brings its own TLS with a Caddy
container. Under Coolify that is wrong three times over:

- **Caddy cannot bind.** Coolify runs its own proxy on the host and it already holds
  ports 80 and 443. A second process binding them fails and takes the deploy down with
  it.
- **Published ports bypass the proxy.** Coolify's own documentation: _"Do not publish
  a service with `ports:` unless it must be reachable directly on a server interface.
  A published host port bypasses domain-based proxy routing and can expose an internal
  service."_
- **`migrate` and `seed` are one-off.** A Compose resource models long-running
  services. Both are already inside the API image, so they run from its Terminal
  instead.

### It must be a Git-based Application

The resource type matters more than any field below, and it is the difference between
building and failing. Coolify has two Compose paths and only one of them can build
this repository:

| Path in Coolify                           | Creates            | Has the repository?              |
| ----------------------------------------- | ------------------ | -------------------------------- |
| Repository + **Compose** build strategy   | An **Application** | Yes — cloned on the Coolify host |
| **Docker Compose Empty** (paste the YAML) | A **Service**      | **No** — "has no Git source"     |

Pasting the definition cannot work here. `build: context: .` needs a build context to
exist on the Coolify host, and a pasted Service has none, so BuildKit is handed an
empty Dockerfile:

```
#2 [api internal] load build definition from Dockerfile.api
#2 transferring dockerfile: 2B done
...
target api: failed to solve: failed to read dockerfile: open Dockerfile.api: no such file or directory
```

`2B` is the empty file, and `Saved configuration files to
/data/coolify/services/<uuid>` at the top of the log is that path's storage directory —
Services, not Applications.

**Coolify never needs the files on your workstation.** It clones the repository from
Git on the LXC and builds there. The only requirements are that the repository is
**pushed** and that the LXC can reach the Git remote. That is why the app is pushed to
a remote rather than left local.

### Create it

**New Resource → the project → choose the repository → `Compose` as the build
strategy**, then:

| Field                                     | Value                             |
| ----------------------------------------- | --------------------------------- |
| **Base Directory**                        | `/`                               |
| **Docker Compose Location**               | `/docker-compose.coolify.yml`     |
| **Preserve repository during deployment** | **on** — General → Build pipeline |

Base Directory and Docker Compose Location are combined when Coolify locates the file,
so the pair above means "the file at the repository root".

The private repository needs a credential: add a **Deploy Key** to the Forgejo
repository (Coolify generates the keypair; paste the public half into the repository's
Settings → Deploy Keys), or use an HTTPS URL with a Forgejo access token. If Forgejo's
SSH runs on a non-standard port the clone URL must carry it —
`ssh://git@forgejo.example.com:2222/owner/repo.git`.

The last row is belt and braces: it guarantees the checkout is still present when
Compose resolves `build: context: .`. Leave it off and the build depends on Coolify
retaining the checkout for the whole build, which is not something to rely on.

### Domain and variables

In **Domains**, add the address and choose **`web`** as the receiving service. Include
the container port, because it is not 80:

```
https://erp.example.co.za:3000
```

The public request is still ordinary HTTPS; the `:3000` suffix only tells the proxy
which container port to route to.

Then set, under **Environment Variables**:

| Variable            | Value                                                               |
| ------------------- | ------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | anything strong                                                     |
| `AUTH_JWT_SECRET`   | 32+ characters (`openssl rand -base64 48`)                          |
| `SITE_ADDRESS`      | the hostname from the domain above, no scheme — `erp.example.co.za` |

`CLIENT_ORIGIN` is derived from `SITE_ADDRESS`, so set it to the same host you gave the
domain or the API will reject the browser's origin.

The `${VAR:?}` syntax in the compose file is Coolify's "required" marker: it creates
the variable and blocks the deployment until it has a value. That is why the two
secrets must be filled in rather than left to a default.

### Schema and first administrator

Open the **`api`** container's **Terminal** and run both, in this order:

```bash
node server/scripts/apply-migrations.mjs
node server/dist/seed.js
```

Then deploy and open the domain. Steps **5** and **6** above explain what each does and
why neither is a boot step.

---

## Troubleshooting

### Build failures

**`npm ci can only install packages when your package.json and package-lock.json are in sync`.**
The lockfile is stale. Run `npm install` and commit `package-lock.json`. Nothing fails
locally in this case, because `npm install` in a working tree reconciles the lock by
itself — only a clean `npm ci`, which is what the Dockerfiles do, notices.

**`error TS5083: Cannot read file '/app/tsconfig.base.json'`.**
`tsconfig.base.json` is at the repository root and every workspace `tsconfig.json`
extends it. A missing `COPY` of it, or a **Base Directory** that is not the repo root,
causes this. Both Dockerfiles copy it; the usual cause is the Base Directory field.

**A build fails in Docker but passes locally, with no useful message.**
Usually the lockfile or a missing `COPY`. Run `npm run check:docker` — it validates the
lockfile against every workspace manifest and asserts that each build stage copies the
files the build reads.

**The build dies partway with a disk or I/O error.**
The LXC root filesystem is full. Builds need roughly 60 GB headroom. Enlarge
`--rootfs` (and remember the container's disk, not the host's, is what fills).

### Runtime

**The API crash-loops at boot with `Invalid environment configuration`.**
A runtime variable is not reaching the container. `loadConfig()` throws and the process
exits deliberately rather than starting with a weak or missing secret — a refusal, not
a crash. Read **Runtime Logs**: the message names the field, e.g.
`- AUTH_JWT_SECRET: Required`. The usual cause is a variable whose **Runtime** scope is
_not_ "Available in the container". `AUTH_JWT_SECRET` needs 32+ characters, and
`NODE_ENV=production` additionally requires `AUTH_COOKIE_SECURE=true`.

**Every API request returns 502 `API_UNREACHABLE`.**
`API_ORIGIN` is wrong. `localhost` inside the web container is the web container
itself. It must be the API resource's name: `http://openerp-api:4000`. Confirm it
resolves with `getent hosts openerp-api` from the web Terminal.

**Login sets a cookie, then the next request is unauthenticated.**
You are serving over plain HTTP while `AUTH_COOKIE_SECURE=true`, so the browser
silently discards the cookie. Terminate TLS at Coolify and use `https://` (step 4).

**`PrismaClientInitializationError` / "did not initialize engine".**
Prisma 7 is Rust-free and has no query-engine binary, so this now means the generated
client is missing rather than the engine. All stages in `Dockerfile.api` are
deliberately the same `node:26-bookworm-slim`; mixing base images is the classic
cause. Rebuild without cache (`Force deploy (without cache)`).

**Coolify warns "the healthcheck needs a curl or wget command".**
Both images install `curl` and `wget`, so this should not appear. If it does, the
deploy used a cached build from before those lines existed — redeploy, or check the
branch being built. Coolify runs a healthcheck of its own inside the container in
addition to the image's `HEALTHCHECK`.

**Migrations run twice, or the schema is half-applied.**
Something is starting migrations automatically. It must be a deliberate single action
(step 5). Check the API's **Pre/Post-deployment commands** are empty.

**Chat live updates stop, or arrive in bursts.**
Chat streams over `GET /api/chat/stream` (server-sent events), which must not be
buffered between the browser and the API. The API sends
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and the Next proxy
forwards both. Coolify's own Traefik does not buffer, but an external WAF, CDN or
proxy in front of Coolify can. SSE needs **no** rate-limit exemption: there is no
global limiter, only per-route caps on the credential endpoints.

The stream is fanned out **in-process**, so the API must run as a **single instance**.
Two replicas would each hold only the streams that reached them, and a message
published on one would not reach a browser connected to the other. If a second
instance is ever wanted, the fan-out in `server/src/chat/events.ts` is the one place
that has to move to a shared channel.

**The container starts, then fails the first request with EACCES.**
Next writes its cache into `client/.next`; the image pre-creates that directory owned
by the non-root `node` user. A build from a cached layer from before that line would
show this — rebuild without cache.

---

## Local parity

`docker-compose.yml` builds the same two images against a real Postgres, behind
Caddy, so a deployment problem can be reproduced before it reaches production:

```bash
npm run self-host
```

That builds, starts, migrates and seeds in one go — the same sequence as the Coolify
Terminal steps above. [self-hosting.md](self-hosting.md) is the full runbook for it.
By hand:

```bash
docker compose up -d --build
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm seed
```

Then open <https://localhost>. Caddy serves it over HTTPS from its own local CA, so
the browser warns until you trust that CA — see
[self-hosting.md](self-hosting.md#3-tls-and-the-address-caddy-serves). HTTPS rather
than HTTP deliberately: the session cookie is `Secure` here for the same reason it
is in Coolify.

This is not a development stack — every service builds and runs exactly as it will
in Coolify. Development remains `npm run dev`.

Because the stack sets `NODE_ENV=production`, the seed refuses the shared-password
demo accounts; they exist for `npm run seed` (tsx, development) only.

---

## Deployment-file checks

```bash
npm run check:docker
```

Parses both Dockerfiles as instruction sequences, resolves every `COPY --from=` to a
declared stage, asserts that the runtime stage copies everything it reads (including
the env loader the migration runner imports), and asserts no literal database password
can reach an image layer. It exists because these files cannot be exercised without a
Docker daemon, and a malformed instruction is otherwise found only at deploy time.
