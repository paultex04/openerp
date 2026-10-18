# Self-hosting on one host

The whole application — database, API, web client and TLS — as one Docker Compose
stack on a single machine. This is the shortest path from a checkout to a running,
HTTPS-served app, and it needs no control plane.

It is a real deployment, not a demo: the same two images Coolify builds, against a
real Postgres, behind real TLS. If you later want a dashboard, git-push deploys and
backups across several apps, see [coolify-deployment.md](coolify-deployment.md) —
the two share the same images and the same environment contract, so a stack that
runs here is a stack that deploys there.

## What runs

| Service   | Image                  | Published?  | Reached by                        |
| --------- | ---------------------- | ----------- | --------------------------------- |
| `db`      | `postgres:18-alpine`   | no          | `api` at `db:5432`                |
| `api`     | built `Dockerfile.api` | **no**      | `web` at `api:4000`, via `/api/*` |
| `web`     | built `Dockerfile.web` | **no**      | `caddy` at `web:3000`             |
| `caddy`   | `caddy:2-alpine`       | **80, 443** | the browser                       |
| `migrate` | built `Dockerfile.api` | one-off     | run by hand (tools profile)       |
| `seed`    | built `Dockerfile.api` | one-off     | run by hand (tools profile)       |

Only Caddy is exposed. The browser reaches `web` through Caddy, `web` reaches `api`
over the private network through its own `/api/*` proxy, and the session cookie is
therefore first-party. This is why the API and web ports are deliberately _not_
published: exposing `3000` would put an insecure copy of the app beside the secure
one, and the browser would silently drop the `Secure` cookie on it — which looks
like "login does nothing".

## 0. Prerequisites

Docker Engine with Compose v2, on any machine:

```bash
docker --version && docker compose version
```

**If that machine is a Proxmox LXC, enable nesting.** Docker cannot start inside a
container without it, and the failure is a cgroup error that no application change
will fix. In the Proxmox UI: **Create CT → Options → Features → tick nesting** (and
`keyctl`). The equivalent CLI flag is `--features nesting=1,keyctl=1`.

The build happens on this host, not on your laptop: `npm ci` for three workspaces,
a Next production build and an esbuild bundle. **4 cores / 8 GB RAM / 60 GB on
SSD** is the working floor, and a small disk fills mid-build in a way that reads as
a build error.

## 1. Configure

Copy the template and fill in the two required secrets:

```bash
cp .env.example .env
```

- `POSTGRES_PASSWORD` — for the database container this stack creates.
- `AUTH_JWT_SECRET` — at least 32 characters. Generate it:

  ```bash
  openssl rand -base64 48
  ```

