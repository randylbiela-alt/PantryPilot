CREATE TABLE IF NOT EXISTS "Recipe" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "servings" INTEGER NOT NULL DEFAULT 4,
  "prepMinutes" INTEGER NOT NULL DEFAULT 0,
  "cookMinutes" INTEGER NOT NULL DEFAULT 0,
  "favorite" BOOLEAN NOT NULL DEFAULT false,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecipeIngredient" (
  "id" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "unit" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Recipe_householdId_name_idx"
  ON "Recipe"("householdId", "name");
CREATE INDEX IF NOT EXISTS "Recipe_householdId_favorite_idx"
  ON "Recipe"("householdId", "favorite");
CREATE INDEX IF NOT EXISTS "RecipeIngredient_recipeId_sortOrder_idx"
  ON "RecipeIngredient"("recipeId", "sortOrder");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Recipe_householdId_fkey'
  ) THEN
    ALTER TABLE "Recipe"
      ADD CONSTRAINT "Recipe_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RecipeIngredient_recipeId_fkey'
  ) THEN
    ALTER TABLE "RecipeIngredient"
      ADD CONSTRAINT "RecipeIngredient_recipeId_fkey"
      FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
