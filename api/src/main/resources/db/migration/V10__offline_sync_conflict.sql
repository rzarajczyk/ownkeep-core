ALTER TABLE notes
    ADD COLUMN client_updated_at TIMESTAMPTZ,
    ADD COLUMN client_mutation_id VARCHAR(36);

UPDATE notes
SET client_updated_at = updated_at
WHERE client_updated_at IS NULL;

ALTER TABLE notes
    ALTER COLUMN client_updated_at SET NOT NULL;

ALTER TABLE note_revisions
    ADD COLUMN origin VARCHAR(32) NOT NULL DEFAULT 'NORMAL';

ALTER TABLE note_revisions
    DROP CONSTRAINT uq_note_revisions_note_source_version;

ALTER TABLE note_revisions
    ADD CONSTRAINT uq_note_revisions_note_source_version_origin
        UNIQUE (note_id, source_note_version, origin);
