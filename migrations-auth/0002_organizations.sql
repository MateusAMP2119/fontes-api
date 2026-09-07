-- Better Auth organization plugin tables plus the app's own project table.

CREATE TABLE "organization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "logo" TEXT,
  "createdAt" DATE NOT NULL,
  "metadata" TEXT
);

CREATE TABLE "member" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "createdAt" DATE NOT NULL
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

ALTER TABLE "session" ADD COLUMN "activeOrganizationId" TEXT;

CREATE TABLE "project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "createdAt" DATE NOT NULL
);

CREATE INDEX "organization_slug_idx" ON "organization" ("slug");
CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");
CREATE INDEX "member_userId_idx" ON "member" ("userId");
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");
CREATE INDEX "project_organizationId_idx" ON "project" ("organizationId");
