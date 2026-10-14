/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved every CLI-facing setting out of `schema.prisma` and into this
 * file. Two consequences matter here:
 *
 *  1. `datasource.url` is no longer legal in the schema — the CLI rejects it with
 *     P1012 and tells you to come here. The *runtime* connection string is now
 *     supplied by the driver adapter in `src/db/client.ts`, not by the schema.
 *  2. Environment variables are not loaded automatically any more. `.env` is
 *     read by `scripts/lib/env.mjs` in the same way the migration runner and the
 *     smoke tests already do, rather than by adding `dotenv` as a dependency.
 *
 * The path is resolved relative to this file, so `prisma generate` and
 * `prisma db push` behave the same whether they are invoked from `server/` or
 * from the repository root.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

import { loadEnvFile } from '../scripts/lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Same loader the migration runner uses: it walks up from the repository root and
// populates `process.env` from `.env` without overwriting real environment
// variables, which is what keeps this correct inside a container where Coolify
// injects the real value.
loadEnvFile(resolve(here, '../.env'));

export default defineConfig({
  schema: resolve(here, 'prisma/schema.prisma'),
  migrations: {
    path: resolve(here, 'prisma/migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
