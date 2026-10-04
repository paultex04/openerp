/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * No dev proxy for `/api/*`.
   *
   * One was tried and removed. It looked attractive — same-origin requests mean
   * the session cookie is unambiguously first-party — but the rewrite silently
   * failed to match and every proxied call returned 404, which is a far more
   * confusing failure than a working cross-origin call.
   *
   * Calling the API directly is safe here because `localhost:3000` and
   * `localhost:4000` are the *same site* (the port is not part of the site
   * calculation), so a `SameSite=Lax` session cookie is still sent. The API
   * enables CORS with `credentials: true` and an explicit `CLIENT_ORIGIN`.
   *
   * Set `NEXT_PUBLIC_API_BASE_URL` to the API's absolute origin to use this path.
   */

  /**
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
