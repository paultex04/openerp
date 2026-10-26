-- =============================================================================
-- The whole schema, as SQL — for creating a database that does not exist yet.
-- =============================================================================
--
-- GENERATED. Do not edit by hand, and do not reason about this file as a source
-- of truth: `server/prisma/schema.prisma` is the schema and this is what the
-- Prisma CLI emits for it. Regenerate and verify with:
--
--     npm run db:schema:write     # after changing schema.prisma
--     npm run db:schema:check     # proves it has not drifted (runs in `verify`)
--
-- Everything from the first `CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "job_priority_enum" AS ENUM ('P1 - Emergency / Breakdown', 'P2 - Urgent', 'P3 - Routine / Normal', 'P4 - Planned Shutdown', 'P5 - Low');

-- CreateEnum
CREATE TYPE "service_code_category_enum" AS ENUM ('Activity', 'R1 Material');

-- CreateEnum
CREATE TYPE "shift_type_enum" AS ENUM ('NT', 'OT1.5', 'DT2.0', 'NS', 'ST');

-- CreateEnum
CREATE TYPE "contract_amendment_status_enum" AS ENUM ('Draft', 'Pending Approval', 'Active', 'Superseded', 'Terminated');

-- CreateEnum
CREATE TYPE "amendment_type_enum" AS ENUM ('Base Agreement', 'Annual Escalation', 'Scope Change', 'CPI / Index Adjustment', 'Ad-Hoc Revision');

-- CreateEnum
CREATE TYPE "cost_parameter_category_enum" AS ENUM ('PPE', 'Transport', 'Equipment', 'Overheads', 'Margin', 'Material Markup');

-- CreateEnum
CREATE TYPE "invoice_status_enum" AS ENUM ('Draft', 'Submitted', 'Approved', 'Partially Paid', 'Paid', 'Disputed', 'Cancelled');

-- CreateEnum
CREATE TYPE "timesheet_status_enum" AS ENUM ('Draft', 'Submitted', 'Approved', 'Rejected');

-- CreateEnum
CREATE TYPE "conversation_kind_enum" AS ENUM ('DM', 'JOB', 'PROJECT', 'GROUP');

-- CreateEnum
CREATE TYPE "task_status_enum" AS ENUM ('Todo', 'In Progress', 'Blocked', 'Done', 'Cancelled');

-- CreateEnum
CREATE TYPE "task_priority_enum" AS ENUM ('Low', 'Medium', 'High', 'Urgent');

-- CreateTable
CREATE TABLE "broker" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "broker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_contract_type" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employee_contract_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "surname" VARCHAR(100) NOT NULL,
    "mobile" VARCHAR(50),
    "email" VARCHAR(255),
    "id_number" VARCHAR(50),
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "broker_id" INTEGER,
    "contract_type_id" INTEGER NOT NULL,
    "manager_id" INTEGER,
    "rate" DECIMAL(10,2),

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "address" TEXT,
    "is_vat_registered" BOOLEAN NOT NULL DEFAULT true,
    "vat_number" VARCHAR(50),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "mobile" VARCHAR(50),
    "email" VARCHAR(255),
    "role" VARCHAR(100),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "number" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "type" VARCHAR(100),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_amendment" (
    "id" SERIAL NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "amendment_number" VARCHAR(50) NOT NULL,
    "amendment_type" "amendment_type_enum" NOT NULL DEFAULT 'Annual Escalation',
    "effective_date" DATE NOT NULL,
    "expiry_date" DATE,
    "status" "contract_amendment_status_enum" NOT NULL DEFAULT 'Active',
    "signed_date" DATE,
    "notes" TEXT,
    "vat_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_amendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_cost_parameters" (
    "id" SERIAL NOT NULL,
    "amendment_id" INTEGER NOT NULL,
    "category" "cost_parameter_category_enum" NOT NULL,
    "parameter_name" VARCHAR(100) NOT NULL,
    "numeric_value" DECIMAL(12,6) NOT NULL,
    "uom" VARCHAR(50) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_cost_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_master_rates" (
    "id" SERIAL NOT NULL,
    "amendment_id" INTEGER NOT NULL,
    "service_master_code" VARCHAR(20) NOT NULL,
    "labour_type" VARCHAR(100) NOT NULL,
    "shift_type" "shift_type_enum" NOT NULL DEFAULT 'NT',
    "uom" VARCHAR(30) NOT NULL DEFAULT 'per Hour',
    "bargaining_council_desc" VARCHAR(150),
    "council_rate" DECIMAL(10,2),
    "custom_rate" DECIMAL(10,2),
    "wage_premium_pct" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "man_in_pocket" DECIMAL(10,2) NOT NULL,
    "leave_pay" DECIMAL(10,2) NOT NULL,
    "total_statutory_cost" DECIMAL(10,2) NOT NULL,
    "ppe_cost" DECIMAL(10,2) NOT NULL,
    "transport_cost" DECIMAL(10,2) NOT NULL,
    "equipment_cost" DECIMAL(10,2) NOT NULL,
    "overhead_cost" DECIMAL(10,2) NOT NULL,
    "sga_cost" DECIMAL(10,2) NOT NULL,
    "profit_cost" DECIMAL(10,2) NOT NULL,
    "full_loaded_rate" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_master_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_code" (
    "id" SERIAL NOT NULL,
    "amendment_id" INTEGER NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" TEXT NOT NULL,
    "category" "service_code_category_enum" NOT NULL DEFAULT 'Activity',
    "uom" VARCHAR(20) NOT NULL,
    "material_markup_pct" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "calculated_unit_rate" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_code_labour_item" (
    "id" SERIAL NOT NULL,
    "service_code_id" INTEGER NOT NULL,
    "service_master_rate_id" INTEGER NOT NULL,
    "crew_quantity" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "hours_per_unit" DECIMAL(10,4) NOT NULL,
    "line_subtotal" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "service_code_labour_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_code_material_item" (
    "id" SERIAL NOT NULL,
    "service_code_id" INTEGER NOT NULL,
    "item_code" VARCHAR(50),
    "description" TEXT NOT NULL,
    "supplier_name" VARCHAR(150),
    "unit_cost" DECIMAL(12,4) NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "uom" VARCHAR(20) NOT NULL DEFAULT 'EA',
    "subtotal_cost" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "service_code_material_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" SERIAL NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "amendment_id" INTEGER NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "year" SMALLINT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "description" TEXT,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_statuses" (
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "editable_planned" BOOLEAN NOT NULL DEFAULT false,
    "editable_actuals" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_statuses_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "job_transitions" (
    "id" SERIAL NOT NULL,
    "from_key" VARCHAR(40) NOT NULL,
    "to_key" VARCHAR(40) NOT NULL,
    "permission" VARCHAR(80) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "job_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "amendment_id" INTEGER,
    "supervisor_id" INTEGER,
    "client_contact_id" INTEGER,
    "status" VARCHAR(40) NOT NULL DEFAULT '01. Scoping',
    "priority" "job_priority_enum" NOT NULL DEFAULT 'P3 - Routine / Normal',
    "work_order" VARCHAR(100),
    "work_order_received_date" DATE,
    "purchase_order" VARCHAR(100),
    "purchase_order_received_date" DATE,
    "planned_start_date" DATE,
    "planned_end_date" DATE,
    "actual_start_date" DATE,
    "actual_end_date" DATE,
    "area" VARCHAR(100),
    "description" TEXT,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_service_code" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "service_code_id" INTEGER NOT NULL,
    "planned_quantity" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "actual_quantity" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "applied_rate" DECIMAL(12,4) NOT NULL,
    "planned_subtotal" DECIMAL(12,2) NOT NULL,
    "actual_subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "snapshot_source" JSONB,

    CONSTRAINT "job_service_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_assignment" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "role" VARCHAR(100),
    "assigned_date" DATE,

    CONSTRAINT "job_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "invoice_number" VARCHAR(50) NOT NULL,
    "issue_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "due_date" DATE NOT NULL,
    "status" "invoice_status_enum" NOT NULL DEFAULT 'Draft',
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_with_tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_item" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "service_code_id" INTEGER NOT NULL,
    "description" TEXT,
    "billed_quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,4) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "timesheet_status_enum" NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by_id" INTEGER,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" INTEGER,
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_entry" (
    "id" SERIAL NOT NULL,
    "timesheet_id" INTEGER NOT NULL,
    "job_id" INTEGER NOT NULL,
    "job_service_code_id" INTEGER,
    "work_date" DATE NOT NULL,
    "labour_type" VARCHAR(100) NOT NULL,
    "shift_type" "shift_type_enum" NOT NULL DEFAULT 'NT',
    "hours" DECIMAL(6,2) NOT NULL,
    "is_billable" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "cost_rate_override" DECIMAL(12,4),
    "override_reason" TEXT,
    "rate_snapshot" JSONB,
    "cost_rate" DECIMAL(12,4),
    "cost_amount" DECIMAL(12,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timesheet_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "avatar_bytes" BYTEA,
    "avatar_mime" VARCHAR(64),
    "avatar_storage_key" VARCHAR(255),
    "avatar_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_role" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "permissions_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" INTEGER,
    "actor_email" VARCHAR(255),
    "actor_employee_id" INTEGER,
    "action" VARCHAR(16) NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "record_id" TEXT,
    "summary" TEXT,
    "before" JSONB,
    "after" JSONB,
    "changed_fields" TEXT[],
    "request_id" VARCHAR(64),
    "route" VARCHAR(255),
    "method" VARCHAR(10),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user_role" (
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" INTEGER,

    CONSTRAINT "app_user_role_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(64) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" SERIAL NOT NULL,
    "kind" "conversation_kind_enum" NOT NULL DEFAULT 'DM',
    "dm_key" VARCHAR(64),
    "title" VARCHAR(150),
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_member" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "last_read_at" TIMESTAMPTZ(3),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "client_token" VARCHAR(64),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachment" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "bytes" BYTEA,
    "storage_key" VARCHAR(255),
    "mime" VARCHAR(64) NOT NULL,
    "original_name" VARCHAR(255),
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_project" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "color" VARCHAR(30) DEFAULT '#3b82f6',
    "icon" VARCHAR(50) DEFAULT 'Folder',
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "creator_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "task_status_enum" NOT NULL DEFAULT 'Todo',
    "priority" "task_priority_enum" NOT NULL DEFAULT 'Medium',
    "due_date" TIMESTAMPTZ(3),
    "due_has_time" BOOLEAN NOT NULL DEFAULT false,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "task_project_id" INTEGER,
    "erp_project_id" INTEGER,
    "job_id" INTEGER,
    "parent_id" INTEGER,
    "creator_id" INTEGER NOT NULL,
    "completed_by_id" INTEGER,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_assignee" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" INTEGER,

    CONSTRAINT "task_assignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklist_item" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_tag" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "color" VARCHAR(30) NOT NULL DEFAULT '#64748b',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_tag_assignment" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,

    CONSTRAINT "task_tag_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comment" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "author_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activity" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_contract_type_name_key" ON "employee_contract_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "employee_email_key" ON "employee"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employee_id_number_key" ON "employee"("id_number");

-- CreateIndex
CREATE INDEX "employee_broker_id_idx" ON "employee"("broker_id");

-- CreateIndex
CREATE INDEX "employee_contract_type_id_idx" ON "employee"("contract_type_id");

-- CreateIndex
CREATE INDEX "employee_manager_id_idx" ON "employee"("manager_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_email_key" ON "client"("email");

-- CreateIndex
CREATE INDEX "client_deleted_at_idx" ON "client"("deleted_at");

-- CreateIndex
CREATE INDEX "contact_client_id_idx" ON "contact"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_number_key" ON "contract"("number");

-- CreateIndex
CREATE INDEX "contract_client_id_idx" ON "contract"("client_id");

-- CreateIndex
CREATE INDEX "contract_deleted_at_idx" ON "contract"("deleted_at");

-- CreateIndex
CREATE INDEX "contract_amendment_contract_id_idx" ON "contract_amendment"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_amendment_contract_id_amendment_number_key" ON "contract_amendment"("contract_id", "amendment_number");

-- CreateIndex
CREATE INDEX "contract_cost_parameters_amendment_id_idx" ON "contract_cost_parameters"("amendment_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_cost_parameters_amendment_id_parameter_name_key" ON "contract_cost_parameters"("amendment_id", "parameter_name");

-- CreateIndex
CREATE INDEX "service_master_rates_amendment_id_idx" ON "service_master_rates"("amendment_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_master_rates_amendment_id_labour_type_shift_type_key" ON "service_master_rates"("amendment_id", "labour_type", "shift_type");

-- CreateIndex
CREATE UNIQUE INDEX "service_master_rates_amendment_id_service_master_code_shift_key" ON "service_master_rates"("amendment_id", "service_master_code", "shift_type");

-- CreateIndex
CREATE INDEX "service_code_amendment_id_idx" ON "service_code"("amendment_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_code_amendment_id_code_key" ON "service_code"("amendment_id", "code");

-- CreateIndex
CREATE INDEX "service_code_labour_item_service_code_id_idx" ON "service_code_labour_item"("service_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_code_labour_item_service_code_id_service_master_rat_key" ON "service_code_labour_item"("service_code_id", "service_master_rate_id");

-- CreateIndex
CREATE INDEX "service_code_material_item_service_code_id_idx" ON "service_code_material_item"("service_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_code_key" ON "project"("code");

-- CreateIndex
CREATE INDEX "project_contract_id_idx" ON "project"("contract_id");

-- CreateIndex
CREATE INDEX "project_amendment_id_idx" ON "project"("amendment_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_statuses_sort_order_key" ON "job_statuses"("sort_order");

-- CreateIndex
CREATE INDEX "job_transitions_to_key_idx" ON "job_transitions"("to_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_transitions_from_key_to_key_key" ON "job_transitions"("from_key", "to_key");

-- CreateIndex
CREATE INDEX "job_project_id_idx" ON "job"("project_id");

-- CreateIndex
CREATE INDEX "job_amendment_id_idx" ON "job"("amendment_id");

-- CreateIndex
CREATE INDEX "job_supervisor_id_idx" ON "job"("supervisor_id");

-- CreateIndex
CREATE INDEX "job_status_idx" ON "job"("status");

-- CreateIndex
CREATE INDEX "job_service_code_job_id_idx" ON "job_service_code"("job_id");

-- CreateIndex
CREATE INDEX "job_service_code_service_code_id_idx" ON "job_service_code"("service_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_service_code_job_id_service_code_id_key" ON "job_service_code"("job_id", "service_code_id");

-- CreateIndex
CREATE INDEX "job_assignment_job_id_idx" ON "job_assignment"("job_id");

-- CreateIndex
CREATE INDEX "job_assignment_employee_id_idx" ON "job_assignment"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_assignment_job_employee_key" ON "job_assignment"("job_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_invoice_number_key" ON "invoice"("invoice_number");

-- CreateIndex
CREATE INDEX "invoice_job_id_idx" ON "invoice"("job_id");

-- CreateIndex
CREATE INDEX "invoice_status_idx" ON "invoice"("status");

-- CreateIndex
CREATE INDEX "invoice_deleted_at_idx" ON "invoice"("deleted_at");

-- CreateIndex
CREATE INDEX "invoice_item_invoice_id_idx" ON "invoice_item"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_item_service_code_id_idx" ON "invoice_item"("service_code_id");

-- CreateIndex
CREATE INDEX "timesheet_status_idx" ON "timesheet"("status");

-- CreateIndex
CREATE INDEX "timesheet_employee_id_idx" ON "timesheet"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_employee_id_period_start_key" ON "timesheet"("employee_id", "period_start");

-- CreateIndex
CREATE INDEX "timesheet_entry_timesheet_id_idx" ON "timesheet_entry"("timesheet_id");

-- CreateIndex
CREATE INDEX "timesheet_entry_job_id_work_date_idx" ON "timesheet_entry"("job_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_employee_id_key" ON "app_user"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_is_active_idx" ON "app_user"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "app_role_key_key" ON "app_role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "app_role_name_key" ON "app_role"("name");

-- CreateIndex
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_model_idx" ON "audit_log"("model");

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_idx" ON "audit_log"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_log_model_record_id_idx" ON "audit_log"("model", "record_id");

-- CreateIndex
CREATE INDEX "app_user_role_role_id_idx" ON "app_user_role"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "permission_category_idx" ON "permission"("category");

-- CreateIndex
CREATE INDEX "role_permission_permission_id_idx" ON "role_permission"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_dm_key_key" ON "conversation"("dm_key");

-- CreateIndex
CREATE INDEX "conversation_last_message_at_idx" ON "conversation"("last_message_at");

-- CreateIndex
CREATE INDEX "conversation_member_user_id_idx" ON "conversation_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_member_conversation_id_user_id_key" ON "conversation_member"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_id_idx" ON "message"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_conversation_id_client_token_key" ON "message"("conversation_id", "client_token");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachment_message_id_key" ON "message_attachment"("message_id");

-- CreateIndex
CREATE INDEX "task_project_creator_id_idx" ON "task_project"("creator_id");

-- CreateIndex
CREATE INDEX "task_task_project_id_idx" ON "task"("task_project_id");

-- CreateIndex
CREATE INDEX "task_erp_project_id_idx" ON "task"("erp_project_id");

-- CreateIndex
CREATE INDEX "task_job_id_idx" ON "task"("job_id");

-- CreateIndex
CREATE INDEX "task_parent_id_idx" ON "task"("parent_id");

-- CreateIndex
CREATE INDEX "task_creator_id_idx" ON "task"("creator_id");

-- CreateIndex
CREATE INDEX "task_status_idx" ON "task"("status");

-- CreateIndex
CREATE INDEX "task_priority_idx" ON "task"("priority");

-- CreateIndex
CREATE INDEX "task_due_date_idx" ON "task"("due_date");

-- CreateIndex
CREATE INDEX "task_assignee_user_id_idx" ON "task_assignee"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_assignee_task_id_user_id_key" ON "task_assignee"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "task_checklist_item_task_id_idx" ON "task_checklist_item"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_tag_name_key" ON "task_tag"("name");

-- CreateIndex
CREATE INDEX "task_tag_assignment_tag_id_idx" ON "task_tag_assignment"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_tag_assignment_task_id_tag_id_key" ON "task_tag_assignment"("task_id", "tag_id");

-- CreateIndex
CREATE INDEX "task_comment_task_id_idx" ON "task_comment"("task_id");

-- CreateIndex
CREATE INDEX "task_activity_task_id_created_at_idx" ON "task_activity"("task_id", "created_at");

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_contract_type_id_fkey" FOREIGN KEY ("contract_type_id") REFERENCES "employee_contract_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendment" ADD CONSTRAINT "contract_amendment_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_cost_parameters" ADD CONSTRAINT "contract_cost_parameters_amendment_id_fkey" FOREIGN KEY ("amendment_id") REFERENCES "contract_amendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_master_rates" ADD CONSTRAINT "service_master_rates_amendment_id_fkey" FOREIGN KEY ("amendment_id") REFERENCES "contract_amendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_code" ADD CONSTRAINT "service_code_amendment_id_fkey" FOREIGN KEY ("amendment_id") REFERENCES "contract_amendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_code_labour_item" ADD CONSTRAINT "service_code_labour_item_service_code_id_fkey" FOREIGN KEY ("service_code_id") REFERENCES "service_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_code_labour_item" ADD CONSTRAINT "service_code_labour_item_service_master_rate_id_fkey" FOREIGN KEY ("service_master_rate_id") REFERENCES "service_master_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_code_material_item" ADD CONSTRAINT "service_code_material_item_service_code_id_fkey" FOREIGN KEY ("service_code_id") REFERENCES "service_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_amendment_id_fkey" FOREIGN KEY ("amendment_id") REFERENCES "contract_amendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_transitions" ADD CONSTRAINT "job_transitions_from_key_fkey" FOREIGN KEY ("from_key") REFERENCES "job_statuses"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_transitions" ADD CONSTRAINT "job_transitions_to_key_fkey" FOREIGN KEY ("to_key") REFERENCES "job_statuses"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_amendment_id_fkey" FOREIGN KEY ("amendment_id") REFERENCES "contract_amendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_client_contact_id_fkey" FOREIGN KEY ("client_contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_status_fkey" FOREIGN KEY ("status") REFERENCES "job_statuses"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_service_code" ADD CONSTRAINT "job_service_code_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_service_code" ADD CONSTRAINT "job_service_code_service_code_id_fkey" FOREIGN KEY ("service_code_id") REFERENCES "service_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_service_code_id_fkey" FOREIGN KEY ("service_code_id") REFERENCES "service_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet" ADD CONSTRAINT "timesheet_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet" ADD CONSTRAINT "timesheet_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet" ADD CONSTRAINT "timesheet_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_timesheet_id_fkey" FOREIGN KEY ("timesheet_id") REFERENCES "timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entry" ADD CONSTRAINT "timesheet_entry_job_service_code_id_fkey" FOREIGN KEY ("job_service_code_id") REFERENCES "job_service_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user_role" ADD CONSTRAINT "app_user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user_role" ADD CONSTRAINT "app_user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "app_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "app_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_member" ADD CONSTRAINT "conversation_member_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_member" ADD CONSTRAINT "conversation_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_project" ADD CONSTRAINT "task_project_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_task_project_id_fkey" FOREIGN KEY ("task_project_id") REFERENCES "task_project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_erp_project_id_fkey" FOREIGN KEY ("erp_project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_item" ADD CONSTRAINT "task_checklist_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tag_assignment" ADD CONSTRAINT "task_tag_assignment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tag_assignment" ADD CONSTRAINT "task_tag_assignment_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "task_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

