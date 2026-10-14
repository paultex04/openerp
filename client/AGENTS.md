<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## OpenERP notes for this workspace

Generated content above; this section is ours and `next dev` leaves it alone.

- **The build is `next build --webpack`, and `turbopack: {}` in
  `client/next.config.mjs` is required.** Turbopack has no
  `resolve.extensionAlias`, and `@openerp/shared` is consumed as TypeScript
  source. See the long note in `next.config.mjs` and vercel/next.js#82945.
- **`middleware.ts` is deprecated in favour of `proxy.ts`** in this version.
  Next still runs it and warns on every dev boot. Renaming is a mechanical
  codemod (`npx @next/codemod@canary middleware-to-proxy .`) that has not been
  applied here.
- **`next-env.d.ts` is generated.** Do not hand-edit it; the reference style
  changed in Next 16.
- **Base UI, not Radix.** Components in `src/components/ui/` take a `render`
  prop rather than `asChild`. That directory is owned by the shadcn registry and
  is excluded from lint because `shadcn add --overwrite` replaces it wholesale.
