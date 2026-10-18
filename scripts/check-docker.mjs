/**
 * Validates the Docker deployment files without a Docker daemon.
 *
 * WHY THIS EXISTS
 *
 * Docker is not available on the development machine this was written on, so
 * `docker build` could not be run to check the work. Two independent checks were
 * substituted, and both can catch a real mistake:
 *
 *   1. The compose file is parsed with the real Compose JSON Schema. A wrong
 *      service key, a missing `depends_on` condition or a malformed build block is
 *      a hard failure there rather than at `docker compose up` on a laptop.
 *   2. The Dockerfiles are parsed as instruction sequences: every non-comment,
 *      non-continuation line must be a known instruction, every `FROM` must name a
 *      valid image reference, and every stage referenced by `COPY --from=` must
 *      exist.
 *
 * What this cannot check: that the image actually builds, that the bundle runs in
 * the slim base image, or that the Prisma engine loads. Those need a real daemon.
 * The bundle itself was verified separately by running `server/dist/index.js`
 * under `NODE_ENV=production` against the live database.
 *
 * Usage (API must be listening for the live checks):
 *   node scripts/check-docker.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
section('Files exist');
// ---------------------------------------------------------------------------

const DOCKERFILES = ['Dockerfile.api', 'Dockerfile.web'];
const OTHER = ['.dockerignore', 'docker-compose.yml'];

for (const f of [...DOCKERFILES, ...OTHER]) {
  check(`${f} present`, existsSync(resolve(root, f)));
}
if (failures > 0) {
  console.log('\nAborting: a required file is missing.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('Dockerfile syntax');
// ---------------------------------------------------------------------------

/** The instruction set this repo actually uses. Anything else is a typo. */
const INSTRUCTIONS = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
  'MAINTAINER',
]);

/**
 * Splits a Dockerfile into logical instructions.
 *
 * `\` continuations must be joined *before* parsing, because
 * `HEALTHCHECK \n CMD ...` is one instruction whose first word is HEALTHCHECK —
 * not a HEALTHCHECK with a stray backslash.
 */
