# ADR-014: Sliding Session Refresh, Request Streaming & In-App Backup Automation

- **Status:** accepted & implemented
- **Date:** 2026-11-03
- **Context:** Hardening production stability, session lifecycle, and business continuity for OpenERP v2.7.8.

---

## 1. Sliding Session Refresh

### Problem
Previously, OpenERP issued a single JWT in an HTTP-only cookie (`openerp_session`) with a 15-minute expiration time. Users working in active sessions (e.g. entering timesheet matrices or editing complex master data) were abruptly logged out when the 15-minute timer elapsed, resulting in discarded work and user friction.

### Decision
We implemented a two-token sliding refresh architecture:
1. **Access Token (`openerp_session`):** Short-lived (15 minutes), containing user ID, role claims, and `tokenVersion`, signed with `typ: 'access'`.
2. **Refresh Token (`openerp_session_refresh`):** Long-lived (7 days), signed with `typ: 'refresh'`.
3. **Endpoint (`POST /api/auth/refresh`):** Does not enforce `app.authenticate` pre-handler so that expired access tokens do not block refresh. Instead, it directly verifies the refresh cookie, checks that the user's `tokenVersion` matches the database (preventing revoked tokens from refreshing), and rotates both cookies.
4. **Client-Side Transparent Replay:** In `client/src/lib/api.ts`, a 401 response triggers `attemptSessionRefresh()`, which acquires a single-flight mutex, refreshes the cookies in the background, and seamlessly replays the failed request once.

---

## 2. Full-Duplex Next.js API Request Streaming

### Problem
In `client/src/app/api/[...path]/route.ts`, incoming requests were previously read in full via `await request.arrayBuffer()` before being forwarded to Fastify. For large multipart uploads (high-resolution profile avatars, PDF drawings, timesheet attachments), this consumed substantial Node.js heap memory inside the Web container and risked container OOM crashes under concurrency.

### Decision
For all non-GET/HEAD methods, the incoming `request.body` is forwarded directly as a raw `ReadableStream` with Node's `duplex: 'half'`. The Web container buffers zero bytes in RAM, allowing full-speed streaming directly into Fastify and S3 object storage.

---

## 3. Autonomous In-App Database Backups & S3 Redundancy

### Problem
Previous backup procedures relied entirely on host-level `docker exec` commands or external orchestration. If host scripts failed silently, database snapshots were not created, and restoring required host shell access.

### Decision
We built an autonomous, in-app backup service:
1. **Queue Integration:** Leverages the existing PostgreSQL-backed `pg-boss` queue (`server/src/queue/`).
2. **Nightly Schedule:** Cron schedule registered at `0 2 * * *` (02:00 UTC).
3. **Dump Engine:** Executes `pg_dump` with compressed binary archive format (`-F c`). If `pg_dump` binary is absent, it falls back to a transactional pure-SQL export via `dbPool`.
4. **Dual Storage & 14-Day Retention:** Dumps are uploaded to **Garage S3** (`backups/`) and also saved to local disk (`data/backups/`). Backups older than 14 days are automatically pruned on each execution.
5. **UI Diagnostics Panel:** In `/admin?tab=diagnostics`, administrators can view existing backups, trigger an on-demand snapshot with real-time feedback, and download backup archives directly.

---

## 4. Multi-Point Incident Diagnostics Modal

### Problem
When unexpected runtime errors or API failures occurred, users had no standardized way to report errors with sufficient technical context (URL, user role, user agent, error stack, correlation IDs) for engineering resolution.

### Decision
We created a unified Incident Report Modal (`client/src/components/support/incident-report-modal.tsx`) accessible via three intuitive touchpoints:
1. **Nav Rail Footer:** Persistent Lifebuoy icon in the primary navigation rail.
2. **Error Toasts:** Subtle "Report Issue" action button embedded directly in all error toasts.
3. **Route Error Boundary (`error.tsx`):** "Report Issue" button for unhandled Next.js rendering exceptions.

The modal automatically collects runtime telemetry, lets the user type optional steps to reproduce, and copies a GitHub/Forgejo/Slack/Teams-ready Markdown report to clipboard in one click.
