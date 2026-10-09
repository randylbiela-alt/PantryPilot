CREATE TABLE "RecipeIngredientPantryMapping" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "ingredientNormalizedName" TEXT NOT NULL,
  "pantryItemId" UUID NOT NULL,
  "matchMethod" TEXT NOT NULL DEFAULT 'MANUAL',
  "confirmedByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "RecipeIngredientPantryMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecipeIngredientPantryMapping_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecipeIngredientPantryMapping_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecipeIngredientPantryMapping_pantryItemId_fkey" FOREIGN KEY ("pantryItemId") REFERENCES "PantryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RecipeIngredientPantryMapping_householdId_recipeId_ingredientNormalizedName_key" ON "RecipeIngredientPantryMapping"("householdId", "recipeId", "ingredientNormalizedName");
CREATE INDEX "RecipeIngredientPantryMapping_pantryItemId_idx" ON "RecipeIngredientPantryMapping"("pantryItemId");
