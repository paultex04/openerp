# Phase 15 — Job Management and UX

**Release target:** `v2.2.0`  
**Branch:** `phase/15-job-management-and-ux`

## Scope

Eight items, in the order they were raised:

1. **Job register tidy-up.** The per-row Open button is gone; the job number is the
   link to the job, so the row has one obvious destination instead of two.
2. **Job detail summary re-skin.** The detail page now follows the agreed mock:
   an identity header (`Job #id`, status pill, project · contract · client, and a
   read-only commercial-basis pill), three cards — Job & area, Orders & people,
   Timeline & workflow — a status bar, and a Planned / Actual / Crew strip along the
   bottom. The inline-PATCH save mechanics are unchanged; this is a layout and
   presentation change only.
3. **Field Measurements & Actuals page removed.** The `/field` route and its sidebar
   entry are gone. The field API endpoints (`/api/field/my-work`, per-deliverable
   actual updates) stay: they are the interface a mobile client would use, and the
   server suites exercise them.
4. **New invoice from the invoice register.** A "New invoice" button picks an
   eligible job (server-side `billable` filter, page size 25 plus search), previews
   the lines the invoice would carry, creates the draft and opens it.
5. **Admin-editable job workflow.** Statuses and transitions are now database rows
   with an administration screen to edit them — labels, order, per-status behaviour
   flags, and per-edge capabilities. See
   [ADR-011](adr-011-job-workflow-editor.md).
6. **DataTable fit.** Every DataTable page fills the viewport and scrolls inside the
   table instead of scrolling the document; headers stick while rows scroll. The old
   `fill` prop was removed rather than defaulted, so a caller that still asked for
   the old behaviour became a type error instead of a subtly wrong page.
7. **Client VAT numbers stopped resetting.** This was a test-isolation problem, not
   an application bug: integration suites shared the seeded client's VAT state and
   one of them cleared it. The suites now own purpose-built fixture clients and the
   restore script no longer touches the seeded client at all.
8. **My Profile.** The user menu links to `/profile`, where a signed-in account can
   change its own login email, person details (name, surname, mobile, personal
   email) and password, and upload an avatar. Uploads are re-encoded server-side to
   a 256×256 WebP (auto-oriented, cover-cropped); the generated initials remain the
   fallback.

## Decisions captured

- **Item 2 keeps its save model.** Fields still save individually through
  `PATCH /api/jobs/:id` on blur/change; the mock's "Status bar" is the existing
  transition dropdown, and the commercial-basis pill is informational only — the
  amendment select inside Timeline & workflow remains the one editor for that field.
- **Item 4 is one dialog.** A searchable job picker plus a read-only preview of the
  invoice lines (values from the job's own totals). After creation the new draft
  opens. The button is gated on `invoice.write` with `job.read`.
- **Item 5 in one line** (full detail in ADR-011): the key is the identity and is
  immutable, the label is free text, `sortOrder` is numeric and unique, and the
  guardrails (no deleting a status in use, at least one terminal status, no exits
  from a terminal status, capabilities confined to `job.transition.*`) are enforced
  by the API and reported with specific error codes.
- **Item 6 applies everywhere, including popups.** The commercial register's three
  document-length tabs (rates, parameters, recipes) stay document-scrolled: they are
  reading surfaces, not registers.
- **Item 8 field mapping.** The login email is the account's (`app_user.email`); the
  person fields live on the linked employee record. The avatar belongs to the
  account (bytes, mime type and an `updated_at` used as a cache-buster). Changing
  the password ends the session by design: the client clears its cache and returns
  to the sign-in screen.

## Release checks

- Apply migrations `0006_profile_avatar` and `0007_job_workflow` with
  `npm run db:migrate`, then `npm run db:generate` (CI uses `db:push`, and
  `schema.prisma` already matches).
- `npm run verify`
- `npm run build --workspaces`
- `npm run check:docker`
- `npm run smoke:phase2` … `smoke:phase7`, `smoke:phase13` against a running API.
