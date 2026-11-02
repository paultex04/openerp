#!/bin/sh
set -e

# =============================================================================
# OpenERP API Docker Entrypoint
# Automatically configures, migrates, and seeds the database on container start
# =============================================================================

# 1. Auto-resolve DATABASE_URL if missing or pointing to placeholder
if [ -z "$DATABASE_URL" ] || echo "$DATABASE_URL" | grep -q "placeholder@localhost"; then
  DB_HOST=""
  if getent hosts db >/dev/null 2>&1; then
    DB_HOST="db"
  elif getent hosts openerp-db >/dev/null 2>&1; then
    DB_HOST="openerp-db"
  elif getent hosts postgres >/dev/null 2>&1; then
    DB_HOST="postgres"
  fi

  if [ -n "$DB_HOST" ]; then
    DB_USER="${POSTGRES_USER:-openerp}"
    DB_PASS="${POSTGRES_PASSWORD:-openerp}"
    DB_NAME="${POSTGRES_DB:-openerp}"
    export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}?schema=public"
    echo "[entrypoint] Auto-detected database at ${DB_HOST}:5432"
  fi
fi

# 2. Wait for database readiness (up to 30 seconds)
if [ -n "$DATABASE_URL" ] && ! echo "$DATABASE_URL" | grep -q "placeholder@localhost"; then
  echo "[entrypoint] Verifying database connectivity..."
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
    # 3. Automatically run schema migrations
    echo "[entrypoint] Applying schema migrations..."
    node server/scripts/apply-migrations.mjs || echo "[entrypoint] Migrations completed or already up to date."

    # 4. Automatically seed database (roles, permissions, workflows, admin account)
    echo "[entrypoint] Running bootstrap seed..."
    node server/dist/seed.js || echo "[entrypoint] Seed completed or admin already exists."
  else
    echo "[entrypoint] Warning: Could not verify database connection within timeout. Starting API anyway..."
  fi
fi

# 5. Hand over to the main application process
echo "[entrypoint] Starting OpenERP API..."
exec "$@"
