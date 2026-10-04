-- =============================================================================
-- 0003_audit_log
--
-- Adds the system audit log required by Phase 5.
--
-- Why this is needed: the application records who changed commercial and
-- operational data, but nowhere recorded *that* it happened. Every write to a
-- contract amendment, rate card, service code, job or invoice is currently
-- anonymous. For a contracting business that means an invoice cannot be defended
-- when the client queries it, and a mispriced rate card cannot be traced.
--
-- Additive only: one new table plus its index. No existing table, column or row is
-- altered, matching the additive-only rule recorded in ADR-001.
--
-- Design notes worth stating, because they are the whole point of the table:
--
--   actor_user_id is nullable and ON DELETE SET NULL. Deactivating or deleting a
--   user must not erase who performed an action. That is why actor_email and
--   actor_employee_id are denormalised onto the row: the log has to keep naming
--   the actor after the account itself is gone.
--
--   before / after hold the row as JSON. For an UPDATE only the fields that
--   actually changed are recorded in `after` and listed in `changed_fields`, so a
--   reviewer sees the edit rather than the entire row. Recording whole rows would
--   bloat the log and bury the one column that mattered.
--
--   record_id is text, not integer. A single bulk operation (deleteMany,
--   updateMany) can touch many ids, so it holds a comma-separated list; and the
--   auth tables use integer ids while future tables may not.
--
--   No UPDATE or DELETE grant is needed by the application: the log is append-only
--   and read-only through the API. Tamper-evidence beyond that is out of scope.
-- =============================================================================

CREATE TABLE audit_log (
    id               BIGSERIAL PRIMARY KEY,
    occurred_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- Actor, denormalised so the log still names them after account deletion.
    actor_user_id     INTEGER      REFERENCES app_user (id) ON DELETE SET NULL,
    actor_email       TEXT,
    actor_employee_id INTEGER,

    -- What happened.
    action            TEXT         NOT NULL,
    model             TEXT         NOT NULL,
    record_id         TEXT,
    summary           TEXT,

    -- The change itself.
    before            JSONB,
    after             JSONB,
    changed_fields    TEXT[],

    -- Where it happened, for tracing a specific request.
    request_id        TEXT,
    route             TEXT,
    method            TEXT,

    CONSTRAINT audit_log_action_check CHECK (action IN ('CREATE', 'UPDATE', 'DELETE'))
);

-- The register is read newest-first and filtered by model, actor and date range,
-- so each of those columns is indexed. occurred_at leads because almost every
-- query is a time window.
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_model_idx       ON audit_log (model);
CREATE INDEX audit_log_actor_idx       ON audit_log (actor_user_id);
CREATE INDEX audit_log_record_idx      ON audit_log (model, record_id);

COMMENT ON TABLE audit_log IS
    'Append-only record of every write to application data. actor_* are denormalised '
    'so an entry continues to name its actor after the account is deleted.';
COMMENT ON COLUMN audit_log.before IS
    'Row state before the change (DELETE only, and UPDATE when the row is later '
    'hard-deleted).';
COMMENT ON COLUMN audit_log.after IS
    'Row state after the change. For UPDATE this holds only the changed fields.';
COMMENT ON COLUMN audit_log.changed_fields IS
    'Names of the fields altered by an UPDATE.';