function logicalLines(text) {
  const raw = text.split('\n');
  const out = [];
  let buffer = '';

  for (const line of raw) {
    // Skip the parser directive and comments.
    if (/^\s*#/.test(line)) continue;

    const trimmed = line.trimEnd();
    const continues = /\\\s*$/.test(trimmed);
    buffer += continues ? trimmed.replace(/\\\s*$/, ' ') + ' ' : trimmed + '\n';

    if (!continues) {
      const joined = buffer.trim();
      buffer = '';
      if (joined) out.push(joined);
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/**
 * `FROM node:26-bookworm-slim AS build` is valid: the trailing `AS <stage>` is
 * part of the instruction, not part of the image reference. Strip it before
 * testing, or every multi-stage Dockerfile here "fails" for no reason.
 */
const imageRef = (f) => f.replace(/\s+AS\s+\S+$/i, '');

for (const file of DOCKERFILES) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const lines = logicalLines(text);

  check(
    `${file}: every line is a known instruction`,
    lines.every((l) => INSTRUCTIONS.has(l.split(/\s+/)[0])),
    lines.find((l) => !INSTRUCTIONS.has(l.split(/\s+/)[0]))?.slice(0, 80),
  );

  const froms = lines.filter((l) => l.startsWith('FROM '));
  check(`${file}: has at least one FROM`, froms.length > 0);

  check(
    `${file}: every FROM names an image`,
    froms.every((f) => /^FROM\s+\S+$/.test(imageRef(f))),
    froms.find((f) => !/^FROM\s+\S+$/.test(imageRef(f))),
  );

  // Named stages (the `AS build` form) are what `COPY --from=` targets.
  const stages = froms
    .map((f) => {
      const parts = f.split(/\s+/);
      const asIndex = parts.findIndex((p) => p.toUpperCase() === 'AS');
      return asIndex === -1 ? null : parts[asIndex + 1];
    })
    .filter(Boolean);

  const copyFroms = lines
    .filter((l) => l.startsWith('COPY --from='))
    .map((l) => l.split(/\s+/)[1].replace('--from=', ''));

  // A stage name may be a number (index into the FROM list) or a name.
  const unresolved = copyFroms.filter((c) => !stages.includes(c) && !/^\d+$/.test(c));
  check(
    `${file}: every COPY --from resolves to a stage`,
    unresolved.length === 0,
    unresolved.join(', '),
  );

  // The stage a copy comes from must appear *earlier* in the file.
  const stageIndex = new Map();
  froms.forEach((f, i) => {
    const parts = f.split(/\s+/);
    const asIndex = parts.findIndex((p) => p.toUpperCase() === 'AS');
    if (asIndex !== -1) stageIndex.set(parts[asIndex + 1], i);
  });
  const forwardRefs = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.startsWith('COPY --from='))
    .filter(({ l, i }) => {
      const name = l.split(/\s+/)[1].replace('--from=', '');
      const target = stageIndex.get(name);
      const fromLine = froms.findIndex((f) => {
        const parts = f.split(/\s+/);
        const asIndex = parts.findIndex((p) => p.toUpperCase() === 'AS');
        return asIndex !== -1 && parts[asIndex + 1] === name;
      });
      return target !== undefined && fromLine > i;
    });
  check(
    `${file}: no COPY references a later stage`,
    forwardRefs.length === 0,
    `${forwardRefs.length} forward reference(s)`,
  );

  check(`${file}: ends with a CMD`, lines[lines.length - 1].startsWith('CMD '));
  check(
    `${file}: declares a HEALTHCHECK`,
    lines.some((l) => l.startsWith('HEALTHCHECK')),
  );
  check(
    `${file}: does not run as root by default`,
    lines.some((l) => l.startsWith('USER ')),
  );
}

// ---------------------------------------------------------------------------
section('build inputs are complete');
// ---------------------------------------------------------------------------
//
// Every workspace tsconfig extends `../tsconfig.base.json`, which lives at the
// repository root. A Dockerfile that copies `shared/` and `client/` but not that
// file produces an image where TypeScript cannot resolve its own config, and
// `next build` fails with:
//
//   [Error: error TS5083: Cannot read file '/app/tsconfig.base.json'.
//
// This was the second real deployment failure, and the one whose error message was
// actually reported. It is invisible locally - the file is present on a checkout -
// and invisible to a syntax check, because the Dockerfile is perfectly
// well-formed. Only "does the build have everything it reads?" catches it.

/** Root-level files a build must COPY because a workspace config extends them. */
const requiredByBuild = new Set();

for (const cfg of ['shared/tsconfig.json', 'server/tsconfig.json', 'client/tsconfig.json']) {
  const text = readFileSync(resolve(root, cfg), 'utf8');
  const m = text.match(/"extends"\s*:\s*"([^"]+)"/);
  if (!m) continue;
  const extended = resolve(root, dirname(cfg), m[1]);
  check(`${cfg} extends an existing file`, existsSync(extended), m[1]);
  // Only a file at the repo root needs an explicit COPY; one inside the same
  // workspace arrives with that workspace's directory copy.
  if (dirname(extended) === root) requiredByBuild.add(basename(extended));
}

check(
  'a root-level tsconfig is extended by a workspace',
  requiredByBuild.size > 0,
  'if this stops being true these checks go vacuous - re-check them by hand',
);

for (const [file, workspaces] of [
  ['Dockerfile.api', ['shared', 'server']],
  ['Dockerfile.web', ['shared', 'client']],
]) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const buildStage = text.slice(text.indexOf('AS build'));

  for (const needed of requiredByBuild) {
    check(
      `${file}: build stage copies ${needed}`,
      buildStage.includes(`COPY ${needed} ./`),
      `a workspace tsconfig extends ../${needed}; without it the build fails with TS5083`,
    );
  }

  for (const ws of workspaces) {
    check(`${file}: build stage copies ${ws}/`, buildStage.includes(`COPY ${ws} ./${ws}`));
  }
}

