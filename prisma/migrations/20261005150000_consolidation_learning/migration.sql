CREATE TABLE "ConsolidationSuppression" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "leftProduct" TEXT NOT NULL,
  "rightProduct" TEXT NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsolidationSuppression_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ConsolidationLearning" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "leftProduct" TEXT NOT NULL,
  "rightProduct" TEXT NOT NULL,
  "mergeCount" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ConsolidationLearning_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConsolidationSuppression_householdId_leftProduct_rightProduct_key" ON "ConsolidationSuppression"("householdId", "leftProduct", "rightProduct");
CREATE INDEX "ConsolidationSuppression_householdId_createdAt_idx" ON "ConsolidationSuppression"("householdId", "createdAt");
CREATE UNIQUE INDEX "ConsolidationLearning_householdId_leftProduct_rightProduct_key" ON "ConsolidationLearning"("householdId", "leftProduct", "rightProduct");
CREATE INDEX "ConsolidationLearning_householdId_mergeCount_idx" ON "ConsolidationLearning"("householdId", "mergeCount");
ALTER TABLE "ConsolidationSuppression" ADD CONSTRAINT "ConsolidationSuppression_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsolidationLearning" ADD CONSTRAINT "ConsolidationLearning_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
