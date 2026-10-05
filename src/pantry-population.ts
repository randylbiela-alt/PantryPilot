import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { importReceiptItems } from "./receipt-import-service.js";

const params = z.object({ householdId: z.string().uuid(), listId: z.string().uuid() }).strict();
const body = z.object({ version: z.number().int().min(1), addPurchasedToPantry: z.boolean().default(true) }).strict();

function groceryItemToPantry(name: string) {
  const clean = name.trim();
  const match = clean.match(/^(.*?)\s*\(([0-9]+(?:\.[0-9]+)?)\s+([^()]+)\)\s*$/);
  return match
    ? { name: match[1]!.trim(), quantity: Number(match[2]), unit: match[3]!.trim(), category: "Grocery reconciliation" }
    : { name: clean, quantity: 1, unit: "item", category: "Grocery reconciliation" };
}

export async function pantryPopulationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/households/:householdId/grocery-lists/:listId/complete-and-reconcile", async request => {
    const { householdId, listId } = params.parse(request.params);
    const input = body.parse(request.body);
    await requireHousehold(request, householdId, true);

    const list = await db.groceryList.findFirst({
      where: { id: listId, householdId, status: "ACTIVE", version: input.version },
      include: { items: true }
    });
    if (!list) throw errors.conflict();

    const purchased = list.items.filter(item => item.checked).map(item => groceryItemToPantry(item.name));
    const imported = input.addPurchasedToPantry && purchased.length
      ? await importReceiptItems(db, householdId, request.authUser!.id, purchased)
      : { created: 0, updated: 0, total: 0, items: [] };

    const completed = await db.$transaction(async tx => {
      const changed = await tx.groceryList.updateMany({
        where: { id: listId, householdId, status: "ACTIVE", version: input.version },
        data: { status: "COMPLETED", version: { increment: 1 } }
      });
      if (changed.count !== 1) throw errors.conflict();
      const row = await tx.groceryList.findUniqueOrThrow({ where: { id: listId } });
      await tx.auditEvent.create({
        data: {
          actorUserId: request.authUser!.id,
          householdId,
          action: "grocery.completed_and_reconciled",
          resourceType: "GroceryList",
          resourceId: listId,
          result: "success",
          correlationId: request.correlationId,
          metadata: { purchased: purchased.length, pantryCreated: imported.created, pantryUpdated: imported.updated } satisfies Prisma.InputJsonValue
        }
      });
      await tx.outboxMessage.create({
        data: {
          topic: "pantry-events",
          messageType: "grocery.completed_and_reconciled",
          aggregateType: "GroceryList",
          aggregateId: listId,
          correlationId: request.correlationId,
          payload: { householdId, listId, purchased: purchased.length, pantryCreated: imported.created, pantryUpdated: imported.updated }
        }
      });
      return row;
    });

    return { listId: completed.id, purchased: purchased.length, pantry: imported };
  });
}
