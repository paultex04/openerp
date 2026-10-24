# Garage S3 & Multi-Instance Architecture (Phase 3)

This document details the object storage architecture and multi-instance chat synchronization implemented in OpenERP Phase 3.

---

## 1. Why Garage S3 Object Storage?

Historically, avatars and message attachments were stored directly in PostgreSQL as byte arrays (`bytea`). While convenient during initial bootstrapping, this caused:

- Significant database bloat and memory pressure on `pg_dump` and backup routines.
- Heavy I/O during routine backups as large media files were repeatedly copied alongside structured relational rows.

MinIO has moved away from its lightweight roots and transitioned toward enterprise-heavy licensing and deployment models. **Garage** (`dxflrs/garage:v2.4.1`) is an open-source, lightweight, high-performance distributed object storage engine built in Rust specifically for self-hosters and edge environments.

### Invariant & Graceful Fallback

- If `S3_ENDPOINT` and credentials are provided, OpenERP automatically streams avatars and chat attachments to Garage S3 and stores only `storageKey` (`varchar(255)`) in PostgreSQL.
- If S3 is omitted (e.g. during local tests or stripped-down environments), `isS3Active()` returns `false`, and OpenERP falls back transparently to inline database byte storage, ensuring 100% backward compatibility.

---

## 2. Automated Single-Node Docker Compose Setup

Garage is integrated directly into both `docker-compose.coolify.yml` and `docker-compose.yml`.

### Zero-Touch Auto-Provisioning

Garage is started with `/garage server --single-node`, which automatically:

1. Detects an unconfigured layout.
2. Assigns the node to zone `dc1` with capacity `1`.
3. Applies layout version `1`.
4. Provisions the bucket specified in `GARAGE_DEFAULT_BUCKET` (default: `openerp-attachments`).
5. Generates the access key pair from `GARAGE_DEFAULT_ACCESS_KEY` and `GARAGE_DEFAULT_SECRET_KEY` and assigns read/write permissions.

No manual CLI bootstrapping is required.

### Service Definition

```yaml
garage:
  build:
    context: .
    dockerfile: Dockerfile.garage
  restart: unless-stopped
  command: ['/garage', 'server', '--single-node', '--default-bucket']
  environment:
    GARAGE_DEFAULT_ACCESS_KEY: ${S3_ACCESS_KEY_ID:-GK0123456789abcdef01234567}
    GARAGE_DEFAULT_SECRET_KEY: ${S3_SECRET_ACCESS_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}
    GARAGE_DEFAULT_BUCKET: ${S3_BUCKET:-openerp-attachments}
  volumes:
    - garage-meta:/var/lib/garage/meta
    - garage-data:/var/lib/garage/data
  healthcheck:
    test: ['CMD', '/garage', '-c', '/etc/garage.toml', 'status']
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 15s
```

The API service depends on `garage` being healthy before starting:

```yaml
api:
  depends_on:
    db:
      condition: service_healthy
    garage:
      condition: service_healthy
  environment:
    S3_ENDPOINT: http://garage:3900
    S3_REGION: garage
    S3_BUCKET: ${S3_BUCKET:-openerp-attachments}
    S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-GK0123456789abcdef01234567}
    S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}
    S3_FORCE_PATH_STYLE: 'true'
```

---

## 3. PostgreSQL `LISTEN/NOTIFY` Pub/Sub for Real-Time Chat

OpenERP's real-time chat previously fanned out events only to connected SSE clients in the local Node.js process memory.

In Phase 3:

- A dedicated PostgreSQL listener connects on channel `openerp_chat_events`.
- When an event occurs (message sent, typing indicator, read receipt, presence change), the local instance immediately notifies local listeners and fires `pg_notify('openerp_chat_events', payload)` to Postgres.
- Sibling API instances receive the notification and fan it out to their locally connected subscribers.
- Each instance generates a unique `INSTANCE_ID` (`crypto.randomUUID()`) to avoid duplicate dispatch of events it emitted itself.
- If PostgreSQL disconnects, the listener automatically reconnects with an unref'd backoff timer without interrupting local in-process dispatch.

---

## 4. Database Migrations & Garage Verification

Migration `0011_storage_keys` adds:

- `avatar_storage_key VARCHAR(255)` to table `app_user`
- `storage_key VARCHAR(255)` to table `message_attachment`
- Modifies `bytes` column on `message_attachment` to nullable `BYTEA`.

To apply migrations in Coolify:

```bash
node server/scripts/apply-migrations.mjs
```

To verify or provision Garage S3 credentials and bucket on demand from the API container terminal:

```bash
node server/scripts/setup-garage.mjs
```
