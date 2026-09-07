-- Additive migration over the existing Better Auth / project schema.
CREATE TABLE IF NOT EXISTS onboarding (
 userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
 organizationId TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 operationId TEXT, completed INTEGER NOT NULL DEFAULT 0,
 changelog INTEGER NOT NULL DEFAULT 0, daily INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS onboardingInvite (
 tokenHash TEXT PRIMARY KEY, organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 creatorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 email TEXT, expiresAt INTEGER NOT NULL, sentAt INTEGER, leaseUntil INTEGER NOT NULL DEFAULT 0
);
