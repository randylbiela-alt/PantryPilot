CREATE TYPE "ApplicationRole" AS ENUM ('USER', 'SUPPORT', 'SUPER_ADMIN');
ALTER TABLE "User" ADD COLUMN "applicationRole" "ApplicationRole" NOT NULL DEFAULT 'USER';
CREATE INDEX "User_applicationRole_idx" ON "User"("applicationRole");
UPDATE "User" SET "applicationRole" = 'SUPER_ADMIN' WHERE lower("primaryEmail") = lower('pantrypilotadmin@gmail.com');
