# OpenERP — Backup & Disaster Recovery Guide

This runbook covers automated in-app backups, verification, and disaster recovery procedures for the OpenERP PostgreSQL database and container infrastructure.

---

## 1. Native In-App Automated Backups (Built-In)

OpenERP includes an autonomous, zero-dependency background backup system powered by PostgreSQL (`pg-boss` background worker queue).

### Key Features
- **Automated Schedule:** Runs automatically every night at **02:00 UTC** (`0 2 * * *`).
- **Zero Downtime:** Uses non-blocking `pg_dump` with compressed binary format (`-F c`), falling back to a transactional pure-SQL export if binary utilities are absent.
- **Dual Redundancy:** Backups are stored in **Garage S3** (`backups/`) and synced to local container disk (`data/backups/`).
- **14-Day Retention:** Backups older than 14 days are automatically pruned from both S3 and local storage on each cycle.
- **Web UI Management:** Administrators can view backups, trigger manual on-demand snapshots, and download dumps directly from `/admin?tab=diagnostics`.

### Triggering an Immediate Manual Backup via Web UI
1. Log in with an account holding `admin.*` permissions.
2. Navigate to **Administration** $\rightarrow$ **Diagnostics** tab (`/admin?tab=diagnostics`).
3. Scroll to the **Automated Database Backups & Snapshots** section.
4. Click **"Backup Database Now"**.
5. Once complete, click **"Download"** next to the backup entry to save the archive locally.

---

## 2. In-Service Terminal Commands (Inside Container Shells)

When performing maintenance directly inside container shells (e.g., via the Coolify Terminal or LXC console):

### A. Manual Dump (Run Inside `db` Service Terminal)

Open the **db** container terminal and run:

```bash
# Compressed binary dump (Recommended)
pg_dump -U openerp -d openerp -F c -b -v -f /tmp/openerp_manual.dump

# Or pure SQL export
pg_dump -U openerp -d openerp -f /tmp/openerp_manual.sql
```

### B. Restoring a Dump (Run Inside `db` Service Terminal)

> [!CAUTION]
> Restoring overwrites existing database tables. Ensure the `api` service is paused or not serving traffic during restoration.

Open the **db** container terminal:

```bash
# 1. Terminate remaining idle connections
psql -U openerp -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'openerp' AND pid <> pg_backend_pid();"

# 2. Restore compressed dump file
pg_restore -U openerp -d openerp --clean --if-exists --no-owner --no-privileges /tmp/openerp_manual.dump

# 3. Verify table counts
psql -U openerp -d openerp -c "SELECT count(*) FROM app_user;"
```

### C. Manual Backup Trigger (Run Inside `api` Service Terminal)

If you have an interactive shell inside the **api** container, you can trigger a backup programmatically:

```bash
node -e "import('./dist/backup/service.js').then(m => m.createDatabaseBackup()).then(b => console.log('Backup created:', b))"
```

---

## 3. Coolify Platform & Host Backups

### Option A: Coolify Native Scheduled Database Backups
1. In the Coolify dashboard, navigate to your project and open the database resource.
2. Go to the **Backups** tab.
3. Configure:
   - **Enabled:** Toggle **ON**
   - **Frequency (Cron):** `0 2 * * *`
   - **Retention:** 14 to 30 days.
4. Click **Save Changes** and click **Backup Now** to verify.

### Option B: Proxmox VE Level Protection (LXC Snapshots)
In addition to database-level dumps, configure Proxmox VE backups for full container disaster recovery:
1. In Proxmox VE, go to **Datacenter** $\rightarrow$ **Backup** $\rightarrow$ **Add**.
2. Select your Coolify LXC container (e.g. CT 200).
3. Schedule: **Daily** (e.g. 03:30 AM).
4. Selection mode: **Snapshot** (zero downtime).
5. Storage target: Your external Proxmox backup storage or PBS (Proxmox Backup Server).
