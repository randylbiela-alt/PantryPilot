CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

CREATE TABLE "AuthFlow" (
    "id" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
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
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" UUID NOT NULL,
    "acceptedByUserId" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "HouseholdInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthFlow_stateHash_key" ON "AuthFlow"("stateHash");
CREATE INDEX "AuthFlow_provider_expiresAt_idx" ON "AuthFlow"("provider", "expiresAt");
CREATE INDEX "AuthFlow_expiresAt_idx" ON "AuthFlow"("expiresAt");
CREATE UNIQUE INDEX "HouseholdInvite_tokenHash_key" ON "HouseholdInvite"("tokenHash");
CREATE INDEX "HouseholdInvite_householdId_status_expiresAt_idx" ON "HouseholdInvite"("householdId", "status", "expiresAt");
CREATE INDEX "HouseholdInvite_normalizedEmail_status_idx" ON "HouseholdInvite"("normalizedEmail", "status");
CREATE INDEX "HouseholdInvite_invitedByUserId_idx" ON "HouseholdInvite"("invitedByUserId");
CREATE INDEX "HouseholdInvite_acceptedByUserId_idx" ON "HouseholdInvite"("acceptedByUserId");

ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
