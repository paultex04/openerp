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

export function loadEnvFile(path: string = resolve(repoRoot, '.env')): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}
