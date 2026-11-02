/**
 * Minimal zero-dependency `.env` loader for the API process.
 *
 * Existing `process.env` values always win, so container/CI environment
 * variables override the file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where `.env` lives.
 *
 * Two layouts are in play. From `server/src/lib/env.ts` the repository root is
 * three levels up, which is correct under `tsx` and under Vitest. The production
 * bundle is a single file at `server/dist/index.js`, where the same relative
 * walk lands one level short and `.env` is not found at all — the API then aborts
 * with "DATABASE_URL: expected string, received undefined" even though the file is
 * right there. Searching outward covers both without either build having to know
 * which one it is.
 */
function findEnvFile(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function parseEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quoteChar = value[0];
    const quoted =
      (quoteChar === '"' || quoteChar === "'") && value.length > 1 && value.endsWith(quoteChar);

    if (quoted) {
      value = value.slice(1, -1);
      if (quoteChar === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export function loadEnvFile(path?: string): Record<string, string> {
  const target = path ?? findEnvFile() ?? resolve(repoRoot, '.env');
  const parsed = existsSync(target) ? parseEnv(readFileSync(target, 'utf8')) : {};
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  // Auto-resolve or rewrite DATABASE_URL in Docker / production
  const isProdOrDocker = process.env.NODE_ENV === 'production' || existsSync('/.dockerenv');
  const host = process.env.DB_HOST || (isProdOrDocker ? 'db' : 'localhost');
  const port = process.env.DB_PORT || '5432';
  const user = process.env.POSTGRES_USER || process.env.DB_USER || 'openerp';
  const pass = process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || 'openerp';
  const db = process.env.POSTGRES_DB || process.env.DB_NAME || 'openerp';

  if (!process.env.DATABASE_URL) {
    if (isProdOrDocker || process.env.POSTGRES_PASSWORD) {
      process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}?schema=public`;
    }
  } else if (isProdOrDocker) {
    let url = process.env.DATABASE_URL;
    url = url.replace(/@(localhost|127\.0\.0\.1):/, `@${host}:`);
    url = url.replace('placeholder:placeholder', `${user}:${pass}`);
    url = url.replace('/placeholder', `/${db}`);
    process.env.DATABASE_URL = url;
  }

  return parsed;
}
