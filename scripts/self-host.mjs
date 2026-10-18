/**
 * Builds, starts, migrates and seeds the Compose stack — the one command
 * docs/self-hosting.md tells you to run.
 *
 * ## Why this exists
 *
 * Deploying by hand is three commands in a specific order, and the middle one is
 * easy to skip:
 *
 *   docker compose up -d --build
 *   docker compose --profile tools run --rm migrate
 *   docker compose --profile tools run --rm seed
 *
 * Nothing warns you if you go straight from `up` to opening the site. The app
 * then fails on the first login with a Prisma "relation does not exist" error,
 * which reads as a bug in the application rather than a step that was missed.
 * Putting the order in a script makes the sequence the default instead of a
 * convention to remember.
 *
 * ## What it deliberately does not do
 *
 * It shells out to `docker compose` and stops at the first non-zero exit. No
 * retries, no state, no partial rollback, no health-check polling of its own —
 * Compose already gates the one-off containers on a healthy database. Every
 * step is idempotent (the migration runner records what it applied; the seed
 * upserts), so the recovery from any failure is to run the command again.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Loaded for the pre-flight checks below, which can then name the variable that
// is missing. `docker compose` reads `.env` itself, and these assignments only
// fill gaps, so the two never disagree.
loadEnvFile(resolve(root, '.env'));

function stop(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Runs `docker compose <args>` from the repository root and stops on failure. */
function compose(args, label) {
  console.log(`\n→ ${label}\n  docker compose ${args.join(' ')}\n`);
  const result = spawnSync('docker', ['compose', ...args], { cwd: root, stdio: 'inherit' });

  if (result.error) stop(`Could not run Docker: ${result.error.message}`);
  if (result.status !== 0) {
    stop(
      `\`docker compose ${args.join(' ')}\` exited with code ${result.status}. Nothing else was run.`,
    );
  }
}

// --- Pre-flight -------------------------------------------------------------

// Both are `${VAR:?}` in the compose file, so Compose refuses to interpolate
// without them. Catching it here turns "required variable is missing a value"
// into a sentence, and catches the short secret that `loadConfig()` would
// otherwise report as a runtime crash loop.
const missing = ['POSTGRES_PASSWORD', 'AUTH_JWT_SECRET'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  stop(
    `Missing ${missing.join(' and ')}.\n\n` +
      'Put them in .env (see .env.example), or export them:\n' +
      '  AUTH_JWT_SECRET="$(openssl rand -base64 48)"',
  );
}

if (process.env.AUTH_JWT_SECRET.length < 32) {
  stop(
    'AUTH_JWT_SECRET is shorter than 32 characters. The API refuses to start on\n' +
      'a short secret, so this would surface as a crash loop after the build:\n' +
      '  AUTH_JWT_SECRET="$(openssl rand -base64 48)"',
  );
}

const docker = spawnSync('docker', ['--version'], { stdio: 'ignore' });
if (docker.error || docker.status !== 0) {
  stop(
    'Docker is not on PATH. Install Docker, or run `docker compose` by hand — see docs/self-hosting.md.',
  );
}

// --- Stack ------------------------------------------------------------------

compose(['up', '-d', '--build'], 'Building and starting the stack');

// Migrations and the seed are one-off containers, not services that stay up, and
// they are in the `tools` profile so that `up` cannot start them by accident.
compose(['--profile', 'tools', 'run', '--rm', 'migrate'], 'Applying migrations');

if (process.env.SEED_ADMIN_PASSWORD) {
  compose(['--profile', 'tools', 'run', '--rm', 'seed'], 'Creating the first administrator');
} else {
  console.log(
    '\n→ Skipping the seed: SEED_ADMIN_PASSWORD is not set.\n' +
      '  The RBAC catalogue is provisioned by the migration above, but there is no\n' +
      '  login yet. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env and run:\n' +
      '    docker compose --profile tools run --rm seed',
  );
}

const site = process.env.SITE_ADDRESS || 'localhost';
console.log(`\n✓ Stack is up. Open https://${site}\n`);

if (!process.env.SITE_ADDRESS) {
  console.log(
    '  No SITE_ADDRESS is set, so Caddy served a certificate from its own local\n' +
      '  CA and the browser will warn until you trust it — see docs/self-hosting.md.\n',
  );
}
