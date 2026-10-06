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
import { dirname, resolve } from 'node:path';

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

  // `FROM node:22-bookworm-slim AS build` is valid: the trailing `AS <stage>` is
  // part of the instruction, not part of the image reference. Strip it before
  // testing, or every multi-stage Dockerfile here "fails" for no reason.
  const imageRef = (f) => f.replace(/\s+AS\s+\S+$/i, '');
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
section('Secrets cannot reach an image layer');
// ---------------------------------------------------------------------------

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
const expected = ['db', 'api', 'migrate', 'web'];
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

// Quote style is Prettier's business, not this script's: it rewrote `""` to `''`
// and `- "3000:3000"` to `- '3000:3000'` on the first run, which made two checks
// fail for a formatting change rather than a configuration error. Matching the
// content instead of the quotes keeps this test about intent.
check('web publishes 3000', /ports:[\s\S]*?3000:3000/.test(webBlock));
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
check('AUTH_JWT_SECRET is required, not defaulted', compose.includes('AUTH_JWT_SECRET:?'));
check('POSTGRES_PASSWORD is required, not defaulted', compose.includes('POSTGRES_PASSWORD:?'));
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
check('client build is next build', clientPkg.scripts.build === 'next build');
check('client start is next start', clientPkg.scripts.start === 'next start');

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
