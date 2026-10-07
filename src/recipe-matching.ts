import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { normalizeName } from "./security.js";
import { calculateRecommendations, type RecipeRecommendation } from "./intelligence.js";
import { canonicalSpiceName } from "./spice-recognition.js";

const params = z.object({ householdId: z.string().uuid(), recipeId: z.string().uuid() }).strict();
const titleCase = (value: string) => value.split(" ").filter(Boolean).map(word => word.split("-").map(part => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part).join("-")).join(" ");
const shoppingAliases = new Map<string, string>([
 ["andouille", "andouille sausage"], ["andouille sausage", "andouille sausage"],
 ["andouille or smoked sausage", "andouille sausage"], ["smoked sausage", "smoked sausage"],
 ["kielbasa", "kielbasa sausage"], ["polish sausage", "polish sausage"],
 ["celery rib", "celery"], ["celery ribs", "celery"],
 ["green capsicum", "bell pepper"], ["green capsicum / bell pepper", "bell pepper"], ["capsicum", "bell pepper"],
 ["crushed canned tomato", "crushed tomatoes"], ["canned crushed tomato", "crushed tomatoes"],
 ["fresh thyme", "thyme"], ["dried thyme", "thyme"]
]);
const shoppingName = (value: string) => {
 let cleaned = normalizeName(value)
  .replace(/\([^)]*\)/g, " ")
  .replace(/\[[^\]]*\]/g, " ")
  .replace(/\s*\/\s*/g, " / ")
  .replace(/,\s*(?:preferably|ideally)\b[^,]*/gi, " ")
  .replace(/,\s*(?:roughly\s+|finely\s+|thinly\s+|thickly\s+|freshly\s+)?(?:chopped|diced|minced|sliced|peeled|crushed|grated|shredded|trimmed|rinsed|drained|seeded|halved|quartered|cubed|cut|softened|melted|cooked|uncooked|torn)\b.*$/gi, " ")
  .replace(/,\s*(?:skinless|boneless|medium|large|small)\b.*$/gi, " ")
  .replace(/\b(?:skinless|boneless|uncooked|raw),?\s*/gi, " ")
  .replace(/\s+/g, " ").trim().replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "");
 if (/\bor\b/i.test(cleaned)) cleaned = cleaned.split(/\s+or\s+/i)[0] ?? cleaned;
 if (cleaned.includes(" / ")) cleaned = cleaned.split(" / ").at(-1) ?? cleaned;
 cleaned = shoppingAliases.get(cleaned.toLowerCase()) ?? cleaned;
 return titleCase(cleaned || normalizeName(value));
};

async function calculateMatch(householdId: string, recipeId: string): Promise<RecipeRecommendation> {
 const [recipe, pantry, spiceCabinet] = await Promise.all([
  db.recipe.findFirst({ where: { id: recipeId, householdId }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } }),
  db.pantryItem.findMany({ where: { householdId, archivedAt: null } }),
  db.spiceCabinetItem.findMany({ where: { householdId }, select: { name: true, onHand: true } })
 ]);
 if (!recipe) throw errors.notFound();
 const baseMatch = calculateRecommendations([recipe], pantry)[0];
 if (!baseMatch) throw errors.notFound();

 const cabinetAvailability = new Map<string, boolean>();
 for (const item of spiceCabinet) {
  const canonical = canonicalSpiceName(item.name);
  if (canonical) cabinetAvailability.set(normalizeName(canonical), item.onHand);
 }

 const spiceKeys = new Set(recipe.ingredients
  .map(ingredient => canonicalSpiceName(ingredient.name))
  .filter((name): name is string => name !== null)
  .map(name => normalizeName(name)));
 const missingIngredients = baseMatch.missingIngredients.filter(ingredient => {
  const canonical = canonicalSpiceName(ingredient.name);
  return !canonical || !spiceKeys.has(normalizeName(canonical));
 });

 for (const ingredient of recipe.ingredients) {
  const canonical = canonicalSpiceName(ingredient.name);
  if (!canonical) continue;
  const cabinetKey = normalizeName(canonical);
  if (cabinetAvailability.get(cabinetKey) === true) continue;
  missingIngredients.push({
   name: canonical,
   requiredQuantity: new Prisma.Decimal(ingredient.quantity).toDecimalPlaces(3).toNumber(),
   availableQuantity: 0,
   unit: ingredient.unit
  });
 }

 const availableIngredients = Math.max(0, baseMatch.totalIngredients - missingIngredients.length);
 const score = baseMatch.totalIngredients === 0 ? 100 : Math.round((availableIngredients / baseMatch.totalIngredients) * 100);
 return { ...baseMatch, score, availableIngredients, missingIngredients };
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
 const spiceName = canonicalSpiceName(ingredient.name);
 const productName = spiceName ?? shoppingName(ingredient.name);
 const normalized = normalizeName(productName);
 if (existing.has(normalized)) { skipped += 1; continue; }
 const shortage = new Prisma.Decimal(ingredient.requiredQuantity).minus(ingredient.availableQuantity).toDecimalPlaces(3).toNumber();
 const displayName = spiceName ?? `${productName} (${shortage} ${ingredient.unit})`;
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
