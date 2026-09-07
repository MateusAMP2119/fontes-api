ALTER TABLE "user" ADD COLUMN "username" TEXT;

CREATE UNIQUE INDEX "user_username_idx" ON "user"("username")
WHERE "username" IS NOT NULL;
