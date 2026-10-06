import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const itemParams = z.object({ householdId: z.string().uuid(), itemId: z.string().uuid() }).strict();
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), type: z.enum(["ADDED","ADJUSTED","CONSUMED","DISCARDED","EXPIRED","ARCHIVED"]).optional() }).strict();
const actionInput = z.object({ quantity: z.number().positive().max(100000), reason: z.string().trim().max(500).nullable().optional(), version: z.number().int().min(1) }).strict();
const adjustInput = z.object({ quantityAfter: z.number().min(0).max(100000), reason: z.string().trim().min(1).max(500), version: z.number().int().min(1) }).strict();

function serialize(row: any) {
 return { ...row, quantityBefore: Number(row.quantityBefore), quantityAfter: Number(row.quantityAfter), quantityDelta: Number(row.quantityDelta) };
}

async function changeQuantity(request: any, householdId: string, itemId: string, input: { version: number; quantityAfter: Prisma.Decimal; type: "CONSUMED"|"DISCARDED"|"EXPIRED"|"ADJUSTED"; reason?: string|null }) {
 await requireHousehold(request, householdId, true);
 return db.$transaction(async tx => {
 const item = await tx.pantryItem.findFirst({ where: { id: itemId, householdId, archivedAt: null } });
 if (!item) throw errors.notFound();
 if (item.version !== input.version) throw errors.conflict();
 const before = new Prisma.Decimal(item.quantity);
 if (input.quantityAfter.lessThan(0)) throw new Error("Quantity cannot be negative.");
 const archived = input.quantityAfter.equals(0) && (input.type === "DISCARDED" || input.type === "EXPIRED");
 const changed = await tx.pantryItem.updateMany({ where: { id: itemId, householdId, version: input.version, archivedAt: null }, data: { quantity: input.quantityAfter, archivedAt: archived ? new Date() : null, updatedByUserId: request.authUser!.id, version: { increment: 1 } } });
 if (changed.count !== 1) throw errors.conflict();
 const event = await tx.inventoryEvent.create({ data: { householdId, pantryItemId: item.id, pantryItemName: item.name, type: input.type, quantityBefore: before, quantityAfter: input.quantityAfter, quantityDelta: input.quantityAfter.minus(before), unit: item.unit, reason: input.reason ?? null, actorUserId: request.authUser!.id, correlationId: request.correlationId } });
 await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: `inventory.${input.type.toLowerCase()}`, resourceType: "PantryItem", resourceId: item.id, result: "success", correlationId: request.correlationId, metadata: { eventId: event.id, quantityBefore: before.toNumber(), quantityAfter: input.quantityAfter.toNumber(), unit: item.unit } } });
 return { item: { id: item.id, name: item.name, quantity: input.quantityAfter.toNumber(), unit: item.unit, archived, version: item.version + 1 }, event: serialize(event) };
 });
}

export async function inventoryHistoryRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/inventory-history", async request => {
 const { householdId } = householdParams.parse(request.params); const { limit, type } = historyQuery.parse(request.query); await requireHousehold(request, householdId);
 const rows = await db.inventoryEvent.findMany({ where: { householdId, ...(type ? { type } : {}) }, orderBy: { occurredAt: "desc" }, take: limit });
 return { items: rows.map(serialize), limit };
 });
 app.get("/api/v1/households/:householdId/pantry/:itemId/history", async request => {
 const { householdId, itemId } = itemParams.parse(request.params); const { limit, type } = historyQuery.parse(request.query); await requireHousehold(request, householdId);
 const rows = await db.inventoryEvent.findMany({ where: { householdId, pantryItemId: itemId, ...(type ? { type } : {}) }, orderBy: { occurredAt: "desc" }, take: limit });
 return { items: rows.map(serialize), limit };
 });
 app.post("/api/v1/households/:householdId/pantry/:itemId/consume", async request => { const { householdId, itemId } = itemParams.parse(request.params); const input = actionInput.parse(request.body); const item = await db.pantryItem.findFirst({ where: { id: itemId, householdId, archivedAt: null } }); if (!item) throw errors.notFound(); const after = new Prisma.Decimal(item.quantity).minus(input.quantity); if (after.lessThan(0)) throw new Error("Consumed quantity exceeds current quantity."); return changeQuantity(request, householdId, itemId, { version: input.version, quantityAfter: after, type: "CONSUMED", reason: input.reason ?? null }); });
 app.post("/api/v1/households/:householdId/pantry/:itemId/discard", async request => { const { householdId, itemId } = itemParams.parse(request.params); const input = actionInput.parse(request.body); const item = await db.pantryItem.findFirst({ where: { id: itemId, householdId, archivedAt: null } }); if (!item) throw errors.notFound(); const after = new Prisma.Decimal(item.quantity).minus(input.quantity); if (after.lessThan(0)) throw new Error("Discarded quantity exceeds current quantity."); return changeQuantity(request, householdId, itemId, { version: input.version, quantityAfter: after, type: "DISCARDED", reason: input.reason ?? null }); });
 app.post("/api/v1/households/:householdId/pantry/:itemId/expire", async request => { const { householdId, itemId } = itemParams.parse(request.params); const input = actionInput.parse(request.body); const item = await db.pantryItem.findFirst({ where: { id: itemId, householdId, archivedAt: null } }); if (!item) throw errors.notFound(); const after = new Prisma.Decimal(item.quantity).minus(input.quantity); if (after.lessThan(0)) throw new Error("Expired quantity exceeds current quantity."); return changeQuantity(request, householdId, itemId, { version: input.version, quantityAfter: after, type: "EXPIRED", reason: input.reason ?? null }); });
 app.post("/api/v1/households/:householdId/pantry/:itemId/adjust", async request => { const { householdId, itemId } = itemParams.parse(request.params); const input = adjustInput.parse(request.body); return changeQuantity(request, householdId, itemId, { version: input.version, quantityAfter: new Prisma.Decimal(input.quantityAfter), type: "ADJUSTED", reason: input.reason ?? null }); });
}
