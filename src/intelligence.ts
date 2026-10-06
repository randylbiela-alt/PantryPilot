import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const weekQuery = z.object({ weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const expirationQuery = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }).strict();
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const dateOnly = (value: string) => new Date(`${value}T00:00:00.000Z`);
const todayUtc = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); };
const mondayUtc = () => { const date = todayUtc(); const day = date.getUTCDay(); date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1)); return date; };
const dayText = (value: Date) => value.toISOString().slice(0, 10);

const seasoningNames = new Set([
  "paprika",
  "oregano",
  "basil",
  "parsley",
  "cumin",
  "chili powder",
  "garlic powder",
  "onion powder",
  "italian seasoning",
  "thyme",
  "rosemary",
  "sage",
  "turmeric",
  "cinnamon",
  "nutmeg",
  "cloves",
  "pepper",
  "seasoning salt"
]);

const pantryStapleNames = new Set([
  "flour",
  "all purpose flour",
  "sugar",
  "brown sugar",
  "rice",
  "brown rice",
  "salt",
  "cornstarch",
  "baking soda",
  "baking powder",
  "oats",
  "rolled oats"
]);

function usesPresenceOnly(name: string) {

  const normalized = normalize(name);

  return (
    seasoningNames.has(normalized) ||
    pantryStapleNames.has(normalized)
  );
}

type Ingredient = { name: string; quantity: Prisma.Decimal; unit: string };
type PantryItemValue = { id?: string; name: string; normalizedName: string; quantity: Prisma.Decimal; unit: string; expirationDate?: Date | null };
type RecipeValue = { id: string; name: string; favorite: boolean; ingredients: Ingredient[] };
type PantryQuantity = { quantity: Prisma.Decimal; unit: string };

export type RecommendationIngredient = { name: string; requiredQuantity: number; availableQuantity: number; unit: string };
export type RecipeRecommendation = { recipeId: string; recipeName: string; score: number; availableIngredients: number; totalIngredients: number; missingIngredients: RecommendationIngredient[] };

function pantryLookup(pantryItems: PantryItemValue[]) {
 const pantry = new Map<string, PantryQuantity>();
 for (const item of pantryItems) {
 const key = `${normalize(item.normalizedName || item.name)}|${normalize(item.unit)}`;
 const current = pantry.get(key)?.quantity ?? new Prisma.Decimal(0);
 pantry.set(key, { quantity: current.plus(item.quantity), unit: item.unit });
 }
 return pantry;
}

export function calculateRecommendations(recipes: RecipeValue[], pantryItems: PantryItemValue[]): RecipeRecommendation[] {
 const pantry = pantryLookup(pantryItems);
 return recipes.map(recipe => {
 let availableIngredients = 0;
 const missingIngredients: RecommendationIngredient[] = [];
 for (const ingredient of recipe.ingredients) {
 const key = `${normalize(ingredient.name)}|${normalize(ingredient.unit)}`;
 const available = pantry.get(key)?.quantity ?? new Prisma.Decimal(0);
 const required = new Prisma.Decimal(ingredient.quantity);
 if (
  usesPresenceOnly(ingredient.name)
) {
  if (available.greaterThan(0)) {
    availableIngredients += 1;
  }
}
else if (
  available.greaterThanOrEqualTo(required)
) {
  availableIngredients += 1;
}
 else missingIngredients.push({ name: ingredient.name, requiredQuantity: required.toDecimalPlaces(3).toNumber(), availableQuantity: available.toDecimalPlaces(3).toNumber(), unit: ingredient.unit });
 }
 const totalIngredients = recipe.ingredients.length;
 const score = totalIngredients === 0 ? 0 : Math.round((availableIngredients / totalIngredients) * 100);
 return { recipeId: recipe.id, recipeName: recipe.name, score, availableIngredients, totalIngredients, missingIngredients, favorite: recipe.favorite };
 }).sort((left, right) => right.score - left.score || Number(right.favorite) - Number(left.favorite) || left.recipeName.localeCompare(right.recipeName)).map(({ favorite: _favorite, ...value }) => value);
}

