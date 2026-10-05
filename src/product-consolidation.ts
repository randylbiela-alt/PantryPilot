import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { canonicalProductName, normalizedUnit } from "./product-identity.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const mergeBody = z.object({
  primaryId: z.string().uuid(),
  duplicateId: z.string().uuid(),
  resultName: z.string().trim().min(1).max(200),
  resultQuantity: z.coerce.number().positive().finite(),
  resultUnit: z.string().trim().min(1).max(80)
}).strict();

type CandidateItem = {
  id: string;
  name: string;
  quantity: Prisma.Decimal;
  unit: string;
  category: string | null;
  version: number;
};

function tokens(value: string): Set<string> {
  return new Set(canonicalProductName(value).split(" ").filter(token => token.length > 1));
}

function relatedNames(left: string, right: string): boolean {
  const leftCanonical = canonicalProductName(left);
  const rightCanonical = canonicalProductName(right);
  if (leftCanonical === rightCanonical) return true;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  const common = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return common === smaller || common / Math.max(leftTokens.size, rightTokens.size) >= 0.67;
}

function buildGroups(items: CandidateItem[]) {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const join = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (relatedNames(items[left]!.name, items[right]!.name)) join(left, right);
    }
  }
  const groups = new Map<number, CandidateItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  });
  return [...groups.values()].filter(group => group.length > 1);
}

export async function productConsolidationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/pantry/consolidation-suggestions", async request => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId);
    const items = await db.pantryItem.findMany({
      where: { householdId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, quantity: true, unit: true, category: true, version: true }
    });
    return buildGroups(items).map(group => {
      const canonicalNames = new Set(group.map(item => canonicalProductName(item.name)));
      const normalizedUnits = new Set(group.map(item => normalizedUnit(item.unit)));
      const confidence = canonicalNames.size === 1 ? "HIGH" : "REVIEW";
      return {
        key: group.map(item => item.id).sort().join("|"),
        canonicalName: canonicalProductName(group[0]!.name),
        confidence,
        matchReason: confidence === "HIGH" ? "Same canonical product name" : "Related product names",
        unitConflict: normalizedUnits.size > 1,
        availableNames: [...new Set(group.map(item => item.name))],
        availableUnits: [...new Set(group.map(item => item.unit))],
        items: group
      };
    });
  });

  app.post("/api/v1/households/:householdId/pantry/consolidate", async request => {
    const { householdId } = householdParams.parse(request.params);
    const input = mergeBody.parse(request.body);
    await requireHousehold(request, householdId, true);
    if (input.primaryId === input.duplicateId) throw errors.conflict();
    return db.$transaction(async tx => {
      const items = await tx.pantryItem.findMany({
        where: { householdId, id: { in: [input.primaryId, input.duplicateId] }, archivedAt: null }
      });
      if (items.length !== 2) throw errors.notFound();
      const primary = items.find(item => item.id === input.primaryId)!;
      const duplicate = items.find(item => item.id === input.duplicateId)!;
      if (!relatedNames(primary.name, duplicate.name)) throw errors.conflict();
      const updated = await tx.pantryItem.update({
        where: { id: primary.id },
        data: {
          name: input.resultName,
          normalizedName: input.resultName.trim().toLocaleLowerCase("en-US"),
          quantity: new Prisma.Decimal(input.resultQuantity),
          unit: input.resultUnit,
          category: primary.category ?? duplicate.category,
          expirationDate: primary.expirationDate ?? duplicate.expirationDate,
          updatedByUserId: request.authUser!.id,
          version: { increment: 1 }
        }
      });
      await tx.pantryItem.update({
        where: { id: duplicate.id },
        data: { archivedAt: new Date(), updatedByUserId: request.authUser!.id, version: { increment: 1 } }
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: request.authUser!.id,
          householdId,
          action: "pantry.products.consolidated",
          resourceType: "PantryItem",
          resourceId: primary.id,
          result: "success",
          correlationId: request.correlationId,
          metadata: {
            duplicateId: duplicate.id,
            resultName: input.resultName,
            resultQuantity: input.resultQuantity,
            resultUnit: input.resultUnit
          } satisfies Prisma.InputJsonValue
        }
      });
      await tx.outboxMessage.create({
        data: {
          topic: "pantry-events",
          messageType: "pantry.products.consolidated",
          aggregateType: "PantryItem",
          aggregateId: primary.id,
          correlationId: request.correlationId,
          payload: { householdId, primaryId: primary.id, duplicateId: duplicate.id }
        }
      });
      return {
        id: updated.id,
        name: updated.name,
        quantity: updated.quantity,
        unit: updated.unit,
        category: updated.category,
        expirationDate: updated.expirationDate,
        version: updated.version
      };
    });
  });
}