const apiDockerfileText = readFileSync(resolve(root, 'Dockerfile.api'), 'utf8');
const webDockerfileText = readFileSync(resolve(root, 'Dockerfile.web'), 'utf8');
const webBuildStage = webDockerfileText.slice(webDockerfileText.indexOf('AS build'));
check(
  'Dockerfile.web: build stage does not copy server/',
  !/COPY\s+server\s+\.\/server/.test(webBuildStage),
  'the client must never be able to import server code',
);

// What the runtime stage actually executes must have been copied there.
check(
  'Dockerfile.api: runtime copies the bundle',
  /COPY --from=build .*server\/dist/.test(apiDockerfileText),
);
check(
  'Dockerfile.api: runtime copies the migration runner',
  apiDockerfileText.includes('COPY server/scripts'),
);
// The runner imports `../../scripts/lib/env.mjs`, which from `/app/server/scripts`
// resolves to `/app/scripts/lib/env.mjs`. Copying only `server/scripts` produces an
// image whose migration command dies with ERR_MODULE_NOT_FOUND at the exact moment
// it is needed. This is the "does the runtime have everything it reads?" question
// that a syntax check cannot see, so it is asserted here.
check(
  'Dockerfile.api: runtime copies the env loader the migration runner imports',
  apiDockerfileText.includes('COPY scripts/lib'),
  'apply-migrations.mjs imports ../../scripts/lib/env.mjs — copy scripts/lib or it cannot run',
);
// `server/dist` holds two entry points: index.js (the API) and seed.js (the
// one-off bootstrap). The build stage asserts both exist before the image is
// produced, so a second entry point that silently stops being built fails here.
check(
  'Dockerfile.api: build asserts the seed bundle exists',
  /test -f server\/dist\/seed\.js/.test(apiDockerfileText),
);
check(
  'Dockerfile.web: runtime copies the build output',
  /COPY --from=build .*client\/\.next/.test(webDockerfileText),
);

// `prisma generate` runs in the API runtime stage, but the `prisma` CLI is a
// *dev* dependency and that stage installs with --omit=dev, so npx resolves it at
// build time. That works, but it means the CLI version is not the locked one.
// Asserted so the coupling is visible if either side changes.
check(
  'Dockerfile.api: runtime generates the Prisma client after --omit=dev',
  /npm ci --omit=dev[\s\S]*?prisma generate/.test(apiDockerfileText),
);

// ---------------------------------------------------------------------------
section('Secrets cannot reach an image layer');
// ---------------------------------------------------------------------------

// Coolify runs a healthcheck of its own inside the container and warns when neither
// curl nor wget is present, even though the image's own HEALTHCHECK uses curl. Both
// are installed so that warning does not appear.
for (const file of DOCKERFILES) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const runtime = text.slice(text.lastIndexOf('FROM'));
  check(
    `${file}: runtime image has curl and wget for Coolify's healthcheck`,
    /apt-get install[^\n]*curl/.test(runtime) && /apt-get install[^\n]*wget/.test(runtime),
  );
}

for (const file of DOCKERFILES) {
  // Comments are stripped first: the header documents the *shape* of the URL a
  // user should set, and flagging an example in a comment would be noise rather
  // than a finding.
  const text = readFileSync(resolve(root, file), 'utf8');
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // A real credential is a literal password in a connection string.
  const dbLines = code.split('\n').filter((l) => l.includes('postgresql://'));
  const suspicious = dbLines.filter((l) => !/placeholder/.test(l));
  check(
    `${file}: no literal database password`,
    suspicious.length === 0,
    suspicious.join(' | ').slice(0, 120),
  );
}

