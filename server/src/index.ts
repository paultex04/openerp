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

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { prisma } from './db/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await prisma.$disconnect();
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
