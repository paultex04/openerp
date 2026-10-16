# ADR-013: Chat is a dock; membership is its boundary, and delivery starts as polling

- **Status:** accepted (steps 1–3 of 3 implemented — see _Phasing_ below)
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

Step 2 adds `GET /api/chat/stream` beside these endpoints — server-sent events
written straight onto the hijacked socket — and keeps the poll as the reconnect
path. While the stream is open the client stretches the intervals to a slow safety
net rather than removing them; the moment it drops, the step-1 cadence returns.
Frames are fanned out from a single in-process event bus
(`server/src/chat/events.ts`), which is sound precisely because Coolify runs one
API instance.

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
- `edited_at` and `deleted_at` exist but are unwritten: edit and delete are
  explicitly **not** in v1 — decided with step 2 — because an edit only earns its
  keep once it broadcasts over the stream, and that is a later concern. The
  columns mean the feature needs no `ALTER` when it lands.

### RBAC: two keys, granted to every role

`chat.read` (list conversations, read history, mark read, the account directory,
download an image, search) and `chat.write` (open a conversation, send a message,
signal typing, upload an image), in the `chat` category. Every built-in role holds
both — chat is cross-cutting — so the grant lives in one `CHAT_GRANTS` constant
rather than being repeated, and forgotten, in five lists.

### Attachments, search and notifications (step 3)

- **Images live in the database.** A `message_attachment` row holds the bytes
  (`bytea`), the processed dimensions and the mime. The API container has no
  persistent volume, and the profile avatar already set the precedent: upload,
  decode and re-encode with `sharp`, store the result. One attachment per message
  in v1 (`message_id` is unique), but it is a table, so "more than one" is a later
  change of constraint rather than a reshape of `message`.
- **The image is never stored as sent.** `sharp` applies EXIF orientation, scales
  the image to fit inside 1600px without enlarging it, and writes WebP. The stored
  width and height travel with the message so the thread can reserve the right
  aspect ratio before the bytes arrive, which is what stops it jumping as images
  load. Bytes are fetched from `GET /api/chat/attachments/:id`, membership-checked
  against the message's conversation and served `immutable` — the bytes never
  change under an id.
- **Search is `ILIKE`.** `GET /api/chat/search` matches message bodies across the
  caller's own conversations only — membership is the boundary here too. A
  leading-wildcard match cannot use a btree index; at this size that is the honest
  trade, and full-text search is a later change with its own column and migration.
- **Notifications are the browser's.** When a `message` frame arrives for a
  conversation the user is not looking at, and the tab is hidden or elsewhere, the
  client raises a desktop `Notification`. Permission is asked on the gesture that
  opens the dock, because the browser will not prompt without one, and the in-app
  unread badge is the fallback when it is declined.

## Phasing

| Step | Scope                                                                     | State       |
| ---- | ------------------------------------------------------------------------- | ----------- |
| 1    | Schema + migration + RBAC + REST + dock/page UI on polling                | **shipped** |
| 2    | `GET /api/chat/stream` (SSE), typing and presence, per-message receipts   | **shipped** |
| 3    | Attachments (image-first, via `sharp`), notifications, server-side search | **shipped** |

## Consequences

- The unread badge is the only thing that polls when nothing is open, so an idle
  tab is cheap.
- A pinned dock narrows every page by 22rem at `lg` and above. That is a real
  cost, which is why it is opt-in and persisted rather than a default.
- Step 1 delivered on polling, so a message could take up to 4s to appear when the
  sender was the other person. Step 2 removes that window: a frame arrives as it is
  published, so the delay is the network, not an interval.
- The SSE route streams through the Route Handler proxy, which forwards the body
  unwrapped, so it sets `Cache-Control: no-cache` and `X-Accel-Buffering: no` and
  the proxy forwards the latter. It needed **no** rate-limit exemption: there is no
  global limiter, only per-route caps on the credential endpoints.
- The event bus is process-local, so a second API instance would split it — a
  message published on one instance would not reach a browser on the other. That is
  a deliberate single-instance assumption, recorded here and in the deployment
  guide, and the one module that has to change if that ever stops being true.
- A chat image is a `bytea` row, so the database grows with image volume rather
  than an object store. Bounded (5 MB in, WebP out, one per message) and honest at
  this scale; moving bytes to object storage is the change if volume ever makes the
  database the wrong place for them.

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
