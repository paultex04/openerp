-- =============================================================================
-- 0007_job_workflow
--
-- Phase 15 item 5: the job status workflow becomes data.
--
-- Why this is needed: the 13 job statuses and the legal moves between them were a
-- PostgreSQL enum plus a frozen table in `@openerp/shared`. Changing the
-- pipeline - relabelling a stage, moving one, letting a role into a transition
-- they did not have - meant a code change and a deploy, and the business runs
-- their own workflow. The admin screen now edits the catalogue in `job_statuses`
-- and `job_transitions`; the API and the UI both read it back from there.
--
-- What this migration does, in order:
--
--   1. Creates `job_statuses` and `job_transitions`.
--   2. Seeds them with the current 13 statuses and the current 28 transitions
--      (16 forward moves plus the 12 cancellation edges the old
--      "any non-terminal status may be cancelled" rule produced). Behaviour is
--      byte-identical the moment this commits.
--   3. Retires the enum: `job.status` becomes VARCHAR(40) with a foreign key to
--      `job_statuses`, and `job_status_enum` is dropped.
--
-- Design notes worth stating, because they are the whole point of the change:
--
--   The key, not the label, is the identity. `job.status` stores
--   `'04. WIP'`; the row's label ("Work in progress" once somebody edits it) is
--   presentation. Renaming a status is therefore free, and the history in
--   `audit_log` keeps naming the same key.
--
--   The statuses are also non-deletable while in use: `job.status` carries a
--   foreign key, so deleting a row that jobs stand on fails at the database, not
--   just in the admin route.
--
--   Cancellation is ordinary data. The old rule - any non-terminal status may
--   move to `00. Cancelled` - is seeded as one explicit edge per status, so an
--   administrator can take it away from a stage, or hand it to a capability of
--   their choosing, without touching code.
--
--   Flag assignments reproduce the old hard-coded helpers: planning stages may
--   edit planned quantities, execution stages may record actuals, and
--   cancellation is the only terminal status.
--
-- Additive except for the column retype, which preserves every value: the labels
-- are the values the enum already stored.
-- =============================================================================

CREATE TABLE "job_statuses" (
    "key"              VARCHAR(40)  NOT NULL,
    "label"            VARCHAR(80)  NOT NULL,
    "sort_order"       INTEGER      NOT NULL,

    "is_terminal"      BOOLEAN      NOT NULL DEFAULT false,
    "editable_planned" BOOLEAN      NOT NULL DEFAULT false,
    "editable_actuals" BOOLEAN      NOT NULL DEFAULT false,

    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "job_statuses_pkey" PRIMARY KEY ("key")
);

-- Total order: two statuses may never share a position, so "backward" is
-- always well defined.
CREATE UNIQUE INDEX "job_statuses_sort_order_key" ON "job_statuses"("sort_order");

