import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { normalizeName } from "./security.js";
import { calculateRecommendations, type RecipeRecommendation } from "./intelligence.js";

const params = z.object({ householdId: z.string().uuid(), recipeId: z.string().uuid() }).strict();

async function calculateMatch(householdId: string, recipeId: string): Promise<RecipeRecommendation> {
  const [recipe, pantry] = await Promise.all([
    db.recipe.findFirst({ where: { id: recipeId, householdId }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } }),
    db.pantryItem.findMany({ where: { householdId, archivedAt: null } })
  ]);
  if (!recipe) throw errors.notFound();
  const match = calculateRecommendations([recipe], pantry)[0];
  if (!match) throw errors.notFound();
  return match;
}

async function audit(request: FastifyRequest, householdId: string, recipeId: string, action: string, metadata: Prisma.InputJsonValue) {
  await db.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action, resourceType: "Recipe", resourceId: recipeId, result: "success", correlationId: request.correlationId, metadata } });
}

export async function recipeMatchingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/recipes/:recipeId/match", async request => {
    const { householdId, recipeId } = params.parse(request.params);
    await requireHousehold(request, householdId);
    const match = await calculateMatch(householdId, recipeId);
    await audit(request, householdId, recipeId, "recipe.match.viewed", { score: match.score, missingCount: match.missingIngredients.length });
    return match;
  });

  app.post("/api/v1/households/:householdId/recipes/:recipeId/add-missing-to-grocery", async request => {
    const { householdId, recipeId } = params.parse(request.params);
    await requireHousehold(request, householdId, true);
    const match = await calculateMatch(householdId, recipeId);
    return db.$transaction(async transaction => {
      let list = await transaction.groceryList.findFirst({ where: { householdId, status: "ACTIVE" }, include: { items: true }, orderBy: { updatedAt: "desc" } });
      if (!list) list = await transaction.groceryList.create({ data: { householdId, name: "Current List", status: "ACTIVE", createdByUserId: request.authUser!.id }, include: { items: true } });
      const existing = new Set(list.items.filter(item => !item.checked).map(item => item.normalizedName));
      const added: Array<{ id: string; name: string }> = [];
      let skipped = 0;
      for (const ingredient of match.missingIngredients) {
        const normalized = normalizeName(ingredient.name);
        if (existing.has(normalized)) { skipped += 1; continue; }
        const shortage = new Prisma.Decimal(ingredient.requiredQuantity).minus(ingredient.availableQuantity).toDecimalPlaces(3).toNumber();
        const displayName = `${ingredient.name} (${shortage} ${ingredient.unit})`;
        const created = await transaction.groceryListItem.create({ data: { groceryListId: list.id, name: displayName, normalizedName: normalized, checked: false } });
        existing.add(normalized);
        added.push({ id: created.id, name: displayName });
      }
      await transaction.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "recipe.missing_added_to_grocery", resourceType: "Recipe", resourceId: recipeId, result: "success", correlationId: request.correlationId, metadata: { added: added.length, skipped } } });
      await transaction.outboxMessage.create({ data: { topic: "grocery-events", messageType: "recipe.missing_added_to_grocery", aggregateType: "GroceryList", aggregateId: list.id, correlationId: request.correlationId, payload: { householdId, recipeId, groceryListId: list.id, added: added.length, skipped } } });
      return { groceryListId: list.id, added: added.length, skipped, items: added, match };
    });
  });
}
