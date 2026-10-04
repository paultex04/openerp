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
   * `@openerp/shared` is a workspace-internal TypeScript package using
   * `moduleResolution: "bundler"`, so its relative imports are extensionless.
   *
   * This matters: an earlier version used explicit `.js` extensions (as ESM
   * requires under `NodeNext`). TypeScript and Vitest resolve those to the `.ts`
   * source, but webpack — which builds the client — does not, and every
   * commercial screen failed at runtime with
   * "Module not found: Can't resolve './money.js'" while `tsc --noEmit` passed and
   * every test was green.
   *
   * `extensionAlias` is retained as a belt-and-braces mapping so a stray `.js`
   * import introduced later fails loudly here rather than breaking the build.
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
