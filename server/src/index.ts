/**
 * Server entrypoint.
 *
 * Loads .env, builds the app and starts listening. Any configuration problem
 * (missing DATABASE_URL, weak JWT secret, insecure cookie in production) throws
 * during `loadConfig()` and aborts the boot rather than starting vulnerable.
 *
 * ---------------------------------------------------------------------------
 * `loadEnvFile()` before the other imports is load-bearing, not style
 * ---------------------------------------------------------------------------
 *
 * `db/client.ts` reads `process.env.DATABASE_URL` at *module evaluation* and
 * throws if it is missing. Under Prisma 6 the client was lazy, so importing it
 * evaluated nothing and a `loadEnvFile()` statement at the top of this file
 * always ran first. The Prisma 7 client is not lazy - `db/client.ts` constructs
 * `new PrismaPg({ connectionString })` at the top level - so a plain static
 * import of it evaluates that module before any statement here, and the API
 * aborted with "DATABASE_URL is not set" while `.env` sat unread next to it.
 *
 * A side-effect import of a dedicated module keeps the ordering explicit: ESM
 * evaluates `./load-env.js` before every later import in this file, so the load
 * cannot be hoisted past the client by a refactor, an import sorter, or a
 * `noUnusedLocals` fix that "tidies away" a call whose return value is unused.
 * The production bundle is unaffected (esbuild inlines it) and Vitest never
 * loads this file.
 */
import './load-env.js';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { prisma, dbPool } from './db/client.js';

// Global resilience handlers: absorb unexpected connection dropouts and log cleanly
process.on('uncaughtException', (err: unknown) => {
  console.error('[process:uncaughtException]', err instanceof Error ? err.stack || err.message : err);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[process:unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
});

async function bootstrapDatabase(): Promise<void> {
  try {
    const check = await dbPool.query<{ present: boolean }>(
      `SELECT to_regclass('public.employee_contract_type') IS NOT NULL AS present`,
    );
    if (!check.rows[0]?.present) {
      console.log('[boot] Database is empty. Automatically initializing schema from schema.sql...');
      const schemaSqlPath = resolve(process.cwd(), 'server/prisma/schema.sql');
      const altPath = resolve(process.cwd(), 'prisma/schema.sql');
      const target = existsSync(schemaSqlPath) ? schemaSqlPath : altPath;
      if (existsSync(target)) {
        const sql = readFileSync(target, 'utf8');
        const client = await dbPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migration_ledger (
              name text PRIMARY KEY,
              checksum text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
          `);
          await client.query('COMMIT');
          console.log('[boot] Schema initialized successfully!');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    }
  } catch (err) {
    console.warn('[boot] Could not verify/initialize schema on boot:', err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  await bootstrapDatabase();
  const app = await buildApp({ config });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => process.exit(1), 8_000);
    forceExit.unref();
    try {
      await app.close();
      await prisma.$disconnect();
      await dbPool.end();
    } catch (err) {
      app.log.error({ err }, 'error during graceful shutdown');
    }
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((error: unknown) => {
  console.error('Failed to start OpenERP API:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
