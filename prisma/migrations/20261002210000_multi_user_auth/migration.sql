CREATE TYPE "AuthFlowProvider" AS ENUM ('MICROSOFT', 'GOOGLE');
CREATE TYPE "HouseholdInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
CREATE TABLE "AuthFlow" (
  "id" UUID NOT NULL,
  "provider" "AuthFlowProvider" NOT NULL,
  "stateHash" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "pkceVerifier" TEXT NOT NULL,
  "inviteTokenHash" TEXT,
  "returnUrl" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthFlow_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HouseholdInvite" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "role" "HouseholdRole" NOT NULL DEFAULT 'MEMBER',
  "tokenHash" TEXT NOT NULL,
  "status" "HouseholdInviteStatus" NOT NULL DEFAULT 'PENDING',
  "invitedByUserId" UUID NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "acceptedAt" TIMESTAMPTZ(6),
  "acceptedByUserId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HouseholdInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthFlow_stateHash_key" ON "AuthFlow"("stateHash");
CREATE INDEX "AuthFlow_expiresAt_idx" ON "AuthFlow"("expiresAt");
CREATE UNIQUE INDEX "HouseholdInvite_tokenHash_key" ON "HouseholdInvite"("tokenHash");
CREATE INDEX "HouseholdInvite_householdId_status_idx" ON "HouseholdInvite"("householdId", "status");
CREATE INDEX "HouseholdInvite_normalizedEmail_status_idx" ON "HouseholdInvite"("normalizedEmail", "status");
