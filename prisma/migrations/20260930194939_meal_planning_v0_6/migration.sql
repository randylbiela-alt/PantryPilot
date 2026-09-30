/*
  Warnings:

  - A unique constraint covering the columns `[mealPlanId,mealDate,mealType]` on the table `PlannedMeal` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER');

-- AlterTable
ALTER TABLE "PlannedMeal" ADD COLUMN     "mealType" "MealType" NOT NULL DEFAULT 'DINNER',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "preparationMinutes" SET DEFAULT 0;

-- CreateIndex
CREATE INDEX "PlannedMeal_mealPlanId_mealDate_idx" ON "PlannedMeal"("mealPlanId", "mealDate");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedMeal_mealPlanId_mealDate_mealType_key" ON "PlannedMeal"("mealPlanId", "mealDate", "mealType");

-- RenameIndex
ALTER INDEX "UserSession_expiration_idx" RENAME TO "UserSession_expiresAt_absoluteExpiresAt_revokedAt_idx";
