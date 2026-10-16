# ADR-013: Chat is a dock; membership is its boundary, and delivery starts as polling

- **Status:** accepted (step 1 of 3 implemented — see _Phasing_ below)
- **Date:** 2026-10-16
- **Supersedes:** nothing. Stands beside [ADR-006](adr-006-enterprise-ui-overhaul.md)
  (the shell this hangs off) and follows the RBAC conventions of
  [ADR-001](adr-001-baseline-findings.md).

## Context

The business asked for messaging inside the app: people already talk about a job
or a timesheet, but never in the same place the job or the timesheet lives, and
never in a way anyone can find again. The requirement came with two constraints
that decided most of the design:

1. It has to be reachable from **everywhere**, not a page you remember to visit.
2. The stack has **no realtime infrastructure at all** — no WebSocket server, no
   message broker, no background worker, and `web` is plain `next start` with no
   custom server.

The obvious shortcut — a `refetchInterval` on a messages page — is what step 1
does anyway, but it cannot be the whole answer, because "I have to refresh to see
a reply" is the one thing people will not forgive a chat for. The second obvious
shortcut — WebSockets — does not survive contact with the proxy: the browser calls
the API through the Next Route Handler at `app/api/[...path]`, which is an ordinary
request/response function. It cannot complete an HTTP `Upgrade`, so a WebSocket
opened against it never becomes one.

## Decision

### Transport: SSE, not WebSockets — and polling first

Server-Sent Events travel as an ordinary chunked HTTP response, so they pass
through the existing same-origin proxy unchanged. WebSockets do not. SSE is
therefore the live transport, chosen for the boundary it fits rather than for
elegance.

Step 1 nonetheless ships **polling**, deliberately:

- It works through the proxy today with no new failure modes to discover.
- It is the fallback the SSE step falls back _to_, so it is not throwaway work.
- A short interval while a conversation is open (4s) and a long one otherwise
  (8s, and paused when the tab is hidden) is indistinguishable from live for the
  volume this app will see.

The SSE step adds `GET /api/chat/stream` beside these endpoints and keeps the
poll as the reconnect path.

### Scope: 1:1 direct conversations only, in v1

A conversation is between two accounts. Group, job-scoped and project-scoped
conversations are **modelled** — `conversation.kind` is an enum with `JOB`,
`PROJECT` and `GROUP` alongside `DM` — but only `DM` is created. The table is
shaped so a later step adds rows, not columns.

### Placement: a right-hand dock, overlay by default, pin on request

Chat is hosted in the shell (`AppShell`), so a conversation survives navigation:

- A **header toggle** in the right cluster, carrying an unread badge.
- An **overlay panel** (fixed, below the header) by default — the app is mostly
  full-width tables, and a dock that reflowed them the moment a message arrived
  would be a layout bug, not a feature.
- An **opt-in pin** that makes the panel a real flex column beside the content,
  available only at `lg` and above. Both the open and pinned states persist per
  device through `lib/shell-preferences.ts`.
- A **full-page `/messages`** view that renders the same components with room to
  breathe, for reading a long thread or a shareable link.

### Data model: membership is the boundary; unread is derived

Three tables: `conversation`, `conversation_member`, `message`.

- A DM's identity is `dm_key`, the two account ids sorted and joined (`"3:7"`),
  unique. Opening a conversation that exists returns it, so two people clicking
  "message" at the same time land in one thread. The unique index is the
  guarantee; the lookup is the fast path.
- **There is no "read everyone's messages" permission.** Visibility is
  membership, which is a fact about the row, not a capability a role grants. A
  non-member gets a **404, not a 403**, so a guessed or leaked conversation id
  reveals nothing — not even that it exists.
- **Unread is derived, never stored.** A member's unread count is messages from
  someone else newer than their `last_read_at`. Nothing is written when a message
  arrives, so there is no counter to drift across tabs or devices.
- `client_token` makes a send idempotent: a retry after a dropped connection
  returns the original message rather than posting a duplicate.
- `edited_at` and `deleted_at` exist but are unwritten in step 1, so edit and
  delete need no `ALTER` later.

### RBAC: two keys, granted to every role

`chat.read` (list conversations, read history, mark read, the account directory)
and `chat.write` (open a conversation, send a message), in the `chat` category.
Every built-in role holds both — chat is cross-cutting — so the grant lives in one
`CHAT_GRANTS` constant rather than being repeated, and forgotten, in five lists.

## Phasing

| Step | Scope                                                                     | State       |
| ---- | ------------------------------------------------------------------------- | ----------- |
| 1    | Schema + migration + RBAC + REST + dock/page UI on polling                | **shipped** |
| 2    | `GET /api/chat/stream` (SSE), typing and presence, per-message receipts   | planned     |
| 3    | Attachments (image-first, via `sharp`), notifications, server-side search | planned     |

## Consequences

- The unread badge is the only thing that polls when nothing is open, so an idle
  tab is cheap.
- A pinned dock narrows every page by 22rem at `lg` and above. That is a real
  cost, which is why it is opt-in and persisted rather than a default.
- Because delivery is polling in step 1, a message can take up to 4s to appear
  when the sender is the other person. Step 2 removes that window.
- Step 2's SSE route must stream through the Route Handler proxy, so it needs
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`, must not be buffered by
  Coolify's Traefik, and needs a rate-limit exemption. That is noted on the
  deployment guide with step 2.

## Rejected alternatives

- **WebSockets.** Cannot traverse the Next Route Handler proxy — no HTTP
  `Upgrade` — so they would require a second, directly-exposed origin, which the
  architecture deliberately avoids.
- **A pragmatic `refetchInterval` on a messages page only.** Fails "reachable
  from everywhere" and makes a reply feel broken.
- **A global "read all messages" permission for administrators.** Turns the
  boundary from a fact about the data into a privilege, and makes every future
  group conversation a moderation problem.
- **Storing an unread counter per member.** A second thing to keep true; derived
  from `last_read_at` it cannot drift.
