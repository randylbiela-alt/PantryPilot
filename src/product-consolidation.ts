import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { canonicalProductName, normalizedUnit } from "./product-identity.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const mergeBody = z.object({ primaryId: z.string().uuid(), duplicateId: z.string().uuid() }).strict();

export async function productConsolidationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/pantry/consolidation-suggestions", async request => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId);
    const items = await db.pantryItem.findMany({ where: { householdId, archivedAt: null }, orderBy: { name: "asc" } });
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const key = `${canonicalProductName(item.name)}|${normalizedUnit(item.unit)}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.entries()].filter(([, group]) => group.length > 1).map(([key, group]) => ({
      key,
      canonicalName: canonicalProductName(group[0]!.name),
      items: group.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, unit: item.unit, category: item.category, version: item.version }))
    }));
  });

  app.post("/api/v1/households/:householdId/pantry/consolidate", async request => {
    const { householdId } = householdParams.parse(request.params);
    const input = mergeBody.parse(request.body);
    await requireHousehold(request, householdId, true);
    if (input.primaryId === input.duplicateId) throw errors.conflict();
    return db.$transaction(async tx => {
      const items = await tx.pantryItem.findMany({ where: { householdId, id: { in: [input.primaryId, input.duplicateId] }, archivedAt: null } });
      if (items.length !== 2) throw errors.notFound();
      const primary = items.find(item => item.id === input.primaryId)!;
      const duplicate = items.find(item => item.id === input.duplicateId)!;
      if (canonicalProductName(primary.name) !== canonicalProductName(duplicate.name) || normalizedUnit(primary.unit) !== normalizedUnit(duplicate.unit)) {
        throw errors.conflict();
      }
      const updated = await tx.pantryItem.update({
        where: { id: primary.id },
        data: {
          quantity: { increment: duplicate.quantity },
          category: primary.category ?? duplicate.category,
          expirationDate: primary.expirationDate ?? duplicate.expirationDate,
          updatedByUserId: request.authUser!.id,
          version: { increment: 1 }
        }
      });
      await tx.pantryItem.update({ where: { id: duplicate.id }, data: { archivedAt: new Date(), updatedByUserId: request.authUser!.id, version: { increment: 1 } } });
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "pantry.products.consolidated", resourceType: "PantryItem", resourceId: primary.id, result: "success", correlationId: request.correlationId, metadata: { duplicateId: duplicate.id, canonicalName: canonicalProductName(primary.name) } satisfies Prisma.InputJsonValue } });
      await tx.outboxMessage.create({ data: { topic: "pantry-events", messageType: "pantry.products.consolidated", aggregateType: "PantryItem", aggregateId: primary.id, correlationId: request.correlationId, payload: { householdId, primaryId: primary.id, duplicateId: duplicate.id } } });
      return { id: updated.id, name: updated.name, quantity: updated.quantity, unit: updated.unit, category: updated.category, expirationDate: updated.expirationDate, version: updated.version };
    });
  });
}
