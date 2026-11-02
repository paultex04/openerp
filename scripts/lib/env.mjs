/**
 * Minimal zero-dependency `.env` loader.
 *
 * Parses KEY=value pairs, ignoring comments and blank lines, and supports
 * optional single/double quoting plus `\n` escapes inside double quotes.
 * Existing `process.env` values always win so CI/host env can override `.env`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseEnv(src) {
  const out = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);

    if (quoted) {
      value = value.slice(1, -1);
      if (rawLine.trim()[eq + 1] === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
    } else {
      // Strip trailing inline comment on unquoted values.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export function loadEnvFile(path = resolve(repoRoot, '.env')) {
  if (existsSync(path)) {
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }

  // Auto-resolve or rewrite DATABASE_URL: never allow placeholder or localhost inside a container
  const host = process.env.DB_HOST || 'db';
  const port = process.env.DB_PORT || '5432';
  const user = process.env.POSTGRES_USER || process.env.DB_USER || 'openerp';
  const pass = process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || 'openerp';
  const db = process.env.POSTGRES_DB || process.env.DB_NAME || 'openerp';

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('placeholder@localhost')) {
    process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}?schema=public`;
  } else if (process.env.DATABASE_URL.includes('@localhost:') || process.env.DATABASE_URL.includes('@127.0.0.1:')) {
    let url = process.env.DATABASE_URL;
    url = url.replace(/@(localhost|127\.0\.0\.1):/, `@${host}:`);
    url = url.replace('placeholder:placeholder', `${user}:${pass}`);
    url = url.replace('/placeholder', `/${db}`);
    process.env.DATABASE_URL = url;
  }

  return process.env;
}