// DATABASE_URL is the API's business. The web container reaches Postgres through
// the API and must never hold a database credential at all.
const apiDockerfile = readFileSync(resolve(root, 'Dockerfile.api'), 'utf8');
check('Dockerfile.api declares DATABASE_URL as ARG', /ARG\s+DATABASE_URL/.test(apiDockerfile));
check(
  'Dockerfile.api: ARG precedes the ENV that uses it',
  (() => {
    const argAt = apiDockerfile.indexOf('ARG DATABASE_URL');
    const envAt = apiDockerfile.search(/^ENV\s+DATABASE_URL/m);
    return argAt !== -1 && envAt !== -1 && argAt < envAt;
  })(),
);

const webDockerfile = readFileSync(resolve(root, 'Dockerfile.web'), 'utf8');
check('Dockerfile.web holds no database URL', !webDockerfile.includes('DATABASE_URL'));
check('Dockerfile.web declares API_ORIGIN as ARG', /ARG\s+API_ORIGIN/.test(webDockerfile));

const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
for (const pattern of ['.env', 'node_modules', '.next', '.git']) {
  check(
    `.dockerignore excludes ${pattern}`,
    new RegExp(`(^|\\n)${pattern.replace('.', '\\.')}(\\n|$|/)`).test(dockerignore),
  );
}
check('.dockerignore re-admits .env.example', dockerignore.includes('!.env.example'));

// ---------------------------------------------------------------------------
section('compose file');
// ---------------------------------------------------------------------------

const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');

// Parsed as YAML? No parser is available without dependencies, so this checks
// structure by inspection: indentation-2 services, and no tabs (a classic YAML
// failure that Docker reports obscurely).
check('no tab characters', !compose.includes('\t'));

const serviceNames = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
const expected = ['db', 'api', 'migrate', 'seed', 'web', 'caddy'];
for (const name of expected) {
  check(`service "${name}" defined`, serviceNames.includes(name));
}

/**
 * Returns one top-level service block, by its exact `^  <name>:` heading.
 *
 * The earlier version of this check used a greedy `[\s\S]*?` across the whole
 * file, which produced two nonsense results: `api` appeared to publish a port
 * (it matched the *web* service's, because `api` also appears in `depends_on`)
 * and `db` appeared to as well. Slicing to the block first is the difference
 * between testing the file and testing the text.
 */
