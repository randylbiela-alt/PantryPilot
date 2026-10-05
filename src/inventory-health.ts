import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const params = z.object({ householdId: z.string().uuid() }).strict();
const itemParams = z.object({ householdId: z.string().uuid(), itemId: z.string().uuid() }).strict();
const verifyBody = z.object({ version: z.number().int().min(1) }).strict();
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(value: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / DAY_MS));
}

function daysUntil(value: Date, now: Date): number {
  return Math.ceil((value.getTime() - now.getTime()) / DAY_MS);
}

export async function inventoryHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/inventory-health", async request => {
    const { householdId } = params.parse(request.params);
    await requireHousehold(request, householdId);
    const now = new Date();
    const items = await db.pantryItem.findMany({
      where: { householdId, archivedAt: null },
      orderBy: [{ updatedAt: "asc" }, { name: "asc" }]
    });

    const reviewedItems = items.map(item => {
      const ageDays = daysSince(item.updatedAt, now);
      const expirationDays = item.expirationDate ? daysUntil(item.expirationDate, now) : null;
      const expired = expirationDays !== null && expirationDays < 0;
      const expiringSoon = expirationDays !== null && expirationDays >= 0 && expirationDays <= 7;
      const status: "FRESH" | "REVIEW" | "STALE" | "EXPIRING" | "EXPIRED" =
        expired
          ? "EXPIRED"
          : expiringSoon
            ? "EXPIRING"
            : ageDays >= 120
              ? "STALE"
              : ageDays >= 60
                ? "REVIEW"
                : "FRESH";
      return {
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category,
        expirationDate: item.expirationDate,
        version: item.version,
        updatedAt: item.updatedAt,
        ageDays,
        expirationDays,
        status
      };
    });

    const counts = {
      fresh: reviewedItems.filter(item => item.status === "FRESH").length,
      review: reviewedItems.filter(item => item.status === "REVIEW").length,
      stale: reviewedItems.filter(item => item.status === "STALE").length,
      expiring: reviewedItems.filter(item => item.status === "EXPIRING").length,
      expired: reviewedItems.filter(item => item.status === "EXPIRED").length
    };
    const penalty = counts.review * 5 + counts.stale * 10 + counts.expiring * 8 + counts.expired * 15;
    const score = items.length ? Math.max(0, Math.round(100 - penalty / items.length)) : 0;
    const queue = reviewedItems
      .filter(item => item.status !== "FRESH")
      .sort((left, right) => {
        const rank = { EXPIRED: 0, EXPIRING: 1, STALE: 2, REVIEW: 3, FRESH: 4 } as const;
        return rank[left.status] - rank[right.status] || right.ageDays - left.ageDays || left.name.localeCompare(right.name);
      });

    return {
      generatedAt: now.toISOString(),
      score,
      totalItems: items.length,
      counts,
      queue
    };
  });

  app.post("/api/v1/households/:householdId/inventory-health/:itemId/verify", async request => {
    const { householdId, itemId } = itemParams.parse(request.params);
    const input = verifyBody.parse(request.body);
    await requireHousehold(request, householdId, true);
    return db.$transaction(async transaction => {
      const result = await transaction.pantryItem.updateMany({
        where: { id: itemId, householdId, version: input.version, archivedAt: null },
        data: { version: { increment: 1 }, updatedByUserId: request.authUser!.id, updatedAt: new Date() }
      });
      if (result.count !== 1) throw errors.conflict();
      const item = await transaction.pantryItem.findUniqueOrThrow({ where: { id: itemId } });
      await transaction.auditEvent.create({
        data: {
          actorUserId: request.authUser!.id,
          householdId,
          action: "pantry.item.verified",
          resourceType: "PantryItem",
          resourceId: itemId,
          result: "success",
          correlationId: request.correlationId,
          metadata: { version: item.version } satisfies Prisma.InputJsonValue
        }
      });
      await transaction.outboxMessage.create({
        data: {
          topic: "pantry-events",
          messageType: "pantry.item.verified",
          aggregateType: "PantryItem",
          aggregateId: itemId,
          correlationId: request.correlationId,
          payload: { householdId, itemId }
        }
      });
      return { id: item.id, version: item.version, updatedAt: item.updatedAt };
    });
  });
}

