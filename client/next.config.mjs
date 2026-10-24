/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  /**
   * No `rewrites()` proxy for `/api/*`.
   *
   * One was tried and removed: it never matched, so every proxied call returned
   * 404 with nothing logged. Forwarding is handled instead by the Route Handler at
   * `src/app/api/[...path]/route.ts`, which takes precedence over both rewrites
   * and 404s. See that file for the full rationale.
   *
   * ---------------------------------------------------------------------------
   * TURBOPACK: the `extensionAlias` workaround has been removed
   * ---------------------------------------------------------------------------
   *
   * Until Phase 14 this file carried a `webpack()` hook that aliased `.js` imports
   * to the `.ts`/`.tsx` source, plus an empty `turbopack: {}` so `next dev` would
   * still boot with a webpack config present. It existed because `@openerp/shared`
   * is consumed as TypeScript source and *used to* carry explicit `.js`
   * specifiers on some relative imports; Turbopack has no `extensionAlias`
   * equivalent (vercel/next.js#82945).
   *
   * The shared package now uses extensionless relative imports exclusively, and
   * both builders resolve those with defaults. Verified 2026-10-15: a plain
   * `next build` (Turbopack) produces the full route table with no config hook.
   * If a bundler-resolution problem ever returns, the webpack fallback is
   * `npm run build:webpack --workspace client`, and the fix should be a decision
   * here rather than a silent re-add of this block.
   */
};

export default nextConfig;
