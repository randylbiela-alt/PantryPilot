import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { calculateExpiring, calculateLowStock, calculateReadiness, calculateRecommendations } from "./intelligence.js";

const params = z.object({ householdId: z.string().uuid() }).strict();
const query = z.object({ weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const dateOnly = (value: string) => new Date(`${value}T00:00:00.000Z`);

const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    )
  );
const todayUtc = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); };
const mondayUtc = () => { const date = todayUtc(); const day = date.getUTCDay(); date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1)); return date; };
const dayText = (value: Date) => value.toISOString().slice(0, 10);

type Confidence = "HIGH" | "MEDIUM" | "LOW";
function confidence(score: number): Confidence { return score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW"; }

export async function forecastingRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/forecasting/summary", async request => {
 const { householdId } = params.parse(request.params);
 const { weekStartDate: week } = query.parse(request.query);
 await requireHousehold(request, householdId);
 const weekStartDate = week ? dateOnly(week) : mondayUtc();

 const [pantry, recipes, plan, groceryList] = await Promise.all([
 db.pantryItem.findMany({ where: { householdId, archivedAt: null }, orderBy: { name: "asc" } }),
 db.recipe.findMany({ where: { householdId }, include: { ingredients: true }, orderBy: [{ favorite: "desc" }, { name: "asc" }] }),
 db.mealPlan.findUnique({ where: { householdId_weekStartDate: { householdId, weekStartDate } }, include: { meals: { include: { recipe: { include: { ingredients: true } } }, orderBy: [{ mealDate: "asc" }, { mealType: "asc" }] } } }),
 db.groceryList.findFirst({ where: { householdId, status: "ACTIVE" }, include: { items: true }, orderBy: { updatedAt: "desc" } })
 ]);

 const expiring3 = calculateExpiring(pantry, 3);
 const expiring7 = calculateExpiring(pantry, 7);
 const expiring14 = calculateExpiring(pantry, 14);
 const expiring30 = calculateExpiring(pantry, 30);
 const lowStock = calculateLowStock(pantry);
 const readiness = calculateReadiness(plan?.meals ?? [], pantry);
 const recommendations = calculateRecommendations(recipes, pantry);
 const openGroceryItems = groceryList?.items.filter(item => !item.checked).length ?? 0;
 const missingIngredientNames = new Set(readiness.mealsMissingIngredients.flatMap(meal => meal.missingIngredients.filter(name => name !== "Recipe unavailable").map(normalize)));
 const shoppingPressureScore = Math.min(100, lowStock.length * 12 + missingIngredientNames.size * 10 + openGroceryItems * 4);

 const categorized = pantry.filter(item => Boolean(item.category?.trim())).length;
 const expirationTracked = pantry.filter(item => Boolean(item.expirationDate)).length;
 const recipeLinkedMeals = plan?.meals.filter(meal => Boolean(meal.recipeId)).length ?? 0;
 const plannedMeals = plan?.meals.length ?? 0;
 const dataQualityScore = pantry.length === 0 ? 0 : Math.round(
 ((categorized / pantry.length) * 30) +
 ((expirationTracked / pantry.length) * 30) +
 (plannedMeals ? (recipeLinkedMeals / plannedMeals) * 25 : 0) +
 (recipes.length ? 15 : 0)
 );

 const categoryRisks = new Map<string, { lowStock: number; expiring30: number; total: number }>();
 for (const item of pantry) {
 const category = item.category?.trim() || "Uncategorized";
 const current = categoryRisks.get(category) ?? { lowStock: 0, expiring30: 0, total: 0 };
 current.total += 1;
 if (lowStock.some(low => low.itemId === item.id)) current.lowStock += 1;
 if (expiring30.some(expiring => expiring.itemId === item.id)) current.expiring30 += 1;
 categoryRisks.set(category, current);
 }

 const response = {
 generatedAt: new Date().toISOString(),
 horizon: { weekStartDate: dayText(weekStartDate), maximumDays: 30 },
 confidence: { level: confidence(dataQualityScore), score: dataQualityScore, reasons: [
 `${categorized} of ${pantry.length} pantry items are categorized`,
 `${expirationTracked} of ${pantry.length} pantry items have expiration dates`,
 `${recipeLinkedMeals} of ${plannedMeals} planned meals are linked to recipes`,
 `${recipes.length} recipes are available for coverage analysis`
 ] },
 expirationRisk: {
 within3Days: expiring3.length,
 within7Days: expiring7.length,
 within14Days: expiring14.length,
 within30Days: expiring30.length,
 useFirst: expiring14.slice(0, 8)
 },
 mealCoverage: {
 plannedMeals: readiness.plannedMeals,
 cookableMeals: readiness.cookableMeals,
 mealsAtRisk: readiness.plannedMeals - readiness.cookableMeals,
 coveragePercent: readiness.score,
 missingMeals: readiness.mealsMissingIngredients
 },
 shoppingPressure: {
 score: shoppingPressureScore,
 level: shoppingPressureScore >= 70 ? "HIGH" : shoppingPressureScore >= 35 ? "MEDIUM" : "LOW",
 lowStockItems: lowStock.length,
 missingIngredients: missingIngredientNames.size,
 openGroceryItems
 },
 pantryCoverage: {
 recipesEvaluated: recommendations.length,
 recipesReady: recommendations.filter(recipe => recipe.score === 100).length,
 recipesAt80Plus: recommendations.filter(recipe => recipe.score >= 80).length,
 averageRecipeMatch: recommendations.length ? Math.round(recommendations.reduce((sum, recipe) => sum + recipe.score, 0) / recommendations.length) : 0,
 categoryRisks: [...categoryRisks.entries()].map(([category, value]) => ({ category, ...value })).sort((a, b) => (b.lowStock + b.expiring30) - (a.lowStock + a.expiring30) || a.category.localeCompare(b.category)).slice(0, 8)
 },
 limitations: [
 "Forecasts use current inventory, expiration dates, recipes, meal plans, and grocery state.",
 "Consumption velocity, depletion dates, waste rates, and cost forecasts are unavailable because transaction, disposal, and cost history are not recorded."
 ]
 };

 await db.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "forecasting.summary_viewed", resourceType: "Household", resourceId: householdId, result: "success", correlationId: request.correlationId, metadata: { confidence: response.confidence.level, dataQualityScore, shoppingPressureScore } } });
 return response;
 });
}
