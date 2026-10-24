-- =============================================================================
-- 0012_soft_delete_commercial
--
-- Adds soft delete protection (deleted_at) to core commercial models:
-- - Client
-- - Contract
-- - Invoice
--
-- Prevents accidental cascade-deletion of historical commercial records and
-- enables zero-downtime record restoration.
-- =============================================================================

-- AlterTable client
ALTER TABLE "client"
    ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE INDEX "client_deleted_at_idx" ON "client"("deleted_at");

-- AlterTable contract
ALTER TABLE "contract"
    ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE INDEX "contract_deleted_at_idx" ON "contract"("deleted_at");

-- AlterTable invoice
ALTER TABLE "invoice"
    ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE INDEX "invoice_deleted_at_idx" ON "invoice"("deleted_at");
