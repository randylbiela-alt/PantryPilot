DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'MealType'
  ) THEN
    CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER');
  END IF;
END
$$;

ALTER TABLE "PlannedMeal"
  ADD COLUMN IF NOT EXISTS "recipeId" UUID,
  ADD COLUMN IF NOT EXISTS "mealType" "MealType" NOT NULL DEFAULT 'DINNER',
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS "PlannedMeal_mealPlanId_mealDate_mealType_key"
  ON "PlannedMeal"("mealPlanId", "mealDate", "mealType");

CREATE INDEX IF NOT EXISTS "PlannedMeal_mealPlanId_mealDate_idx"
  ON "PlannedMeal"("mealPlanId", "mealDate");

CREATE INDEX IF NOT EXISTS "PlannedMeal_recipeId_idx"
  ON "PlannedMeal"("recipeId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PlannedMeal_recipeId_fkey'
  ) THEN
    ALTER TABLE "PlannedMeal"
      ADD CONSTRAINT "PlannedMeal_recipeId_fkey"
      FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
