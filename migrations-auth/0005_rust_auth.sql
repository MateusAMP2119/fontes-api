-- Separate one-time credentials from Better Auth's verification records.
CREATE TABLE authToken (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX authToken_expiry_idx ON authToken(expiresAt);
CREATE TABLE authThrottle (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
