-- =============================================================================
-- 0009_chat
--
-- Phase 17, step 1: internal person-to-person chat.
--
-- Why this is needed: there is no way for two people in the business to talk
-- inside the app. Everything operationally interesting already has a row (a job,
-- a timesheet, an invoice) but no thread. These three tables add the thread.
--
-- Design notes, because they are the point of the change:
--
--   A conversation is a container; membership is the boundary. There is no
--   "read everyone's messages" permission on purpose - read access is a fact
--   about the row (are you a member), not a capability a role grants. The
--   permission keys only decide whether an account may use chat at all.
--
--   `dm_key` is a stable dedupe key for a direct conversation: the two account
--   ids sorted and joined, "3:7". Opening a DM that already exists returns it
--   rather than creating a second one, and the unique index makes that a
--   database guarantee rather than a hopeful check.
--
--   `kind` is an enum with room to grow (JOB, PROJECT, GROUP) so the job-scoped
--   channels of a later step are additive, not a rewrite. Only DM is created
--   today.
--
--   `last_read_at` drives the unread badge and is the only per-member state
--   step 1 needs; per-message receipts can layer on later without a rewrite.
--
--   `client_token` is an idempotency key: a send retried after a dropped
--   connection returns the original message instead of posting a duplicate. It
--   is nullable (most sends have no token) and unique per conversation, which
--   Postgres enforces while allowing the many NULLs.
--
--   Messages are soft-deletable (`deleted_at`) and editable (`edited_at`) - the
--   columns exist now so those steps do not need an ALTER. Step 1 only writes
--   and reads them.
--
-- New tables only. Nothing existing is altered.
-- =============================================================================

CREATE TYPE "conversation_kind_enum" AS ENUM ('DM', 'JOB', 'PROJECT', 'GROUP');

CREATE TABLE "conversation" (
    "id"              SERIAL                   NOT NULL,
    "kind"            "conversation_kind_enum" NOT NULL DEFAULT 'DM',
    -- Stable dedupe key for a DM: the two account ids sorted, "min:max".
    -- NULL for kinds that are not deduped this way.
    "dm_key"          VARCHAR(64),
    "title"           VARCHAR(150),
    -- Sorts the conversation list; denormalised from the newest message so the
    -- list is one query rather than an aggregate per row.
    "last_message_at" TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)           NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(3)           NOT NULL DEFAULT now(),

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_dm_key_key" ON "conversation"("dm_key");
CREATE INDEX "conversation_last_message_at_idx" ON "conversation"("last_message_at");

CREATE TABLE "conversation_member" (
    "id"              SERIAL       NOT NULL,
    "conversation_id" INTEGER      NOT NULL,
    "user_id"         INTEGER      NOT NULL,
    -- Everything up to here is read. Null means "nothing read yet".
    "last_read_at"    TIMESTAMPTZ(3),
    "joined_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "conversation_member_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_member_conversation_id_user_id_key"
    ON "conversation_member"("conversation_id", "user_id");
-- "Which conversations am I in?" is the entry point; lead with user_id.
CREATE INDEX "conversation_member_user_id_idx" ON "conversation_member"("user_id");

ALTER TABLE "conversation_member"
    ADD CONSTRAINT "conversation_member_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_member"
    ADD CONSTRAINT "conversation_member_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "message" (
    "id"              SERIAL       NOT NULL,
    "conversation_id" INTEGER      NOT NULL,
    "sender_id"       INTEGER      NOT NULL,
    "body"            TEXT         NOT NULL,
    -- Idempotency key; unique within the conversation, many NULLs allowed.
    "client_token"    VARCHAR(64),
    "edited_at"       TIMESTAMPTZ(3),
    "deleted_at"      TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_conversation_id_client_token_key"
    ON "message"("conversation_id", "client_token");
-- History is read newest-first within a conversation; keyset pagination walks
-- (created_at, id) so the index carries both.
CREATE INDEX "message_conversation_id_created_at_id_idx"
    ON "message"("conversation_id", "created_at", "id");

ALTER TABLE "message"
    ADD CONSTRAINT "message_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message"
    ADD CONSTRAINT "message_sender_id_fkey"
    FOREIGN KEY ("sender_id") REFERENCES "app_user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
