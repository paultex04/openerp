-- =============================================================================
-- 0011_storage_keys
--
-- Phase 18 / Phase 3: S3-compatible object storage (Garage S3)
--
-- Adds optional storage keys for user avatars and chat attachments, allowing
-- binary files to be stored in Garage S3 while preserving existing bytea data.
-- =============================================================================

ALTER TABLE "app_user"
    ADD COLUMN "avatar_storage_key" VARCHAR(255);

ALTER TABLE "message_attachment"
    ADD COLUMN "storage_key" VARCHAR(255),
    ALTER COLUMN "bytes" DROP NOT NULL;
