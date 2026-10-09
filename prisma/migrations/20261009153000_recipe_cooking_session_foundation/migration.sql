CREATE TABLE "RecipeCookingSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "householdId" UUID NOT NULL, "recipeId" UUID NOT NULL,
  "plannedMealId" UUID, "createdByUserId" UUID NOT NULL, "origin" TEXT NOT NULL DEFAULT 'AD_HOC',
  "status" TEXT NOT NULL DEFAULT 'DRAFT', "recipeVersion" INTEGER NOT NULL, "originalServings" INTEGER NOT NULL,
  "desiredServings" DECIMAL(10,2) NOT NULL, "batchMultiplier" DECIMAL(10,4) NOT NULL,
  "ingredientSnapshot" JSONB NOT NULL, "startedAt" TIMESTAMPTZ(6), "completedAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "RecipeCookingSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecipeCookingSession_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecipeCookingSession_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RecipeCookingSession_householdId_createdAt_idx" ON "RecipeCookingSession"("householdId", "createdAt");
CREATE INDEX "RecipeCookingSession_recipeId_status_idx" ON "RecipeCookingSession"("recipeId", "status");
CREATE INDEX "RecipeCookingSession_plannedMealId_idx" ON "RecipeCookingSession"("plannedMealId");
