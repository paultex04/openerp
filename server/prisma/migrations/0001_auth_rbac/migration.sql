-- =============================================================================
-- 0001_auth_rbac
--
-- Additive only. This migration makes NO destructive change: it does not touch
-- any baseline table's data, and does not drop or recreate any existing enum,
-- foreign key, index or constraint.
--
-- Scope: the authentication and RBAC tables only.
--
-- Note on primary keys: the 18 baseline tables already use
-- `GENERATED ALWAYS AS IDENTITY`, and their identity sequences are already
-- advanced past the highest existing id (verified against pg_sequences). The
-- new tables below follow the same convention so the whole schema is uniform.
--
-- app_user is 1-to-1 with employee (UNIQUE FK, ON DELETE RESTRICT), so an
-- account can never exist without a linked employee record and no employee can
-- hold two accounts.
-- =============================================================================

CREATE TABLE "app_user" (
    "id"            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "employee_id"   INTEGER NOT NULL,
    "email"         VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "is_active"     BOOLEAN NOT NULL DEFAULT true,
    -- Bumped on password change to invalidate previously issued tokens.
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMP(3) WITH TIME ZONE,
    "created_at"    TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT "app_user_employee_id_key" UNIQUE ("employee_id"),
    CONSTRAINT "app_user_email_key"       UNIQUE ("email"),
    CONSTRAINT "app_user_employee_id_fkey" FOREIGN KEY ("employee_id")
        REFERENCES "employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "app_user_is_active_idx" ON "app_user" ("is_active");

CREATE TABLE "app_role" (
    "id"          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Stable machine key, e.g. 'administrator', 'commercial_qs'.
    "key"         VARCHAR(64)  NOT NULL,
    "name"        VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at"  TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT "app_role_key_key"  UNIQUE ("key"),
    CONSTRAINT "app_role_name_key" UNIQUE ("name")
);

CREATE TABLE "app_user_role" (
    "user_id"     INTEGER NOT NULL,
    "role_id"     INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
    -- Admin who granted the role. Intentionally not a hard FK so that deleting
    -- a user does not cascade-remove the audit trail of who granted what.
    "assigned_by" INTEGER,

    CONSTRAINT "app_user_role_pkey" PRIMARY KEY ("user_id", "role_id"),
    CONSTRAINT "app_user_role_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "app_user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_user_role_role_id_fkey" FOREIGN KEY ("role_id")
        REFERENCES "app_role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "app_user_role_role_id_idx" ON "app_user_role" ("role_id");

CREATE TABLE "permission" (
    "id"          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Dotted machine key, e.g. 'job.transition.submit'.
    "key"         VARCHAR(100) NOT NULL,
    "description" TEXT,
    -- Workflow grouping used by the Phase 5 permissions-matrix UI.
    "category"    VARCHAR(64) NOT NULL,

    CONSTRAINT "permission_key_key" UNIQUE ("key")
);

CREATE INDEX "permission_category_idx" ON "permission" ("category");

CREATE TABLE "role_permission" (
    "role_id"       INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "granted_at"    TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id", "permission_id"),
    CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id")
        REFERENCES "app_role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id")
        REFERENCES "permission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "role_permission_permission_id_idx" ON "role_permission" ("permission_id");

COMMENT ON TABLE "app_user" IS
  'Application account. Exactly one account per employee; no orphan accounts allowed.';
COMMENT ON COLUMN "app_user"."token_version" IS
  'Incremented on password change. Tokens carrying a stale version are rejected.';