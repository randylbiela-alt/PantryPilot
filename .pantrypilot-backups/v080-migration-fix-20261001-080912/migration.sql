ALTER TABLE "PlannedMeal"
  ADD COLUMN "recipeId" UUID,
  ADD COLUMN "mealType" "MealType" NOT NULL DEFAULT 'DINNER',
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "PlannedMeal_mealPlanId_mealDate_mealType_key"
  ON "PlannedMeal"("mealPlanId", "mealDate", "mealType");
CREATE INDEX "PlannedMeal_mealPlanId_mealDate_idx"
  ON "PlannedMeal"("mealPlanId", "mealDate");
CREATE INDEX "PlannedMeal_recipeId_idx" ON "PlannedMeal"("recipeId");
ALTER TABLE "PlannedMeal"
  ADD CONSTRAINT "PlannedMeal_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
