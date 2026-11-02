-- =============================================================================
-- 0014_access_request_workflow
--
-- Self-service access request workflow.
-- Allows prospective users to submit access requests from the login screen,
-- track their request status by email, and enables system administrators
-- to review and approve/reject requests with direct account provisioning.
-- =============================================================================

CREATE TYPE "access_request_status_enum" AS ENUM ('Pending', 'Approved', 'Rejected');

CREATE TABLE "access_request" (
    "id" SERIAL NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(50),
    "department" VARCHAR(100),
    "job_title" VARCHAR(100),
    "reason" TEXT NOT NULL,
    "status" "access_request_status_enum" NOT NULL DEFAULT 'Pending',
    "admin_notes" TEXT,
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_request_email_idx" ON "access_request"("email");
CREATE INDEX "access_request_status_idx" ON "access_request"("status");

ALTER TABLE "access_request" ADD CONSTRAINT "access_request_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
