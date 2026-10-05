import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { canonicalProductName, normalizedUnit } from "./product-identity.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const pairBody = z.object({ leftProduct: z.string().trim().min(1).max(200), rightProduct: z.string().trim().min(1).max(200) }).strict();
const suppressionParams = z.object({ householdId: z.string().uuid(), suppressionId: z.string().uuid() }).strict();
const mergeBody = z.object({
  primaryId: z.string().uuid(), duplicateId: z.string().uuid(),
  resultName: z.string().trim().min(1).max(200),
  resultQuantity: z.coerce.number().positive().finite(),
  resultUnit: z.string().trim().min(1).max(80)
}).strict();

type CandidateItem = { id: string; name: string; quantity: Prisma.Decimal; unit: string; category: string | null; version: number };
function tokens(value: string): Set<string> { return new Set(canonicalProductName(value).split(" ").filter(token => token.length > 1)); }
function pairNames(left: string, right: string): [string, string] {
  return [canonicalProductName(left), canonicalProductName(right)].sort((a, b) => a.localeCompare(b)) as [string, string];
}
function relatedNames(left: string, right: string): boolean {
  const leftCanonical = canonicalProductName(left); const rightCanonical = canonicalProductName(right);
  if (leftCanonical === rightCanonical) return true;
  const leftTokens = [...tokens(left)]; const rightTokens = [...tokens(right)];
  if (!leftTokens.length || !rightTokens.length) return false;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  const additionalTokens = longer.filter(token => !shorter.includes(token));
  return shorter.every(token => longer.includes(token)) && additionalTokens.length === 1;
}
function buildPairs(items: CandidateItem[]) {
  const pairs: CandidateItem[][] = [];
  for (let left = 0; left < items.length; left += 1) for (let right = left + 1; right < items.length; right += 1)
    if (relatedNames(items[left]!.name, items[right]!.name)) pairs.push([items[left]!, items[right]!]);
  return pairs;
}

