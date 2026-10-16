-- Phase 15 item 8: profile avatars on the account.
--
-- The image is processed before it gets here (square-cropped to 256x256 and
-- re-encoded as WebP, see server/src/routes/profile.ts), so it is tens of KB,
-- not megabytes - small enough to keep inline rather than in object storage.
--
-- The bytes belong to the *account*, not the employee record: an avatar
-- identifies a login, and an employee without an account has no login to
-- identify. `avatar_updated_at` doubles as the cache-buster the client appends
-- to the image URL, and `avatar_mime` is stored beside the bytes so the GET
-- handler never has to guess a content type.
ALTER TABLE "app_user"
  ADD COLUMN "avatar_bytes"      BYTEA,
  ADD COLUMN "avatar_mime"       VARCHAR(64),
  ADD COLUMN "avatar_updated_at" TIMESTAMPTZ(3);
