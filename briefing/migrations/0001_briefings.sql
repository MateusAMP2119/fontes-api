CREATE TABLE IF NOT EXISTS briefing (
  scope TEXT PRIMARY KEY CHECK (scope = 'general'),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  generated_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  CHECK ((payload IS NULL) = (generated_at IS NULL))
);