CREATE TABLE "job_transitions" (
    "id"         SERIAL       NOT NULL,
    "from_key"   VARCHAR(40)  NOT NULL,
    "to_key"     VARCHAR(40)  NOT NULL,
    "permission" VARCHAR(80)  NOT NULL,
    "reason"     TEXT         NOT NULL,

    CONSTRAINT "job_transitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_transitions_from_key_to_key_key"
    ON "job_transitions"("from_key", "to_key");
CREATE INDEX "job_transitions_to_key_idx" ON "job_transitions"("to_key");

ALTER TABLE "job_transitions"
    ADD CONSTRAINT "job_transitions_from_key_fkey"
    FOREIGN KEY ("from_key") REFERENCES "job_statuses"("key")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_transitions"
    ADD CONSTRAINT "job_transitions_to_key_fkey"
    FOREIGN KEY ("to_key") REFERENCES "job_statuses"("key")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The seeded catalogue: the 13 stages, unchanged.
-- ---------------------------------------------------------------------------

INSERT INTO "job_statuses"
    ("key", "label", "sort_order", "is_terminal", "editable_planned", "editable_actuals")
VALUES
    ('00. Cancelled',             '00. Cancelled',             0,  true,  false, false),
    ('01. Scoping',               '01. Scoping',               1,  false, true,  false),
    ('01A. Scoped',               '01A. Scoped',               2,  false, true,  false),
    ('02. Awaiting PO',           '02. Awaiting PO',           3,  false, true,  false),
    ('03. WNYS',                  '03. WNYS',                  4,  false, false, false),
    ('04. WIP',                   '04. WIP',                   5,  false, false, true),
    ('05. Work Complete',         '05. Work Complete',         6,  false, false, true),
    ('06. Actuals in Progress',   '06. Actuals in Progress',   7,  false, false, true),
    ('07. Pack Ready',            '07. Pack Ready',            8,  false, false, false),
    ('08. Out for signature',     '08. Out for signature',     9,  false, false, false),
    ('09. Awaiting change order', '09. Awaiting change order', 10, false, false, false),
    ('10. Invoiced',              '10. Invoiced',              11, false, false, false),
    ('11. Partially Invoiced',    '11. Partially Invoiced',    12, false, false, false);

INSERT INTO "job_transitions" ("from_key", "to_key", "permission", "reason")
VALUES
    -- Scoping (Project Manager)
    ('01. Scoping', '01A. Scoped', 'job.transition.scope', 'Scope signed off.'),
    ('01A. Scoped', '01. Scoping', 'job.transition.scope',
     'Reopened for scoping changes before release.'),
    ('01A. Scoped', '02. Awaiting PO', 'job.transition.scope', 'Released for procurement.'),

    -- Execution (Site Supervisor)
    ('02. Awaiting PO', '03. WNYS', 'job.transition.execute',
     'Purchase order received; work not yet started.'),
    ('03. WNYS', '04. WIP', 'job.transition.execute', 'Work started on site.'),
    ('04. WIP', '05. Work Complete', 'job.transition.execute', 'Physical work finished.'),
    ('05. Work Complete', '06. Actuals in Progress', 'job.transition.execute',
     'Opening the actuals capture.'),
    ('09. Awaiting change order', '04. WIP', 'job.transition.execute',
     'Executing an approved change order.'),

    -- Pack hand-off
    ('06. Actuals in Progress', '07. Pack Ready', 'job.transition.pack',
     'Actuals captured; submitted for pack preparation.'),

    -- Documentation (Billing Clerk)
    ('07. Pack Ready', '08. Out for signature', 'job.transition.billing',
     'Documentation issued for signature.'),
    ('08. Out for signature', '09. Awaiting change order', 'job.transition.billing',
     'Client raised a change order against the signed scope.'),

    -- Invoicing
    ('07. Pack Ready', '10. Invoiced', 'job.transition.invoice', 'Invoiced in full.'),
    ('07. Pack Ready', '11. Partially Invoiced', 'job.transition.invoice',
     'Progress invoiced against actuals.'),
    ('08. Out for signature', '10. Invoiced', 'job.transition.invoice', 'Invoiced in full.'),
    ('08. Out for signature', '11. Partially Invoiced', 'job.transition.invoice',
     'Progress invoiced against actuals.'),
    ('10. Invoiced', '11. Partially Invoiced', 'job.transition.invoice',
     'Further progress billed against remaining actuals.'),

    -- Cancellation: one edge per non-terminal status, replacing the old rule.
    ('01. Scoping', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('01A. Scoped', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('02. Awaiting PO', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('03. WNYS', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('04. WIP', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('05. Work Complete', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('06. Actuals in Progress', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('07. Pack Ready', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('08. Out for signature', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('09. Awaiting change order', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('10. Invoiced', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.'),
    ('11. Partially Invoiced', '00. Cancelled', 'job.transition.cancel', 'Job cancelled.');

-- ---------------------------------------------------------------------------
-- Retirement of the enum.
-- ---------------------------------------------------------------------------

-- The enum default has to go before the type can change.
ALTER TABLE "job" ALTER COLUMN "status" DROP DEFAULT;

-- Every stored label is a valid catalogue key, so the USING cast cannot fail.
ALTER TABLE "job" ALTER COLUMN "status" TYPE VARCHAR(40) USING "status"::text;

ALTER TABLE "job" ALTER COLUMN "status" SET DEFAULT '01. Scoping';

-- Restrict, not Cascade: a status still referenced by a job must not vanish.
ALTER TABLE "job"
    ADD CONSTRAINT "job_status_fkey"
    FOREIGN KEY ("status") REFERENCES "job_statuses"("key")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TYPE "job_status_enum";
