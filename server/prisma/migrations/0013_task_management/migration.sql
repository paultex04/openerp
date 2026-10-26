-- =============================================================================
-- 0013_task_management
--
-- Work-related task tracking module (similar to Todoist).
--
-- Features:
--   - Standalone Task Projects (lists/workspaces) and optional links to ERP Projects/Jobs
--   - Multi-user task assignment (task_assignee join table)
--   - Status pipeline (Todo, In Progress, Blocked, Done, Cancelled)
--   - Priority levels (Low, Medium, High, Urgent)
--   - Due date/time and privacy flag (is_private)
--   - Subtasks (hierarchical self-relation via parent_id)
--   - Inline checklists (task_checklist_item)
--   - Labels / Tags (task_tag, task_tag_assignment)
--   - Collaboration comments thread (task_comment)
--   - Activity history trail (task_activity)
-- =============================================================================

CREATE TYPE "task_status_enum" AS ENUM ('Todo', 'In Progress', 'Blocked', 'Done', 'Cancelled');
CREATE TYPE "task_priority_enum" AS ENUM ('Low', 'Medium', 'High', 'Urgent');

CREATE TABLE "task_project" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "color" VARCHAR(30) DEFAULT '#3b82f6',
    "icon" VARCHAR(50) DEFAULT 'Folder',
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "creator_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_project_pkey" PRIMARY KEY ("id")
);

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
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_assignee" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" INTEGER,

    CONSTRAINT "task_assignee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_checklist_item" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_tag" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "color" VARCHAR(30) NOT NULL DEFAULT '#64748b',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_tag_assignment" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,

    CONSTRAINT "task_tag_assignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_comment" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "author_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_activity" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activity_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "task_assignee_task_id_user_id_key" ON "task_assignee"("task_id", "user_id");
CREATE UNIQUE INDEX "task_tag_name_key" ON "task_tag"("name");
CREATE UNIQUE INDEX "task_tag_assignment_task_id_tag_id_key" ON "task_tag_assignment"("task_id", "tag_id");

-- Indexes
CREATE INDEX "task_project_creator_id_idx" ON "task_project"("creator_id");
CREATE INDEX "task_task_project_id_idx" ON "task"("task_project_id");
CREATE INDEX "task_erp_project_id_idx" ON "task"("erp_project_id");
CREATE INDEX "task_job_id_idx" ON "task"("job_id");
CREATE INDEX "task_parent_id_idx" ON "task"("parent_id");
CREATE INDEX "task_creator_id_idx" ON "task"("creator_id");
CREATE INDEX "task_status_idx" ON "task"("status");
CREATE INDEX "task_priority_idx" ON "task"("priority");
CREATE INDEX "task_due_date_idx" ON "task"("due_date");
CREATE INDEX "task_assignee_user_id_idx" ON "task_assignee"("user_id");
CREATE INDEX "task_checklist_item_task_id_idx" ON "task_checklist_item"("task_id");
CREATE INDEX "task_tag_assignment_tag_id_idx" ON "task_tag_assignment"("tag_id");
CREATE INDEX "task_comment_task_id_idx" ON "task_comment"("task_id");
CREATE INDEX "task_activity_task_id_created_at_idx" ON "task_activity"("task_id", "created_at");

-- Foreign Keys
ALTER TABLE "task_project" ADD CONSTRAINT "task_project_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task" ADD CONSTRAINT "task_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_task_project_id_fkey" FOREIGN KEY ("task_project_id") REFERENCES "task_project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_erp_project_id_fkey" FOREIGN KEY ("erp_project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "task_checklist_item" ADD CONSTRAINT "task_checklist_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_tag_assignment" ADD CONSTRAINT "task_tag_assignment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_tag_assignment" ADD CONSTRAINT "task_tag_assignment_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "task_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
