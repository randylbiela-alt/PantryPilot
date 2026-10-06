import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { canonicalIngredientName, pantryPresence, usesPresenceOnly } from "./ingredient-families.js";

const params = z.object({ householdId: z.string().uuid() }).strict();
const body = z.object({ weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const weekDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const titleCase = (value: string) => value
 .split(" ")
 .filter(Boolean)
 .map(word => word
  .split("-")
  .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part)
  .join("-"))
 .join(" ");
const shoppingAliases = new Map<string, string>([
 ["celery rib", "celery"],
 ["celery ribs", "celery"],
 ["green capsicum", "bell pepper"],
 ["green capsicum / bell pepper", "bell pepper"],
 ["capsicum", "bell pepper"],
 ["crushed canned tomato", "crushed tomatoes"],
 ["canned crushed tomato", "crushed tomatoes"],
 ["canned tomato", "canned tomatoes"],
 ["long grain rice", "long grain rice"],
 ["fresh thyme", "thyme"],
 ["dried thyme", "thyme"]
]);
const shoppingName = (value: string) => {
 let cleaned = canonicalIngredientName(value)
  .replace(/\([^)]*\)/g, " ")
  .replace(/\[[^\]]*\]/g, " ")
  .replace(/\s*\/\s*/g, " / ")
  .replace(/,\s*(?:preferably|ideally)\b[^,]*/gi, " ")
  .replace(/,\s*(?:roughly\s+|finely\s+|thinly\s+|thickly\s+|freshly\s+)?(?:chopped|diced|minced|sliced|peeled|crushed|grated|shredded|trimmed|rinsed|drained|seeded|halved|quartered|cubed|cut|softened|melted|cooked|uncooked|torn)\b.*$/gi, " ")
  .replace(/,\s*(?:skinless|boneless|medium|large|small)\b.*$/gi, " ")
  .replace(/\b(?:skinless|boneless|uncooked|raw),?\s*/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "");
 if (/\bor\b/i.test(cleaned)) cleaned = cleaned.split(/\s+or\s+/i)[0] ?? cleaned;
 if (cleaned.includes(" / ")) cleaned = cleaned.split(" / ").at(-1) ?? cleaned;
 cleaned = shoppingAliases.get(cleaned.toLowerCase()) ?? cleaned;
 return titleCase(cleaned || canonicalIngredientName(value));
};

type RequiredIngredient = {
 name: string;
 normalizedName: string;
 pantryKey: string;
 unit: string;
 quantity: Prisma.Decimal;
};

async function recordEvents(
 tx: Prisma.TransactionClient,
 request: FastifyRequest,
 householdId: string,
 listId: string,
 generated: number,
 existingSkipped: number
) {
 await tx.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "grocery.generation_completed",
 resourceType: "GroceryList",
 resourceId: listId,
 result: "success",
 correlationId: request.correlationId,
 metadata: { generated, existingSkipped }
 }
 });
 await tx.outboxMessage.create({
 data: {
 topic: "grocery-events",
 messageType: "grocery.generated",
 aggregateType: "GroceryList",
 aggregateId: listId,
 correlationId: request.correlationId,
 payload: { householdId, groceryListId: listId, generated, existingSkipped }
 }
 });
}

export async function groceryGenerationRoutes(app: FastifyInstance): Promise<void> {
 app.post("/api/v1/households/:householdId/grocery-generation", async request => {
 const { householdId } = params.parse(request.params);
 const { weekStartDate } = body.parse(request.body);
 await requireHousehold(request, householdId, true);

 const [plan, pantryItems] = await Promise.all([
 db.mealPlan.findUnique({
 where: { householdId_weekStartDate: { householdId, weekStartDate: weekDate(weekStartDate) } },
 include: {
 meals: {
 where: { recipeId: { not: null } },
 include: { recipe: { include: { ingredients: true } } }
 }
 }
 }),
 db.pantryItem.findMany({ where: { householdId, archivedAt: null } })
 ]);

 const required = new Map<string, RequiredIngredient>();
 for (const meal of plan?.meals ?? []) {
 for (const ingredient of meal.recipe?.ingredients ?? []) {
 const canonicalName = canonicalIngredientName(ingredient.name);
 const displayName = shoppingName(ingredient.name);
 const shoppingNormalizedName = normalize(displayName);
 const unit = normalize(ingredient.unit);
 const pantryKey = `${canonicalName}|${unit}`;
 const aggregationKey = `${shoppingNormalizedName}|${unit}`;
 const multiplier = new Prisma.Decimal(meal.servings).div(meal.recipe!.servings);
 const quantity = new Prisma.Decimal(ingredient.quantity).mul(multiplier);
 const current = required.get(aggregationKey);
 required.set(aggregationKey, current
 ? { ...current, quantity: current.quantity.plus(quantity) }
 : { name: displayName, normalizedName: shoppingNormalizedName, pantryKey, unit: ingredient.unit, quantity });
 }
 }

 const pantry = new Map<string, Prisma.Decimal>();
 for (const item of pantryItems) {
 const key = `${canonicalIngredientName(item.normalizedName || item.name)}|${normalize(item.unit)}`;
 pantry.set(key, (pantry.get(key) ?? new Prisma.Decimal(0)).plus(item.quantity));
 }

 return db.$transaction(async tx => {
 let list = await tx.groceryList.findFirst({
 where: { householdId, status: "ACTIVE" },
 include: { items: true },
 orderBy: { updatedAt: "desc" }
 });
 if (!list) {
 list = await tx.groceryList.create({
 data: { householdId, name: "Current List", status: "ACTIVE", createdByUserId: request.authUser!.id },
 include: { items: true }
 });
 }

 const existing = new Set(list.items.filter(item => !item.checked).map(item => item.normalizedName));
 const items: Array<{ id: string; name: string; quantity: number; unit: string }> = [];
 let existingSkipped = 0;

 for (const ingredient of required.values()) {
 if (usesPresenceOnly(ingredient.name) && pantryPresence(pantryItems, ingredient.name)) continue;
 const shortage = ingredient.quantity.minus(pantry.get(ingredient.pantryKey) ?? new Prisma.Decimal(0));
 if (!shortage.greaterThan(0)) continue;
 if (existing.has(ingredient.normalizedName)) {
 existingSkipped += 1;
 continue;
 }
 const displayQuantity = shortage.toDecimalPlaces(3).toNumber();
 const created = await tx.groceryListItem.create({
 data: {
 groceryListId: list.id,
 name: `${ingredient.name} (${displayQuantity} ${ingredient.unit})`,
 normalizedName: ingredient.normalizedName,
 checked: false
 }
 });
 existing.add(ingredient.normalizedName);
 items.push({ id: created.id, name: ingredient.name, quantity: displayQuantity, unit: ingredient.unit });
 }

 await recordEvents(tx, request, householdId, list.id, items.length, existingSkipped);
 return { groceryListId: list.id, generated: items.length, existingSkipped, items };
 });
 });
}
