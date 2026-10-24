# OpenERP — Backup & Disaster Recovery Guide

This runbook covers backup, verification, and disaster recovery procedures for the OpenERP PostgreSQL database and container infrastructure.

---

## 1. Automated Backups in Coolify

Coolify provides native scheduled backups for database containers and Compose services.

### Option A: Coolify Scheduled Database Backups (Recommended)

1. In the Coolify dashboard, navigate to your project and open the database resource.
2. Go to the **Backups** tab.
3. Configure the backup schedule:
   - **Enabled:** Toggle **ON**
   - **Frequency (Cron):** `0 2 * * *` _(Runs nightly at 02:00 AM)_
   - **Storage Destination:** Local storage or S3-compatible bucket (e.g. MinIO, Cloudflare R2, AWS S3).
   - **Retention:** Set retention period (e.g. 14 to 30 days).
4. Click **Save Changes** and click **Backup Now** to perform an immediate manual test run. Verify the status shows green (`Success`).

---

## 2. Automated Host-Level Backups (Cron on Coolify LXC)

If you are running the unified Compose stack (`docker-compose.coolify.yml`) where Postgres is managed directly within Compose:

### Create Nightly Backup Script

Inside your Coolify LXC (or host shell), create `/opt/scripts/backup-openerp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/openerp"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CONTAINER=$(docker ps --filter "name=db" --format "{{.Names}}" | grep -E "openerp.*db|db" | head -n 1)

mkdir -p "${BACKUP_DIR}"

echo "Starting OpenERP backup for container ${CONTAINER}..."
docker exec -t "${CONTAINER}" pg_dump -U openerp -d openerp -F c -b -v > "${BACKUP_DIR}/openerp_${TIMESTAMP}.dump"

# Retain backups for 14 days, delete older files
find "${BACKUP_DIR}" -type f -name "openerp_*.dump" -mtime +14 -delete

echo "Backup complete: ${BACKUP_DIR}/openerp_${TIMESTAMP}.dump"
```

Make it executable:

```bash
chmod +x /opt/scripts/backup-openerp.sh
```

### Schedule in Crontab

Add to root crontab (`crontab -e`):

```text
0 2 * * * /opt/scripts/backup-openerp.sh >> /var/log/openerp-backup.log 2>&1
```

---

## 3. Manual Backup and Restore Runbook

### Taking an Immediate Manual Dump

From your terminal or inside the Coolify LXC:

```bash
# Custom compressed format (recommended):
docker compose -f docker-compose.coolify.yml exec -T db pg_dump -U openerp -d openerp -F c > openerp_manual.dump

# Plain SQL text format:
docker compose -f docker-compose.coolify.yml exec -T db pg_dump -U openerp -d openerp > openerp_manual.sql
```

### Restoring a Backup to a Fresh Database

> [!CAUTION]
> Restoring overwrites existing database tables. Ensure all running API instances are stopped before restoring.

1. Stop the application services to prevent active connections:

   ```bash
   docker compose -f docker-compose.coolify.yml stop api web
   ```

2. Restore the compressed dump file:

   ```bash
   # Terminate any remaining connections and restore:
   docker compose -f docker-compose.coolify.yml exec -T db pg_restore \
     -U openerp \
     -d openerp \
     --clean \
     --if-exists \
     --no-owner \
     --no-privileges < openerp_manual.dump
   ```

3. Restart the API and Web containers:

   ```bash
   docker compose -f docker-compose.coolify.yml start api web
   ```

4. Verify application readiness:
   ```bash
   curl -fsS http://localhost:4000/health/ready
   ```

---

## 4. Proxmox VE Level Protection (LXC Snapshots)

In addition to database-level dumps, configure Proxmox VE backups for full container disaster recovery:

1. In Proxmox VE, go to **Datacenter** $\rightarrow$ **Backup** $\rightarrow$ **Add**.
2. Select your Coolify LXC container (e.g. CT 200).
3. Schedule: **Daily** (e.g. 03:30 AM).
4. Selection mode: **Snapshot** (zero downtime).
5. Storage target: Your external Proxmox backup storage or PBS (Proxmox Backup Server).
