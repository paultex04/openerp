<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## OpenERP notes for this workspace

Generated content above; this section is ours and `next dev` leaves it alone.

- **The build is plain `next build` (Turbopack).** The `extensionAlias` webpack
  workaround was removed in Phase 14 after `@openerp/shared` stopped using `.js`
  specifiers on relative imports; both builders now resolve the package from
  defaults. `npm run build:webpack --workspace client` remains as a fallback if a
  bundler-resolution problem ever returns. See the note in `next.config.mjs`.
- **`proxy.ts`, not `middleware.ts`.** The Next 16 rename was applied in Phase 14
  with the official codemod; the export is `proxy` and the `config.matcher` is
  unchanged. Do not reintroduce a `middleware.ts`.
- **`next-env.d.ts` is generated.** Do not hand-edit it; the reference style
  changed in Next 16.
- **Base UI, not Radix.** Components in `src/components/ui/` take a `render`
  prop rather than `asChild`. That directory is owned by the shadcn registry and
  is excluded from lint because `shadcn add --overwrite` replaces it wholesale.
