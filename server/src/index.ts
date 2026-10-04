/**
 * Server entrypoint.
 *
 * Loads .env, builds the app and starts listening. Any configuration problem
 * (missing DATABASE_URL, weak JWT secret, insecure cookie in production) throws
 * during `loadConfig()` and aborts the boot rather than starting vulnerable.
 */
import { buildApp } from './app.js';
import { loadEnvFile } from './lib/env.js';
import { loadConfig } from './config.js';
import { prisma } from './db/client.js';

loadEnvFile();

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
