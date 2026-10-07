CREATE TABLE "SpiceCabinetItem" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "onHand" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" UUID NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SpiceCabinetItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SpiceCabinetItem_householdId_normalizedName_key" ON "SpiceCabinetItem"("householdId", "normalizedName");
CREATE INDEX "SpiceCabinetItem_householdId_onHand_idx" ON "SpiceCabinetItem"("householdId", "onHand");
ALTER TABLE "SpiceCabinetItem" ADD CONSTRAINT "SpiceCabinetItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
