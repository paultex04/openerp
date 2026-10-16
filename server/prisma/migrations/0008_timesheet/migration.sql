-- =============================================================================
-- 0008_timesheet
--
-- Phase 16: the cost side of a job.
--
-- Why this is needed: revenue per job has always been derivable (quantities x
-- the charge-out rate snapshotted at scoping), but nothing recorded what a job
-- cost to deliver, because nothing recorded labour hours. These two tables
-- supply that half of the equation. The costing engine in @openerp/shared turns
-- them into margin.
--
-- Design notes, because they are the point of the change:
--
--   This module is separate by construction. Hours are NOT quantities: nothing
--   here writes `job_service_code`, `actual_subtotal` or an invoice. Deleting
--   these tables leaves operations and billing completely intact.
--
--   A week is the unit of approval. `timesheet` is unique on
--   (employee_id, period_start), so there is one row per person per week, and
--   approving it freezes every child line's cost at once.
--
--   The rate is snapshotted, never re-read. `rate_snapshot` holds the whole
--   labour rate component vector captured at approval, and `cost_rate` /
--   `cost_amount` are frozen alongside it. Editing a rate card tomorrow cannot
--   rewrite an approved week - the same "authoritative once written" rule as
--   `job_service_code.applied_rate` (ADR-001, ADR-012).
--
--   `cost_rate` / `cost_amount` / `rate_snapshot` are nullable because they are
--   populated at approval; a draft line is priced live by the shared engine.
--
-- New table only. Nothing existing is altered.
-- =============================================================================

CREATE TYPE "timesheet_status_enum" AS ENUM ('Draft', 'Submitted', 'Approved', 'Rejected');

CREATE TABLE "timesheet" (
    "id"              SERIAL                 NOT NULL,
    "employee_id"     INTEGER                NOT NULL,
    -- Monday. `period_end` is the following Sunday, derived by the server, so a
    -- client can never write a header whose period contradicts its own bounds.
    "period_start"    DATE                   NOT NULL,
    "period_end"      DATE                   NOT NULL,
    "status"          "timesheet_status_enum" NOT NULL DEFAULT 'Draft',
    "notes"           TEXT,

    "submitted_at"    TIMESTAMPTZ(3),
    "submitted_by_id" INTEGER,
    "decided_at"      TIMESTAMPTZ(3),
    "decided_by_id"   INTEGER,
    "decision_note"   TEXT,

    "created_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT now(),

    CONSTRAINT "timesheet_pkey" PRIMARY KEY ("id")
);

-- One week per person. This is what makes "freeze the week" a single write.
CREATE UNIQUE INDEX "timesheet_employee_id_period_start_key"
    ON "timesheet"("employee_id", "period_start");
CREATE INDEX "timesheet_status_idx" ON "timesheet"("status");
CREATE INDEX "timesheet_employee_id_idx" ON "timesheet"("employee_id");

ALTER TABLE "timesheet"
    ADD CONSTRAINT "timesheet_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
-- The actor is denormalised the same way `audit_log` does it: the row keeps
-- naming who submitted and who decided, but the accounts may be deleted.
ALTER TABLE "timesheet"
    ADD CONSTRAINT "timesheet_submitted_by_id_fkey"
    FOREIGN KEY ("submitted_by_id") REFERENCES "app_user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "timesheet"
    ADD CONSTRAINT "timesheet_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "app_user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "timesheet_entry" (
    "id"                  SERIAL       NOT NULL,
    "timesheet_id"        INTEGER      NOT NULL,
    "job_id"              INTEGER      NOT NULL,
    "job_service_code_id" INTEGER,
    "work_date"           DATE         NOT NULL,
    "labour_type"         VARCHAR(100) NOT NULL,
    "shift_type"          "shift_type_enum" NOT NULL DEFAULT 'NT',
    "hours"               DECIMAL(6, 2) NOT NULL,
    "is_billable"         BOOLEAN      NOT NULL DEFAULT true,
    "notes"               TEXT,

    -- A manual cost-rate override survives line edits and is applied when
    -- approval freezes the line.
    "cost_rate_override"  DECIMAL(12, 4),
    "override_reason"     TEXT,

    -- Frozen at approval; null while the line is editable.
    "rate_snapshot"       JSONB,
    "cost_rate"           DECIMAL(12, 4),
    "cost_amount"         DECIMAL(12, 2),

    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "timesheet_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "timesheet_entry_timesheet_id_idx" ON "timesheet_entry"("timesheet_id");
-- The costing engine reads all lines for a job; lead with job_id.
CREATE INDEX "timesheet_entry_job_id_work_date_idx"
    ON "timesheet_entry"("job_id", "work_date");

ALTER TABLE "timesheet_entry"
    ADD CONSTRAINT "timesheet_entry_timesheet_id_fkey"
    FOREIGN KEY ("timesheet_id") REFERENCES "timesheet"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, not Cascade: a job with hours against it must not vanish silently.
ALTER TABLE "timesheet_entry"
    ADD CONSTRAINT "timesheet_entry_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "job"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_entry"
    ADD CONSTRAINT "timesheet_entry_job_service_code_id_fkey"
    FOREIGN KEY ("job_service_code_id") REFERENCES "job_service_code"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