const nameThresholds: Record<string, number> = { eggs: 6, milk: 0.5, chicken: 1, bread: 1, tortillas: 6 };
const unitThresholds: Record<string, number> = { item: 2, each: 2, lb: 1, bag: 1, box: 1, gallon: 0.5, gal: 0.5, dozen: 0.5 };
export function calculateLowStock(pantryItems: PantryItemValue[]) {
 return pantryItems.map(item => {
 const normalizedName = normalize(item.normalizedName || item.name);
 const threshold = nameThresholds[normalizedName] ?? unitThresholds[normalize(item.unit)] ?? 1;
 return { itemId: item.id ?? null, name: item.name, currentQuantity: new Prisma.Decimal(item.quantity).toNumber(), threshold, unit: item.unit };
 }).filter(item => item.currentQuantity < item.threshold).sort((a, b) => (a.currentQuantity / a.threshold) - (b.currentQuantity / b.threshold) || a.name.localeCompare(b.name));
}

export function calculateExpiring(pantryItems: PantryItemValue[], days: number, today = todayUtc()) {
 const end = new Date(today); end.setUTCDate(end.getUTCDate() + days);
 return pantryItems.filter(item => item.expirationDate && item.expirationDate >= today && item.expirationDate <= end).map(item => {
 const daysRemaining = Math.ceil((item.expirationDate!.getTime() - today.getTime()) / 86400000);
 return { itemId: item.id ?? null, name: item.name, expirationDate: dayText(item.expirationDate!), daysRemaining, priority: daysRemaining <= 1 ? "CRITICAL" : daysRemaining <= 3 ? "HIGH" : "MEDIUM" };
 }).sort((a, b) => a.daysRemaining - b.daysRemaining || a.name.localeCompare(b.name));
}

export function calculateReadiness(meals: Array<{ id: string; recipe: RecipeValue | null }>, pantryItems: PantryItemValue[]) {
 const pantry = pantryLookup(pantryItems);
 const remaining = new Map([...pantry.entries()].map(([key, value]) => [key, new Prisma.Decimal(value.quantity)]));
 let cookableMeals = 0;
 const mealsMissingIngredients: Array<{ mealId: string; recipeName: string | null; missingIngredients: string[] }> = [];
 for (const meal of meals) {
 if (!meal.recipe) { mealsMissingIngredients.push({ mealId: meal.id, recipeName: null, missingIngredients: ["Recipe unavailable"] }); continue; }
 const missing: string[] = [];
 for (const ingredient of meal.recipe.ingredients) {
 const key = `${normalize(ingredient.name)}|${normalize(ingredient.unit)}`;
 if (
  usesPresenceOnly(ingredient.name)
) {
  if (
    (remaining.get(key) ?? new Prisma.Decimal(0))
      .lessThanOrEqualTo(0)
  ) {
    missing.push(ingredient.name);
  }
}
else if (
  (remaining.get(key) ?? new Prisma.Decimal(0))
    .lessThan(ingredient.quantity)
) {
  missing.push(ingredient.name);
}
 }
 if (missing.length === 0) {
 cookableMeals += 1;
 for (const ingredient of meal.recipe.ingredients) {
 const key = `${normalize(ingredient.name)}|${normalize(ingredient.unit)}`;
 remaining.set(key, (remaining.get(key) ?? new Prisma.Decimal(0)).minus(ingredient.quantity));
 }
 } else mealsMissingIngredients.push({ mealId: meal.id, recipeName: meal.recipe.name, missingIngredients: missing });
 }
 const plannedMeals = meals.length;
 return { plannedMeals, cookableMeals, score: plannedMeals === 0 ? 0 : Math.round((cookableMeals / plannedMeals) * 100), mealsMissingIngredients };
}

async function loadBase(householdId: string) {
 return Promise.all([
 db.recipe.findMany({ where: { householdId }, include: { ingredients: { orderBy: { sortOrder: "asc" } } }, orderBy: [{ favorite: "desc" }, { name: "asc" }] }),
 db.pantryItem.findMany({ where: { householdId, archivedAt: null }, orderBy: { name: "asc" } })
 ]);
}

