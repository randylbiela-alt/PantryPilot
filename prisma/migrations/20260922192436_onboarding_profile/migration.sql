ALTER TABLE "UserProfile"
    ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en-US',
    ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'America/Indiana/Indianapolis',
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_householdSizeDefault_check"
    CHECK ("householdSizeDefault" BETWEEN 1 AND 50);

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_weeklyBudget_check"
    CHECK (
        "weeklyBudget" IS NULL
        OR "weeklyBudget" >= 0
    );

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_version_check"
    CHECK ("version" >= 1);