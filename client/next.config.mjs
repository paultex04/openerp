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
   * Next 16 builds with Turbopack by default, and `npm run build` below passes
   * `--webpack` deliberately. The reason is the `extensionAlias` hook, which has
   * no working Turbopack equivalent:
   *
   *   `@openerp/shared` is a workspace-internal TypeScript package using
   *   `moduleResolution: "bundler"`. An earlier version used explicit `.js`
   *   extensions on some relative imports; TypeScript and Vitest resolve those to
   *   the `.ts` source, but a bundler does not, and every commercial screen failed
   *   at runtime with "Module not found: Can't resolve './money.js'" while
   *   `tsc --noEmit` passed and every test was green.
   *
   * Turbopack has no `extensionAlias` (a map from one extension to an ordered
   * list of candidates). `turbopack.resolveAlias` is a condition/value map, not a
   * wildcard rewriter, so `'*.js': ['*.ts', '*.tsx', '*.js']` compiles but does
   * not resolve. Tracked upstream as vercel/next.js#82945.
   *
   * ---------------------------------------------------------------------------
   * The `turbopack` key below is REQUIRED, not decorative
   * ---------------------------------------------------------------------------
   *
   * Next 16 treats "a `webpack` config and no `turbopack` config" as a hard error
   * and refuses to start - `next dev` included, which does not pass `--webpack`
   * and so cannot be fixed by the flag. An empty `turbopack: {}` is the documented
   * way to say "keep Turbopack, the webpack config is for the webpack builder
   * only". Without it, `npm run dev` dies with:
   *
   *   ERROR: This build is using Turbopack, with a `webpack` config and no
   *   `turbopack` config.
   *
   * So both keys are live: `turbopack: {}` lets `next dev` run, and `webpack()`
   * keeps the production build resolvable. Drop the flag (and this whole block)
   * once #82945 lands.
   */

  /**
   * Empty on purpose - see the note above. It exists only so Next stops treating
   * the `webpack()` hook below as an un-migrated config.
   */
  turbopack: {},

  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