- `SITE_ADDRESS` — the address Caddy serves. Leave it as `localhost` to start; see
  [section 3](#3-tls-and-the-address-caddy-serves) before using a real name.
- `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` — the first administrator
  ([section 2](#2-build-start-migrate-seed)).

The stack ignores the development values of `NODE_ENV`, `AUTH_COOKIE_SECURE` and
`CLIENT_ORIGIN` and pins them instead, because they legitimately differ between
`npm run dev` and a deployment. `docker-compose.yml` carries the reason for each.

## 2. Build, start, migrate, seed

```bash
npm run self-host
```

That is the whole deployment. It runs, in order:

```bash
docker compose up -d --build
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm seed
```

The order matters and the script exists so it is not a convention you have to
remember. Skip the migration and the app fails on the first login with a Prisma
"relation does not exist" error; skip the seed and there is no account to sign in
with. Both steps are idempotent, so re-running is always safe.

On a database that does not exist yet, `migrate` builds the whole schema from
`server/prisma/schema.sql` and records the hand-written migrations as already
present. That is not a shortcut: the migrations extend a baseline which predates this
repository (ADR-001), so on an empty database the first one fails with
`relation "employee" does not exist`. It refuses to do any of that to a database
that already has a schema, so the command is the same either way — the first run
creates, later runs apply whatever is outstanding.

By hand, if you prefer:

```bash
docker compose up -d --build
docker compose --profile tools run --rm migrate   # --dry first, if you like
docker compose --profile tools run --rm seed
```

`migrate` and `seed` are in the `tools` profile so `up` can never start them by
accident — migrating on every boot is how a schema ends up half-applied.

Then open the site:

```bash
open https://localhost        # or your SITE_ADDRESS
```

## 3. TLS, and the address Caddy serves

TLS is not optional here. The API sets a `Secure` session cookie, so a browser
silently discards it over plain HTTP. Caddy always redirects `http://` to
`https://`, and picks the right certificate from what kind of name `SITE_ADDRESS`
is — there is nothing to configure either way.

**`localhost` (the default).** Caddy issues from its own local CA. No DNS, no
certificate authority, works immediately. The browser warns until you trust the
CA:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Then import `caddy-root.crt` into your operating system's trust store and restart
the browser. The warning is only about _who signed_ the certificate — the
connection is still encrypted, so if you would rather not install anything, either
accept the warning or use a real domain.

**A LAN name:** `erp.internal`, or any `*.local` or `*.home.arpa` name. Caddy uses
the local CA for these too — those TLDs can never hold a public certificate, so it
does not try. It needs a DNS record or a hosts-file entry resolving the name to the
host, and that is all.

> Use `erp.internal`, not a made-up TLD like `erp.homelab`. Caddy decides from the
> suffix: a `.homelab` name looks publicly certifiable, so Caddy attempts an ACME
> exchange, fails, and serves an error instead of the app.

**A public domain:** `erp.example.co.za`. Point an A record at this host, make
ports 80 and 443 reachable from the internet, and Caddy obtains and renews a
Let's Encrypt certificate with no further input. If the host cannot be reached on
port 80, the ACME **DNS challenge** avoids that requirement — but it needs a Caddy
build with your DNS provider's plugin compiled in, which the stock `caddy:2-alpine`
image does not ship. See [Caddy's DNS challenge
docs](https://caddyserver.com/docs/automatic-https#dns-challenge); the LAN-CA path
above is usually the better answer on a home network.

Whichever you choose, `SITE_ADDRESS` drives `CLIENT_ORIGIN` in the API, so the two
cannot drift apart.

## 4. Day to day

| Task                  | Command                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| Follow logs           | `docker compose logs -f web caddy api`                                       |
| Restart               | `docker compose restart web`                                                 |
| Update                | `git pull && npm run self-host` (rebuilds, migrates, seeds — all idempotent) |
| Confirm the API is up | `docker compose exec web wget -qO- http://api:4000/health/ready`             |
| Stop                  | `docker compose down` — data survives, in the volumes below                  |
| Back up               | `docker compose exec db pg_dump -U openerp openerp > backup.sql`             |
| Restore               | `docker compose exec -T db psql -U openerp -d openerp < backup.sql`          |

Three named volumes hold everything that is not in the image: `db-data` (the
database), `caddy-data` (certificates — losing it means re-requesting them, and on
Let's Encrypt that can hit the rate limit), and `caddy-config`.

`docker compose down -v` deletes all three. It is the whole-database reset, and it
has no confirmation prompt.

## 5. Troubleshooting

**The API restarts in a loop and the log says `Invalid environment configuration`.**
`loadConfig()` throws rather than starting with a weak or missing secret; the log
names the field. `AUTH_JWT_SECRET` must be 32+ characters. If the message is about
`AUTH_COOKIE_SECURE`, something has overridden the pinned `'true'` — the stack sets
it as a literal precisely so a development `.env` cannot.

**`Migration failed: relation "employee" does not exist`.** The database has no
baseline schema, and these migrations cannot run without one — they extend a schema
that predates this repository (ADR-001). A current build notices an empty database and
creates it from `server/prisma/schema.sql` instead, so seeing this means either the
image predates that behaviour, or the database is neither empty nor initialised.
`docker compose --profile tools run --rm migrate` from an up-to-date checkout is the
answer to the first; the second is a database worth looking at before touching.

**The page loads but signing in does nothing; the next request is unauthenticated.**
You are on `http://`, not `https://`. The cookie is `Secure`, so the browser drops
it silently. Use the `https://` URL Caddy serves.

**Every API call returns `API_UNREACHABLE` (502).**
`API_ORIGIN` is wrong, or `api` is not running: `docker compose logs api`. Inside a
container, `localhost` is that container — the setting must stay `http://api:4000`.

**The certificate warning will not go away.**
Expected for `localhost` and `*.internal` until you trust the local CA
([section 3](#3-tls-and-the-address-caddy-serves)). Check Caddy's own view with
`docker compose logs caddy`; a public name that fails ACME logs the challenge
error there.

**Chat messages only appear on reload.**
Something between the browser and Caddy is buffering. Caddy flushes
`text/event-stream` immediately, but a corporate proxy, a CDN or a WAF in front of
it may not. The API and Next both send `X-Accel-Buffering: no` for this route.

**A build fails with `TS5083: Cannot read file '/app/tsconfig.base.json'` or a
statement about the lockfile being out of sync.** The lockfile or a `COPY` is
stale; run `npm run check:docker`, which validates both without needing a daemon.

**Run it without Docker.**
Node 26, a Postgres 18 and Caddy installed directly on the host also work, with no
nesting requirement — but then you own the Node upgrades and the service
supervision. The Docker path exists so that "works" means the same thing on your
laptop and on the host.

## 6. What this does not do

- **No dashboard, no git-push deploys, no multi-app routing.** That is
  [Coolify](coolify-deployment.md)'s job, and for one app it is a control plane you
  do not need.
- **No automatic backups.** The `pg_dump` above is the mechanism, not a schedule.
  Add it to cron if the data matters.
- **One API instance only.** Chat fans out in-process, so a second `api` replica
  would hold only the streams that reached it. Scaling out means moving the
  fan-out in `server/src/chat/events.ts` to a shared channel first.
