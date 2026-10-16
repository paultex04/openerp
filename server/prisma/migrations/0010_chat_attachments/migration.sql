-- =============================================================================
-- 0010_chat_attachments
--
-- Phase 17, step 3: an image on a message.
--
-- Why this is needed: chat should carry a photo the way it carries a sentence -
-- a site photo, a marked-up drawing, a screenshot of the thing everyone is
-- arguing about.
--
-- Design notes, because they are the point of the change:
--
--   The bytes live in this table, not on disk. The API container has no
--   persistent volume, and the profile avatar (Phase 15) already set the
--   precedent: a `bytea` column, `sharp`-processed on upload. Chat images are
--   capped at 5 MB and re-encoded to WebP, so a row is tens to a few hundred KB.
--
--   One attachment per message for v1, so `message_id` is unique. It is a table
--   rather than columns on `message` so "more than one" is a later change of
--   constraint, not a reshape of the row.
--
--   `width` and `height` are stored so the client can reserve the right aspect
--   ratio before the bytes arrive, which is what stops the thread from jumping as
--   images load.
--
-- New table only. Nothing existing is altered.
-- =============================================================================

CREATE TABLE "message_attachment" (
    "id"            SERIAL         NOT NULL,
    "message_id"    INTEGER        NOT NULL,
    "bytes"         BYTEA          NOT NULL,
    "mime"          VARCHAR(64)    NOT NULL,
    "original_name" VARCHAR(255),
    "width"         INTEGER        NOT NULL,
    "height"        INTEGER        NOT NULL,
    "size_bytes"    INTEGER        NOT NULL,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "message_attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_attachment_message_id_key"
    ON "message_attachment"("message_id");

ALTER TABLE "message_attachment"
    ADD CONSTRAINT "message_attachment_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "message"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
