/**
 * Waits until the database in DATABASE_URL accepts a query.
 *
 * WHY THIS EXISTS
 *
 * The Forgejo workflow starts Postgres as a service container. The container is
 * "up" well before Postgres inside it is ready to accept connections, and the
 * Forgejo runner's support for container healthchecks varies between versions.
 * Polling here is version-proof, and it costs nothing extra: `pg` is already a
 * root devDependency.
 *
 * Usage:
 *   node scripts/wait-for-db.mjs [seconds]     (default: 60)
 *
 * Exits 0 the moment `SELECT 1` succeeds, 1 after the timeout, 2 when
 * DATABASE_URL is unset.
 */
import pg from 'pg';
import { loadEnvFile } from './lib/env.mjs';

loadEnvFile();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const timeoutSeconds = Number(process.argv[2] ?? 60);
const deadline = Date.now() + timeoutSeconds * 1000;

let lastError = 'no attempt made';

while (Date.now() < deadline) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log('database is accepting connections');
    process.exit(0);
  } catch (error) {
    lastError = error.message;
    await client.end().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

console.error(`database was not ready within ${timeoutSeconds}s: ${lastError}`);
process.exit(1);
