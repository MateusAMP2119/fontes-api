-- Existing projects were organization-visible. Preserve that access; new requests default to private.
ALTER TABLE project ADD COLUMN ownerId TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE project ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('private', 'public'));
CREATE TABLE organizationJoinAttempt (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
