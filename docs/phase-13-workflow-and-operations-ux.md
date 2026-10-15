# Phase 13 — Workflow and Operations UX

**Release target:** `v2.1.0`  
**Branch:** `phase/13-workflow-and-operations-ux`

## Scope

1. Fix amendment type and status edit persistence and keep API values consistent.
2. Provision the employee contract types **Monthly Core, Hourly Core, All Inclusive, BCEA, NBCEI** without removing existing catalog entries.
3. Allow user creation to either link an active employee without an account or atomically create a new employee and account.
4. Allow administrators to edit grants on the four built-in non-administrator roles while protecting administrator permissions and preserving an audit trail.
5. Show the invoice register as a full-width list; open invoice details and lifecycle actions in a modal from the invoice-number link.
6. Move job details to a separate page, restore register URL/filter/page/scroll state on Back, and present job metadata in one compact editable card.

## Decisions captured

- Built-in roles only; administrator remains locked to all permissions.
- Invoice popup retains details and current lifecycle/delete actions; draft due date and notes remain editable.
- New-user employee choices are two explicit modes: link existing or create new.
- Job detail exposes all supported editable job metadata. Crew assignments remain a separate operational section.
- The operations register preserves full state on Back using URL state and scroll restoration.

## Release checks

- `npm run verify`
- `npm run build --workspace client`
- Run integration tests against a disposable database with migration `0005_editable_role_permissions` applied. The configured development database must not be migrated implicitly.
