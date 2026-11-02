#!/bin/sh
set -e

# =============================================================================
# OpenERP API Docker Entrypoint
# Automatically configures, migrates, and seeds the database on container start
# =============================================================================

# 1. Detect active database host on Docker network
DB_HOST="${DB_HOST}"
if [ -z "$DB_HOST" ]; then
  for candidate in db openerp-db openerp-db-1 openerp_db_1 postgres postgresql; do
    if getent hosts "$candidate" >/dev/null 2>&1; then
      DB_HOST="$candidate"
      break
    fi
  done
fi
[ -z "$DB_HOST" ] && DB_HOST="db"

# 2. Sanitize and rewrite DATABASE_URL
DB_USER="${POSTGRES_USER:-openerp}"
DB_PASS="${POSTGRES_PASSWORD:-openerp}"
DB_NAME="${POSTGRES_DB:-openerp}"

if [ -z "$DATABASE_URL" ]; then
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}?schema=public"
  echo "[entrypoint] Constructed DATABASE_URL using host '${DB_HOST}'"
else
  # Replace localhost or 127.0.0.1 with DB_HOST
  ORIG_URL="$DATABASE_URL"
  DATABASE_URL=$(echo "$DATABASE_URL" | sed -E "s/@(localhost|127\.0\.0\.1):/@${DB_HOST}:/g")
  DATABASE_URL=$(echo "$DATABASE_URL" | sed "s/placeholder:placeholder/${DB_USER}:${DB_PASS}/g")
  DATABASE_URL=$(echo "$DATABASE_URL" | sed "s/\/placeholder/\/${DB_NAME}/g")
  export DATABASE_URL
  if [ "$ORIG_URL" != "$DATABASE_URL" ]; then
    echo "[entrypoint] Rewrote local/placeholder DATABASE_URL to host '${DB_HOST}'"
  fi
fi

# 3. Wait for database readiness (up to 30 seconds)
echo "[entrypoint] Verifying database connectivity at ${DB_HOST}:5432..."
ATTEMPT=0
MAX_ATTEMPTS=15
READY=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if node -e '
    import("pg").then(async ({ default: pg }) => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
      try {
        await pool.query("SELECT 1");
        await pool.end();
        process.exit(0);
      } catch {
        await pool.end().catch(() => {});
        process.exit(1);
      }
    }).catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    READY=1
    echo "[entrypoint] Database connection verified!"
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  echo "[entrypoint] Waiting for database (attempt $ATTEMPT/$MAX_ATTEMPTS)..."
  sleep 2
done

if [ $READY -eq 1 ]; then
  # 4. Automatically run schema migrations
  echo "[entrypoint] Applying schema migrations..."
  node server/scripts/apply-migrations.mjs || echo "[entrypoint] Migrations completed or already up to date."

  # 5. Automatically seed database (roles, permissions, workflows, admin account)
  echo "[entrypoint] Running bootstrap seed..."
  node server/dist/seed.js || echo "[entrypoint] Seed completed or admin already exists."
else
  echo "[entrypoint] Warning: Could not verify database connection within timeout. Starting API anyway..."
fi

# 6. Hand over to the main application process
echo "[entrypoint] Starting OpenERP API..."
exec "$@"
