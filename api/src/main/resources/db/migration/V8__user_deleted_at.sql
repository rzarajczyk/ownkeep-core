ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ NULL;

UPDATE users
SET deleted_at = updated_at
WHERE enabled = FALSE
  AND deleted_at IS NULL;

CREATE INDEX users_deleted_at_idx ON users (deleted_at)
    WHERE deleted_at IS NOT NULL;
