CREATE TABLE note_revisions (
    id UUID PRIMARY KEY,
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    source_note_version BIGINT NOT NULL,
    wrapped_note_key BYTEA NOT NULL,
    snapshot_ciphertext BYTEA NOT NULL,
    label_ciphertext BYTEA NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_note_revisions_note_source_version UNIQUE (note_id, source_note_version)
);

CREATE INDEX idx_note_revisions_note_created_id
    ON note_revisions (note_id, created_at DESC, id DESC);

CREATE INDEX idx_note_revisions_created_at
    ON note_revisions (created_at);

ALTER TABLE attachments
    ADD COLUMN deleted_at TIMESTAMPTZ NULL;

CREATE INDEX idx_attachments_deleted_at
    ON attachments (deleted_at)
    WHERE deleted_at IS NOT NULL;
