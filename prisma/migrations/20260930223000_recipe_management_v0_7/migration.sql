CREATE TABLE "Recipe" (
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
  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Recipe_servings_check" CHECK ("servings" BETWEEN 1 AND 50),
  CONSTRAINT "Recipe_prepMinutes_check" CHECK ("prepMinutes" BETWEEN 0 AND 1440),
  CONSTRAINT "Recipe_cookMinutes_check" CHECK ("cookMinutes" BETWEEN 0 AND 1440),
  CONSTRAINT "Recipe_version_check" CHECK ("version" >= 1)
);
CREATE TABLE "RecipeIngredient" (
  "id" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "unit" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecipeIngredient_quantity_check" CHECK ("quantity" > 0)
);
CREATE INDEX "Recipe_householdId_name_idx" ON "Recipe"("householdId", "name");
CREATE INDEX "Recipe_householdId_favorite_idx" ON "Recipe"("householdId", "favorite");
CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient"("recipeId", "sortOrder");
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
