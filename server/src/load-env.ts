/**
 * Loads `.env` into `process.env` as a side effect of being imported.
 *
 * This module exists so the load can be *ordered* rather than hoisted.
 *
 * `db/client.ts` reads `DATABASE_URL` at module evaluation, so any file that
 * statically imports it evaluates that module before its own first statement.
 * A `loadEnvFile()` call at the top of `index.ts` therefore ran too late and the
 * API aborted with "DATABASE_URL is not set" despite `.env` being present.
 * Importing this module first is an ESM guarantee rather than a convention:
 * `import './load-env.js'` is evaluated before every later import in the file.
 *
 * Existing environment variables always win - container and CI values override
 * the file - which is what `loadEnvFile()` already implements.
 */
import { loadEnvFile } from './lib/env.js';

loadEnvFile();