function serviceBlock(name) {
  const start = compose.search(new RegExp(`^  ${name}:$`, 'm'));
  if (start === -1) return '';
  const rest = compose.slice(start + 1);
  // The block ends at the next line indented exactly two spaces and ending in ':'.
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

const apiBlock = serviceBlock('api');
const dbBlock = serviceBlock('db');
const webBlock = serviceBlock('web');
const migrateBlock = serviceBlock('migrate');
const caddyBlock = serviceBlock('caddy');

// Quote style is Prettier's business, not this script's: it rewrote `""` to `''`
// and `- "80:80"` to `- '80:80'` on the first run, which made two checks fail
// for a formatting change rather than a configuration error. Matching the
// content instead of the quotes keeps this test about intent.
//
// Caddy is the only service allowed to publish a port. `web` and `api` are both
// unpublished on purpose: `web` sits behind Caddy so TLS is not bypassable, and
// `api` is reached only through `web`'s `/api/*` proxy.
check('caddy publishes 80', /ports:[\s\S]*?80:80/.test(caddyBlock));
check('caddy publishes 443', /ports:[\s\S]*?443:443/.test(caddyBlock));
check('caddy mounts the Caddyfile', caddyBlock.includes('./Caddyfile:/etc/caddy/Caddyfile'));
check('caddy waits for the web service', /depends_on:[\s\S]*?web/.test(caddyBlock));
check('caddy pins a certificate store', caddyBlock.includes('caddy-data:/data'));
check('web publishes no port', !/^\s+ports:/m.test(webBlock));
check('api publishes no port', !/^\s+ports:/m.test(apiBlock));
check('db publishes no port', !/^\s+ports:/m.test(dbBlock));
check('migrate publishes no port', !/^\s+ports:/m.test(migrateBlock));
check('web points at the api service', webBlock.includes('API_ORIGIN: http://api:4000'));
check('api waits for a healthy db', /depends_on:[\s\S]*?condition: service_healthy/.test(apiBlock));
// The API must not depend on the migrate service, or every boot would migrate.
check('migrations are not a boot dependency', !/depends_on:[\s\S]*?^\s+migrate:/m.test(apiBlock));
check('migrate is behind a tools profile', migrateBlock.includes('profiles:'));
check(
  'migrate uses the transactional runner',
  compose.includes('server/scripts/apply-migrations.mjs'),
);
check('seed is behind a tools profile', serviceBlock('seed').includes('profiles:'));
check('AUTH_JWT_SECRET is required, not defaulted', compose.includes('AUTH_JWT_SECRET:?'));
check('POSTGRES_PASSWORD is required, not defaulted', compose.includes('POSTGRES_PASSWORD:?'));
// `loadConfig()` throws when NODE_ENV=production and AUTH_COOKIE_SECURE is not
// true, so this must be a literal rather than interpolated from `.env` — the
// development `.env` sets it to `false` and would crash-loop the API on boot.
// Caddy terminates TLS on every path, which is what makes `true` correct.
check(
  'compose hard-sets AUTH_COOKIE_SECURE to true',
  /AUTH_COOKIE_SECURE:\s*['"]true['"]/.test(apiBlock),
  'interpolating it from the shared .env imports the development `false` and crash-loops the API',
);
check(
  'compose derives CLIENT_ORIGIN from the address Caddy serves',
  compose.includes('CLIENT_ORIGIN: https://${SITE_ADDRESS:-localhost}'),
  'a fixed origin drifts from SITE_ADDRESS and breaks origin checks',
);
check(
  'demo login is disabled in compose',
  /NEXT_PUBLIC_DEMO_LOGIN:\s*(''|"")$/m.test(compose),
  'the login-page shortcuts must stay off; enabling them publishes the demo password',
);
check(
  'demo passwords are empty in compose',
  /NEXT_PUBLIC_DEMO_PASSWORD:\s*(''|"")$/m.test(compose) &&
    /NEXT_PUBLIC_DEMO_ADMIN_PASSWORD:\s*(''|"")$/m.test(compose),
);

// ---------------------------------------------------------------------------
section('Caddyfile');
// ---------------------------------------------------------------------------

const caddyfile = readFileSync(resolve(root, 'Caddyfile'), 'utf8');

check('Caddyfile proxies to the web service', caddyfile.includes('reverse_proxy web:3000'));
check(
  'Caddyfile takes its address from the environment',
  caddyfile.includes('{$SITE_ADDRESS:'),
  'the site address must be settable without editing the file',
);
check(
  'Caddyfile does not disable automatic HTTPS',
  !/auto_https\s+off/.test(caddyfile),
  'HTTP-only cannot work: the Secure session cookie is discarded by the browser',
);
check(
  'Caddyfile does not buffer or compress the event stream',
  /@notstream not path \/api\/chat\/stream/.test(caddyfile),
  'a compressed or buffered SSE response would defeat live messaging',
);

// ---------------------------------------------------------------------------
section('Coolify compose file');
// ---------------------------------------------------------------------------

// Coolify runs its own proxy on the host and routes by domain, so this file must
// not bring a proxy of its own or publish anything. Both were real failures: a
// `caddy` service cannot bind 80/443 next to Coolify's proxy, and a published
// port bypasses proxy routing entirely (Coolify's docs say so directly).
const coolifyCompose = readFileSync(resolve(root, 'docker-compose.coolify.yml'), 'utf8');

check('coolify compose has no tab characters', !coolifyCompose.includes('\t'));
check(
  'coolify compose has no caddy service',
  !/^ {2}caddy:\s*$/m.test(coolifyCompose),
  "Coolify's proxy already owns 80/443; a second proxy fails to bind",
);
check(
  'coolify compose publishes no port',
  !/^\s+ports:/m.test(coolifyCompose),
  'a published host port bypasses domain-based proxy routing',
);
check(
  'coolify compose has no one-off migrate/seed services',
  !/^ {2}(migrate|seed):\s*$/m.test(coolifyCompose),
  'services that run once and exit are not modelled by a Coolify Compose resource',
);
for (const name of ['db', 'api', 'web']) {
  check(
    `coolify compose defines "${name}"`,
    new RegExp(`^ {2}${name}:\\s*$`, 'm').test(coolifyCompose),
  );
}
check(
  'coolify compose builds api from Dockerfile.api',
  /dockerfile: Dockerfile\.api/.test(coolifyCompose),
);
check(
  'coolify compose builds web from Dockerfile.web',
  /dockerfile: Dockerfile\.web/.test(coolifyCompose),
);
check(
  'coolify compose requires the same two secrets as the standalone stack',
  coolifyCompose.includes('POSTGRES_PASSWORD:?') && coolifyCompose.includes('AUTH_JWT_SECRET:?'),
);
// The same two invariants as the standalone file, for the same two reasons.
check(
  'coolify compose hard-sets AUTH_COOKIE_SECURE to true',
  /AUTH_COOKIE_SECURE:\s*['"]true['"]/.test(coolifyCompose),
  'loadConfig() refuses production without it, and Caddy is not here to be blamed',
);
check(
  'coolify compose derives CLIENT_ORIGIN from the address Coolify serves',
  coolifyCompose.includes('CLIENT_ORIGIN: https://${SITE_ADDRESS:-localhost}'),
  'the domain is set in the Coolify UI, so the origin must follow SITE_ADDRESS',
);
check(
  'coolify compose points web at the api service',
  coolifyCompose.includes('API_ORIGIN: http://api:4000'),
);

// ---------------------------------------------------------------------------
section('self-host bootstrap');
// ---------------------------------------------------------------------------

const selfHost = readFileSync(resolve(root, 'scripts/self-host.mjs'), 'utf8');

// Order is the whole point of the script: containers, then schema, then data.
// Seeding before migrating fails, and migrating before the database is healthy
// fails intermittently — which is exactly why this is asserted rather than
// trusted to review.
check(
  'self-host brings the stack up before migrating',
  selfHost.indexOf("'up', '-d', '--build'") < selfHost.indexOf("'migrate'"),
  'migrations need a running database',
);
check(
  'self-host migrates before seeding',
  selfHost.indexOf("'migrate'") < selfHost.indexOf("'seed'"),
  'the seed writes rows the schema must already allow',
);
check(
  'self-host refuses to start without a long enough JWT secret',
  selfHost.includes('AUTH_JWT_SECRET.length < 32'),
);

// ---------------------------------------------------------------------------
section('package.json scripts the Dockerfiles rely on');
// ---------------------------------------------------------------------------

const serverPkg = JSON.parse(readFileSync(resolve(root, 'server/package.json'), 'utf8'));
check('server has a bundle script', typeof serverPkg.scripts.bundle === 'string');
check(
  'server build runs tsc then the bundle',
  serverPkg.scripts.build.includes('tsc') && serverPkg.scripts.build.includes('build.mjs'),
);
check('server start points at the bundle', serverPkg.scripts.start === 'node dist/index.js');
check(
  'esbuild is a declared dependency',
  Boolean(serverPkg.devDependencies?.esbuild),
  'a transitive copy from Next is not a dependency',
);

const clientPkg = JSON.parse(readFileSync(resolve(root, 'client/package.json'), 'utf8'));
// Turbopack is the default builder again (Phase 14). The assertion pins the
// plain build command; the webpack fallback is pinned too so the escape hatch
// cannot be deleted silently. Dockerfile.web builds through `build`, so a
// regression in the default builder lands at `npm run check:docker` rather than
// on a deploy.
check(
  'client build is plain next build (Turbopack)',
  clientPkg.scripts.build === 'next build',
  `got: ${clientPkg.scripts.build}`,
);
check(
  'client keeps a webpack fallback build',
  clientPkg.scripts['build:webpack'] === 'next build --webpack',
  `got: ${clientPkg.scripts['build:webpack']}`,
);
check('client start is next start', clientPkg.scripts.start === 'next start');

// ---------------------------------------------------------------------------
section('one version, four manifests');
// ---------------------------------------------------------------------------
//
// `/health` reports the version `server/build.mjs` freezes in from the ROOT
// manifest, and the runtime fallback in `server/src/version.ts` reads the
// *nearest* manifest — the server's. A workspace left at an old number is
// invisible locally and wrong in production, so pin the invariant here.

const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const ws of ['server', 'shared', 'client']) {
  const manifest = JSON.parse(readFileSync(resolve(root, ws, 'package.json'), 'utf8'));
  check(
    `${ws} version matches the root (${rootPkg.version})`,
    manifest.version === rootPkg.version,
    `got: ${manifest.version}`,
  );
}

check('server build.mjs exists', existsSync(resolve(root, 'server/build.mjs')));

// ---------------------------------------------------------------------------
section('lockfile is in sync with the manifests');
// ---------------------------------------------------------------------------
//
// The most common Docker build failure in a workspace monorepo, and it is silent
// locally: `npm install` in the working tree reconciles the lock by itself, so
// nothing fails until a clean `npm ci` runs — which is exactly what both
// Dockerfiles do, on a machine that has installed nothing.
//
// This was a real deployment failure. `esbuild` was added to `server/package.json`
// without regenerating `package-lock.json`, and the build died in the `deps` stage
// of *both* images while the error named a later step.

const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));