async function audit(request: any, householdId: string, action: string, metadata: Prisma.InputJsonValue) {
 await db.$transaction([
 db.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action, resourceType: "Household", resourceId: householdId, result: "success", correlationId: request.correlationId, metadata } }),
 db.outboxMessage.create({ data: { topic: "intelligence-events", messageType: "intelligence.refresh", aggregateType: "Household", aggregateId: householdId, correlationId: request.correlationId, payload: { householdId, action } } })
 ]);
}

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/intelligence/recommendations", async request => {
 const { householdId } = householdParams.parse(request.params); await requireHousehold(request, householdId);
 const [recipes, pantry] = await loadBase(householdId); const recommendations = calculateRecommendations(recipes, pantry);
 await audit(request, householdId, "intelligence.recommendation_generated", { recommendationCount: recommendations.length });
 return { recommendations };
 });

 app.get("/api/v1/households/:householdId/intelligence/low-stock", async request => {
 const { householdId } = householdParams.parse(request.params); await requireHousehold(request, householdId);
 const pantry = await db.pantryItem.findMany({ where: { householdId, archivedAt: null } });
 return { alerts: calculateLowStock(pantry) };
 });

 app.get("/api/v1/households/:householdId/intelligence/expiring", async request => {
 const { householdId } = householdParams.parse(request.params); const { days } = expirationQuery.parse(request.query); await requireHousehold(request, householdId);
 const pantry = await db.pantryItem.findMany({ where: { householdId, archivedAt: null, expirationDate: { not: null } } });
 return { days, items: calculateExpiring(pantry, days) };
 });

 app.get("/api/v1/households/:householdId/intelligence/readiness", async request => {
 const { householdId } = householdParams.parse(request.params); const query = weekQuery.parse(request.query); await requireHousehold(request, householdId);
 const weekStartDate = query.weekStartDate ? dateOnly(query.weekStartDate) : mondayUtc();
 const [plan, pantry] = await Promise.all([
 db.mealPlan.findUnique({ where: { householdId_weekStartDate: { householdId, weekStartDate } }, include: { meals: { include: { recipe: { include: { ingredients: true } } }, orderBy: [{ mealDate: "asc" }, { mealType: "asc" }] } } }),
 db.pantryItem.findMany({ where: { householdId, archivedAt: null } })
 ]);
 return { weekStartDate: dayText(weekStartDate), ...calculateReadiness(plan?.meals ?? [], pantry) };
 });

 app.get("/api/v1/households/:householdId/intelligence/dashboard", async request => {
 const { householdId } = householdParams.parse(request.params); const query = weekQuery.parse(request.query); await requireHousehold(request, householdId);
 const weekStartDate = query.weekStartDate ? dateOnly(query.weekStartDate) : mondayUtc();
 const [recipes, pantry, plan] = await Promise.all([
 db.recipe.findMany({ where: { householdId }, include: { ingredients: true } }),
 db.pantryItem.findMany({ where: { householdId, archivedAt: null } }),
 db.mealPlan.findUnique({ where: { householdId_weekStartDate: { householdId, weekStartDate } }, include: { meals: { include: { recipe: { include: { ingredients: true } } }, orderBy: [{ mealDate: "asc" }, { mealType: "asc" }] } } })
 ]);
 const recommendations = calculateRecommendations(recipes, pantry);
 const lowStock = calculateLowStock(pantry);
 const expiring = calculateExpiring(pantry, 7);
 const readiness = calculateReadiness(plan?.meals ?? [], pantry);
 const dashboard = { weekStartDate: dayText(weekStartDate), lowStockCount: lowStock.length, expiringCount: expiring.length, recommendedCount: recommendations.filter(value => value.score >= 80).length, readinessScore: readiness.score };
 await audit(request, householdId, "intelligence.dashboard_viewed", dashboard);
 return { dashboard, lowStock, expiring, recommendations: recommendations.slice(0, 5), readiness };
 });
}



