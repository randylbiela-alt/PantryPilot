ALTER TABLE "UserSession"
  ADD COLUMN "absoluteExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "rotatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "UserSession"
SET "absoluteExpiresAt" = "expiresAt"
WHERE "absoluteExpiresAt" IS NULL;

ALTER TABLE "UserSession"
  ALTER COLUMN "absoluteExpiresAt" SET NOT NULL;

CREATE INDEX "UserSession_expiration_idx"
  ON "UserSession" ("expiresAt", "absoluteExpiresAt", "revokedAt");
