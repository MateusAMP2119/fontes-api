-- Initial local schema. Run once against an empty local D1 database.

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "invitation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT,
  "status" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "inviterId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "jwks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  "expiresAt" DATE,
  "alg" TEXT,
  "crv" TEXT
);

CREATE TABLE "member" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "createdAt" DATE NOT NULL
);

CREATE TABLE "organization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "logo" TEXT,
  "createdAt" DATE NOT NULL,
  "metadata" TEXT
);

CREATE TABLE organizationJoinAttempt (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE "project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "createdAt" DATE NOT NULL
, ownerId TEXT REFERENCES "user"(id) ON DELETE SET NULL, visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('private', 'public')));

CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
, "activeOrganizationId" TEXT);

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
, "username" TEXT);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");

CREATE INDEX "account_userId_idx" ON "account" ("userId");


CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");

CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");

CREATE INDEX "member_userId_idx" ON "member" ("userId");

CREATE INDEX "organization_slug_idx" ON "organization" ("slug");

CREATE INDEX "project_organizationId_idx" ON "project" ("organizationId");

CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE UNIQUE INDEX "user_username_idx" ON "user"("username")
WHERE "username" IS NOT NULL;

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TRIGGER member_delete_empty_organization
AFTER DELETE ON member
BEGIN
  DELETE FROM organization WHERE id = OLD.organizationId
    AND NOT EXISTS (SELECT 1 FROM member WHERE organizationId = OLD.organizationId);
END;

CREATE TRIGGER organization_clear_session_selection
AFTER DELETE ON organization
BEGIN
  UPDATE session SET activeOrganizationId = NULL WHERE activeOrganizationId = OLD.id;
  DELETE FROM organizationJoinAttempt WHERE key = 'org:' || OLD.id;
END;

CREATE TRIGGER user_delete_private_data
BEFORE DELETE ON "user"
BEGIN
  DELETE FROM project WHERE ownerId = OLD.id AND visibility = 'private';
  DELETE FROM organizationJoinAttempt WHERE key = 'user:' || OLD.id;
END;

CREATE TRIGGER user_require_organization_owner
BEFORE DELETE ON "user"
WHEN EXISTS (
  SELECT 1 FROM member mine
  WHERE mine.userId = OLD.id
    AND instr(',' || mine.role || ',', ',owner,') > 0
    AND EXISTS (SELECT 1 FROM member other WHERE other.organizationId = mine.organizationId AND other.userId <> OLD.id)
    AND NOT EXISTS (
      SELECT 1 FROM member successor WHERE successor.organizationId = mine.organizationId
        AND successor.userId <> OLD.id AND instr(',' || successor.role || ',', ',owner,') > 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_ORGANIZATION_OWNERSHIP_BEFORE_DELETING_USER');
END;

CREATE TABLE authLocalMail (id TEXT PRIMARY KEY, recipient TEXT, subject TEXT, text TEXT, createdAt INTEGER);
