/**
 * Bundles the API and the bootstrap seed into runnable ESM files.
 *
 * WHY THIS EXISTS
 *
 * `server/package.json` claimed `"build": "tsc -p tsconfig.json"` and
 * `"start": "node dist/index.js"`, but `server/tsconfig.json` sets
 * `"noEmit": true` — it exists to typecheck. So `dist/` was never created and
 * `npm start` had never run. The API only ever executed under `tsx`, which
 * type-strips at runtime. That is fine in development and disqualifying for a
 * container, where `tsx` would have to be a production dependency.
 *
 * A second problem rules out simply switching `tsc` to emitting:
 *
 *   - `@openerp/shared` has no build step; its `main` and `exports` point at
 *     `./src/index.ts`, so the API imports TypeScript source at runtime. Plain
 *     Node cannot load a `.ts` file.
 *   - `shared/src` uses *extensionless* relative imports (`from '../money'`),
 *     which is legal under `moduleResolution: "bundler"` and required by the
 *     Next.js client. TypeScript would copy them into the emitted JS unchanged
 *     and Node's ESM resolver would reject every one.
 *
 * Bundling sidesteps both. esbuild resolves the workspace package and the
 * extensionless specifiers at build time, and emits one file with no import of
 * `@openerp/shared` left in it. (The Next client has the same property, which is
 * why neither builder needs an `extensionAlias` shim — see `next.config.mjs`.)
 *
 * WHAT STAYS EXTERNAL
 *
 * `@prisma/client` and `bcryptjs` must NOT be bundled:
 *
 *   - The Prisma client resolves its query engine at runtime relative to
 *     `node_modules`, and ships platform-specific binaries. Inlining it breaks
 *     `prisma generate` and produces a client that cannot find its engine.
 *   - `bcryptjs` is a native-free but dynamically-required package; keeping it
 *     external is safer than reasoning about its internals.
 *
 * So this is a partial bundle: application code in, platform packages out. The
 * runtime image still installs `node_modules`, which is why the Dockerfile does
 * `npm ci --omit=dev` and then copies `dist/`.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// `build.mjs` sits in `server/`, so the repo root is one level up — not two.
// Two levels up escapes the repository entirely, which is what an earlier draft
// did and what made the first run resolve `C:\Users\Paul\Desktop\Opencode\server`.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * Packages left as runtime `import` statements.
 *
 * `@prisma/client` is the load-bearing entry: its generated client is created by
 * `prisma generate` into `node_modules/.prisma/client` and must be resolvable at
 * runtime from disk.
 */
const EXTERNAL = [
  // The generated client and its driver adapter are written to
  // `src/generated/prisma` by `prisma generate` and must be resolvable from disk
  // at runtime. They stay out of the bundle for the same reason they always did:
  // the client ships platform-specific artefacts that cannot be inlined.
  '@prisma/client',
  '@prisma/adapter-pg',
  'bcryptjs',
  // Fastify, zod, jose and friends bundle cleanly, but they are listed so that a
  // future native dependency fails the build visibly rather than mysteriously.
];

const watch = process.argv.includes('--watch');

// The version `/health` reports comes from the root manifest, frozen into the
// bundle. `server/src/version.ts` explains why it is injected rather than read.
const rootVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

/** @type {import('esbuild').BuildOptions} */
const options = {
  // Two entry points, one output file each:
  //
  //   index.js  the API server
  //   seed.js   the one-off bootstrap seed
  //
  // The seed is bundled for the same reason the API is: it is TypeScript, and the
  // runtime image installs `--omit=dev` and carries no `tsx`. Bundling it lets the
  // production image provision the first administrator and the RBAC catalogue as
  // `node server/dist/seed.js`, from the container, with no dev dependencies and
  // without exposing the database to a laptop. See docs/coolify-deployment.md.
  entryPoints: {
    index: resolve(root, 'server/src/index.ts'),
    seed: resolve(root, 'server/src/db/seed.ts'),
  },
  outdir: resolve(root, 'server/dist'),
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Node runs the output directly, so the emitted file must be treated as ESM even
  // though the repository root package.json already says "type": "module".
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  external: EXTERNAL,
  sourcemap: true,
  minify: false,
  // Keeps the log lines readable and gives a usable stack trace for a 500.
  keepNames: true,
  logLevel: 'info',
  define: {
    // Prisma and Fastify both branch on this; leaving it undefined makes some
    // code paths take the development default.
    'process.env.NODE_ENV': process.env.NODE_ENV ?? '"production"',
    __APP_VERSION__: JSON.stringify(rootVersion),
  },
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(options);
}
