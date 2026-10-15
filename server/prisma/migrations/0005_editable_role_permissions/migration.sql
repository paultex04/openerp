-- Track whether role grants have been explicitly customized so seed reruns can
-- safely add newly introduced catalogue grants without undoing administrator edits.
ALTER TABLE "app_role"
  ADD COLUMN "permissions_customized" BOOLEAN NOT NULL DEFAULT false;

-- Preserve any existing non-admin grant set across the first seed after rollout;
-- it may already contain administrator edits made directly in the database.
UPDATE "app_role" AS role
SET "permissions_customized" = true
WHERE role."key" <> 'administrator'
  AND EXISTS (
    SELECT 1
    FROM "role_permission" AS grant_row
    WHERE grant_row."role_id" = role."id"
  );
