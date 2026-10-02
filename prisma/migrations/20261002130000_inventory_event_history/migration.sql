CREATE TYPE "InventoryEventType" AS ENUM ('ADDED', 'ADJUSTED', 'CONSUMED', 'DISCARDED', 'EXPIRED', 'ARCHIVED');

CREATE TABLE "InventoryEvent" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "pantryItemId" UUID NOT NULL,
  "pantryItemName" TEXT NOT NULL,
  "type" "InventoryEventType" NOT NULL,
  "quantityBefore" DECIMAL(12,3) NOT NULL,
  "quantityAfter" DECIMAL(12,3) NOT NULL,
  "quantityDelta" DECIMAL(12,3) NOT NULL,
  "unit" TEXT NOT NULL,
  "reason" TEXT,
  "actorUserId" UUID NOT NULL,
  "correlationId" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryEvent_householdId_occurredAt_idx" ON "InventoryEvent"("householdId", "occurredAt");
CREATE INDEX "InventoryEvent_pantryItemId_occurredAt_idx" ON "InventoryEvent"("pantryItemId", "occurredAt");
CREATE INDEX "InventoryEvent_householdId_type_occurredAt_idx" ON "InventoryEvent"("householdId", "type", "occurredAt");