export async function productConsolidationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/pantry/consolidation-suggestions", async request => {
    const { householdId } = householdParams.parse(request.params); await requireHousehold(request, householdId);
    const [items, suppressions, learnings] = await Promise.all([
      db.pantryItem.findMany({ where: { householdId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, quantity: true, unit: true, category: true, version: true } }),
      db.consolidationSuppression.findMany({ where: { householdId } }),
      db.consolidationLearning.findMany({ where: { householdId } })
    ]);
    const ignored = new Set(suppressions.map(value => `${value.leftProduct}|${value.rightProduct}`));
    const learned = new Map(learnings.map(value => [`${value.leftProduct}|${value.rightProduct}`, value.mergeCount]));
    return buildPairs(items).flatMap(group => {
      const [leftProduct, rightProduct] = pairNames(group[0]!.name, group[1]!.name);
      const pairKey = `${leftProduct}|${rightProduct}`;
      if (ignored.has(pairKey)) return [];
      const canonicalNames = new Set(group.map(item => canonicalProductName(item.name)));
      const normalizedUnits = new Set(group.map(item => normalizedUnit(item.unit)));
      const mergeCount = learned.get(pairKey) ?? 0;
      const confidence = canonicalNames.size === 1 || mergeCount >= 2 ? "HIGH" : "REVIEW";
      return [{
        key: group.map(item => item.id).sort().join("|"), canonicalName: canonicalProductName(group[0]!.name),
        leftProduct, rightProduct, confidence,
        matchReason: mergeCount ? `Learned from ${mergeCount} prior merge${mergeCount === 1 ? "" : "s"}` : confidence === "HIGH" ? "Same canonical product name" : "Related product names",
        mergeCount, unitConflict: normalizedUnits.size > 1,
        availableNames: [...new Set(group.map(item => item.name))], availableUnits: [...new Set(group.map(item => item.unit))], items: group
      }];
    });
  });

  app.get("/api/v1/households/:householdId/pantry/consolidation-learning", async request => {
    const { householdId } = householdParams.parse(request.params); await requireHousehold(request, householdId);
    const [ignoredPairs, learnedPairs] = await Promise.all([
      db.consolidationSuppression.findMany({ where: { householdId }, orderBy: { createdAt: "desc" } }),
      db.consolidationLearning.findMany({ where: { householdId }, orderBy: [{ mergeCount: "desc" }, { updatedAt: "desc" }] })
    ]);
    return { ignoredPairs, learnedPairs };
  });

  app.post("/api/v1/households/:householdId/pantry/consolidation-suppressions", async request => {
    const { householdId } = householdParams.parse(request.params); const input = pairBody.parse(request.body);
    await requireHousehold(request, householdId, true);
    const [leftProduct, rightProduct] = pairNames(input.leftProduct, input.rightProduct);
    return db.consolidationSuppression.upsert({
      where: { householdId_leftProduct_rightProduct: { householdId, leftProduct, rightProduct } },
      update: {}, create: { householdId, leftProduct, rightProduct, createdByUserId: request.authUser!.id }
    });
  });

  app.delete("/api/v1/households/:householdId/pantry/consolidation-suppressions/:suppressionId", async (request, reply) => {
    const { householdId, suppressionId } = suppressionParams.parse(request.params); await requireHousehold(request, householdId, true);
    const existing = await db.consolidationSuppression.findFirst({ where: { id: suppressionId, householdId } });
    if (!existing) throw errors.notFound();
    await db.consolidationSuppression.delete({ where: { id: suppressionId } }); reply.code(204).send();
  });

  app.post("/api/v1/households/:householdId/pantry/consolidate", async request => {
    const { householdId } = householdParams.parse(request.params); const input = mergeBody.parse(request.body);
    await requireHousehold(request, householdId, true); if (input.primaryId === input.duplicateId) throw errors.conflict();
    return db.$transaction(async tx => {
      const items = await tx.pantryItem.findMany({ where: { householdId, id: { in: [input.primaryId, input.duplicateId] }, archivedAt: null } });
      if (items.length !== 2) throw errors.notFound();
      const primary = items.find(item => item.id === input.primaryId)!; const duplicate = items.find(item => item.id === input.duplicateId)!;
      if (!relatedNames(primary.name, duplicate.name)) throw errors.conflict();
      const [leftProduct, rightProduct] = pairNames(primary.name, duplicate.name);
      const updated = await tx.pantryItem.update({ where: { id: primary.id }, data: {
        name: input.resultName, normalizedName: input.resultName.trim().toLocaleLowerCase("en-US"), quantity: new Prisma.Decimal(input.resultQuantity), unit: input.resultUnit,
        category: primary.category ?? duplicate.category, expirationDate: primary.expirationDate ?? duplicate.expirationDate,
        updatedByUserId: request.authUser!.id, version: { increment: 1 }
      }});
      await tx.pantryItem.update({ where: { id: duplicate.id }, data: { archivedAt: new Date(), updatedByUserId: request.authUser!.id, version: { increment: 1 } } });
      await tx.consolidationLearning.upsert({
        where: { householdId_leftProduct_rightProduct: { householdId, leftProduct, rightProduct } },
        update: { mergeCount: { increment: 1 } }, create: { householdId, leftProduct, rightProduct, mergeCount: 1 }
      });
      await tx.consolidationSuppression.deleteMany({ where: { householdId, leftProduct, rightProduct } });
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "pantry.products.consolidated", resourceType: "PantryItem", resourceId: primary.id, result: "success", correlationId: request.correlationId, metadata: { duplicateId: duplicate.id, resultName: input.resultName, resultQuantity: input.resultQuantity, resultUnit: input.resultUnit, leftProduct, rightProduct } satisfies Prisma.InputJsonValue } });
      await tx.outboxMessage.create({ data: { topic: "pantry-events", messageType: "pantry.products.consolidated", aggregateType: "PantryItem", aggregateId: primary.id, correlationId: request.correlationId, payload: { householdId, primaryId: primary.id, duplicateId: duplicate.id } } });
      return { id: updated.id, name: updated.name, quantity: updated.quantity, unit: updated.unit, category: updated.category, expirationDate: updated.expirationDate, version: updated.version };
    });
  });
}
