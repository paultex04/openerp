/**
 * The API's advertised version.
 *
 * One source of truth: the root `package.json` version, injected at bundle time
 * by `build.mjs` as `__APP_VERSION__`. Under `tsx` (dev, tests) no define exists,
 * so the fallback walks up to the nearest `package.json` — from `server/src` or
 * `server/dist` that is always `server/package.json`, whose version is bumped in
 * lockstep with the root manifest (asserted by `npm run check:docker`).
 *
 * This module exists because `/health` once hardcoded `0.1.0` while the manifests
 * said `0.2.0` and the git tag said `v2.1.0` — three live numbers, none of them
 * wrong on purpose. Do not hardcode a version anywhere; import this.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __APP_VERSION__: unknown;

/** Nearest `package.json` walking up from this module; `undefined` if unreadable. */
function readManifestVersion(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 3; depth += 1) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : undefined;
      } catch {
        return undefined;
      }
    }
    dir = resolve(dir, '..');
  }

  return undefined;
}

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string'
    ? __APP_VERSION__
    : (readManifestVersion() ?? '0.0.0-unknown');
