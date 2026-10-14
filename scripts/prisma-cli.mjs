/**
 * Runs the Prisma CLI with `server/prisma.config.ts`.
 *
 * WHY THIS EXISTS
 *
 * Prisma 7 moved schema and datasource configuration into `prisma.config.ts`, and
 * that file must sit at the root of the project it describes — which is `server/`,
 * where the `prisma` devDependency lives. Running `npx prisma <cmd>` from the
 * repository root therefore finds no config and fails with "schema.prisma: file
 * not found", because the root has no `prisma/` directory.
 *
 * `--config` is passed explicitly rather than relied on by discovery so the path
 * is correct regardless of the caller's working directory. Extra arguments are
 * forwarded verbatim, so `npm run db:push -- --accept-data-loss` works.
 *
 * Usage: node scripts/prisma-cli.mjs generate
 *        node scripts/prisma-cli.mjs db push
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(repoRoot, 'server', 'prisma.config.ts');

if (!existsSync(configPath)) {
  console.error(`prisma config not found at ${configPath}`);
  process.exit(1);
}

const args = ['prisma', ...process.argv.slice(2), '--config', configPath];

// `npx` rather than a direct binary path: npm puts the workspace-hoisted Prisma
// binary on PATH for scripts, and npx resolves the same one everywhere else.
const result = spawnSync('npx', args, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