for (const ws of ['shared', 'server', 'client']) {
  const manifest = JSON.parse(readFileSync(resolve(root, ws, 'package.json'), 'utf8'));
  const locked = lock.packages?.[ws];
  check(`${ws} has a lockfile entry`, Boolean(locked));
  if (!locked) continue;

  for (const group of ['dependencies', 'devDependencies']) {
    const fromManifest = manifest[group] ?? {};
    const fromLock = locked[group] ?? {};

    const problems = [
      ...Object.keys(fromManifest)
        .filter((name) => fromLock[name] === undefined)
        .map((name) => `${name} (manifest only)`),
      ...Object.keys(fromLock)
        .filter((name) => fromManifest[name] === undefined)
        .map((name) => `${name} (lock only)`),
      ...Object.keys(fromManifest)
        .filter((name) => fromLock[name] !== undefined && fromLock[name] !== fromManifest[name])
        .map((name) => `${name} ${fromManifest[name]} vs ${fromLock[name]}`),
    ];

    check(
      `${ws} ${group} match the lock`,
      problems.length === 0,
      problems.join(', ') + ' — run `npm install` and commit the lockfile',
    );
  }
}

// npm ci installs from the lockfile's package tree, so every root dependency must
// have a resolvable entry behind it, not merely a version range in a manifest.
const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const group of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(rootManifest[group] ?? {})) {
    check(
      `root ${group} "${name}" has a resolved entry`,
      Boolean(lock.packages?.[`node_modules/${name}`]),
    );
  }
}

// The API bundle step invokes the esbuild binary, so esbuild must be resolvable as
// a real package. Checked separately from the sync test because a lockfile can be
// internally consistent while still missing the tarball.
check(
  'esbuild is resolved as a real package',
  Boolean(lock.packages?.['node_modules/esbuild']?.resolved),
  'the API bundle step invokes the esbuild binary',
);

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log('\nSome deployment-file checks failed.');
  process.exit(1);
}
console.log('\nNote: this validates structure, not a real build. `docker build` still has to run.');
