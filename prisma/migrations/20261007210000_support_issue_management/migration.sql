CREATE TYPE "SupportIssueStatus" AS ENUM ('OPEN','IN_PROGRESS','WAITING_FOR_USER','READY_FOR_VALIDATION','RESOLVED','CLOSED','DUPLICATE');
CREATE TYPE "SupportIssuePriority" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE "SupportIssueCategory" AS ENUM ('AUTHENTICATION','HOUSEHOLD_ACCESS','PANTRY_DATA','SHOPPING','RECIPES','MEALS','IMPORT','ANALYTICS','PERFORMANCE','DISPLAY','DATA','OTHER');
CREATE TABLE "SupportIssue" (
  "id" UUID NOT NULL, "issueNumber" SERIAL NOT NULL, "title" TEXT NOT NULL, "description" TEXT NOT NULL,
  "status" "SupportIssueStatus" NOT NULL DEFAULT 'OPEN', "priority" "SupportIssuePriority" NOT NULL DEFAULT 'MEDIUM',
  "category" "SupportIssueCategory" NOT NULL DEFAULT 'OTHER', "affectedUserId" UUID, "affectedHouseholdId" UUID,
  "assignedToUserId" UUID, "correlationId" TEXT, "resolutionNotes" TEXT, "version" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" UUID NOT NULL, "updatedByUserId" UUID NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL, "resolvedAt" TIMESTAMPTZ(6), "closedAt" TIMESTAMPTZ(6),
  CONSTRAINT "SupportIssue_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SupportIssueComment" ("id" UUID NOT NULL, "issueId" UUID NOT NULL, "authorUserId" UUID NOT NULL, "body" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SupportIssueComment_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "SupportIssue_issueNumber_key" ON "SupportIssue"("issueNumber");
CREATE INDEX "SupportIssue_status_priority_updatedAt_idx" ON "SupportIssue"("status","priority","updatedAt");
CREATE INDEX "SupportIssue_affectedUserId_updatedAt_idx" ON "SupportIssue"("affectedUserId","updatedAt");
CREATE INDEX "SupportIssue_affectedHouseholdId_updatedAt_idx" ON "SupportIssue"("affectedHouseholdId","updatedAt");
CREATE INDEX "SupportIssue_assignedToUserId_status_idx" ON "SupportIssue"("assignedToUserId","status");
CREATE INDEX "SupportIssueComment_issueId_createdAt_idx" ON "SupportIssueComment"("issueId","createdAt");
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_affectedUserId_fkey" FOREIGN KEY ("affectedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_affectedHouseholdId_fkey" FOREIGN KEY ("affectedHouseholdId") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportIssueComment" ADD CONSTRAINT "SupportIssueComment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "SupportIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportIssueComment" ADD CONSTRAINT "SupportIssueComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
