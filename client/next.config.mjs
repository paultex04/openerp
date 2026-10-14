/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * No `rewrites()` proxy for `/api/*`.
   *
   * One was tried and removed: it never matched, so every proxied call returned
   * 404 with nothing logged. Forwarding is handled instead by the Route Handler at
   * `src/app/api/[...path]/route.ts`, which takes precedence over both rewrites
   * and 404s. See that file for the full rationale.
   *
   * ---------------------------------------------------------------------------
   * TURBOPACK: why this file still carries a `webpack()` config
   * ---------------------------------------------------------------------------
   *
   * Next 16 builds with Turbopack by default, and `npm run build` here passes
   * `--webpack` deliberately. The reason is the `extensionAlias` hook below,
   * which has no working Turbopack equivalent:
   *
   *   `@openerp/shared` is a workspace-internal TypeScript package using
   *   `moduleResolution: "bundler"`, so its relative imports are extensionless.
   *   An earlier version used explicit `.js` extensions (as ESM requires under
   *   `NodeNext`); TypeScript and Vitest resolve those to the `.ts` source, but a
   *   bundler does not, and every commercial screen failed at runtime with
   *   "Module not found: Can't resolve './money.js'" while `tsc --noEmit` passed
   *   and every test was green.
   *
   * Turbopack has no `extensionAlias` (a map from one extension to an ordered
   * list of candidates). `turbopack.resolveAlias` is a condition/value map, not a
   * wildcard rewriter, so `'*.js': ['*.ts', '*.tsx', '*.js']` compiles but does
   * not resolve - it fails at build time with the same "Can't resolve
   * './schemas/enums.js'" the alias exists to prevent. That was tried and
   * reverted. Tracked upstream as vercel/next.js#82945.
   *
   * So the build is pinned to webpack. `npm run build:turbopack` in
   * `client/package.json` runs the default builder, and is there to make the
   * failure reproducible in one command rather than a paragraph. Drop the
   * `--webpack` flag (and this block) once #82945 lands.
   *
   * `next dev` is unaffected: it uses Turbopack, which resolves the
   * extensionless imports this package uses everywhere. The gap is specific to
   * an explicit `.js` specifier under a build.
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
