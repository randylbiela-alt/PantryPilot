import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const uuid = z.string().uuid();
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mealType = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);
const householdParams = z.object({ householdId: uuid }).strict();
const planParams = z.object({ householdId: uuid, planId: uuid }).strict();
const mealParams = z.object({ householdId: uuid, planId: uuid, mealId: uuid }).strict();
const weekQuery = z.object({ weekStartDate: dateText }).strict();
const planInput = z.object({ weekStartDate: dateText }).strict();
const mealInput = z.object({
  mealDate: dateText,
  mealType,
  recipeId: uuid,
  servings: z.number().int().min(1).max(50).optional(),
  notes: z.string().trim().max(1000).nullable().optional()
}).strict();
const updateMealInput = mealInput.partial().extend({ version: z.number().int().min(1) }).strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const recipeInclude = { recipe: { include: { ingredients: { orderBy: { sortOrder: "asc" as const } } } } };
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const asText = (value: Date) => value.toISOString().slice(0, 10);

async function requireRecipe(householdId: string, recipeId: string) {
  const recipe = await db.recipe.findFirst({ where: { id: recipeId, householdId } });
  if (!recipe) throw errors.notFound();
  return recipe;
}

async function recordEvent(tx: Prisma.TransactionClient, request: FastifyRequest, householdId: string, mealId: string, recipeId: string | null, action: string) {
  await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action, resourceType: "PlannedMeal", resourceId: mealId, result: "success", correlationId: request.correlationId, metadata: { recipeId } } });
  await tx.outboxMessage.create({ data: { topic: "meal-events", messageType: action, aggregateType: "PlannedMeal", aggregateId: mealId, correlationId: request.correlationId, payload: { householdId, mealId, recipeId } } });
}

export async function mealPlanningRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/meal-plans/week", async request => {
    const { householdId } = householdParams.parse(request.params);
    const { weekStartDate } = weekQuery.parse(request.query);
    await requireHousehold(request, householdId);
    const plan = await db.mealPlan.findUnique({ where: { householdId_weekStartDate: { householdId, weekStartDate: asDate(weekStartDate) } }, include: { meals: { include: recipeInclude, orderBy: [{ mealDate: "asc" }, { mealType: "asc" }] } } });
    return plan ? { ...plan, weekStartDate: asText(plan.weekStartDate), meals: plan.meals.map(meal => ({ ...meal, mealDate: asText(meal.mealDate) })) } : null;
  });

  app.post("/api/v1/households/:householdId/meal-plans", async (request, reply) => {
    const { householdId } = householdParams.parse(request.params);
    const { weekStartDate } = planInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    const plan = await db.mealPlan.upsert({ where: { householdId_weekStartDate: { householdId, weekStartDate: asDate(weekStartDate) } }, update: {}, create: { householdId, weekStartDate: asDate(weekStartDate), status: "DRAFT", generatedBy: "MANUAL" }, include: { meals: { include: recipeInclude } } });
    return reply.code(201).send({ ...plan, weekStartDate: asText(plan.weekStartDate) });
  });

  app.post("/api/v1/households/:householdId/meal-plans/:planId/meals", async (request, reply) => {
    const { householdId, planId } = planParams.parse(request.params);
    const input = mealInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    const recipe = await requireRecipe(householdId, input.recipeId);
    const meal = await db.$transaction(async tx => {
      const created = await tx.plannedMeal.create({ data: { mealPlanId: planId, recipeId: recipe.id, mealDate: asDate(input.mealDate), mealType: input.mealType, displayName: recipe.name, notes: input.notes ?? null, preparationMinutes: recipe.prepMinutes + recipe.cookMinutes, budgetFriendly: true, servings: input.servings ?? recipe.servings }, include: recipeInclude });
      await recordEvent(tx, request, householdId, created.id, recipe.id, "meal.recipe_linked");
      return created;
    });
    return reply.code(201).send({ ...meal, mealDate: asText(meal.mealDate) });
  });

  app.patch("/api/v1/households/:householdId/meal-plans/:planId/meals/:mealId", async request => {
    const { householdId, planId, mealId } = mealParams.parse(request.params);
    const input = updateMealInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    const recipe = input.recipeId ? await requireRecipe(householdId, input.recipeId) : null;
    return db.$transaction(async tx => {
      const changed = await tx.plannedMeal.updateMany({ where: { id: mealId, mealPlanId: planId, version: input.version }, data: { ...(input.mealDate ? { mealDate: asDate(input.mealDate) } : {}), ...(input.mealType ? { mealType: input.mealType } : {}), ...(recipe ? { recipeId: recipe.id, displayName: recipe.name, preparationMinutes: recipe.prepMinutes + recipe.cookMinutes, servings: input.servings ?? recipe.servings } : input.servings ? { servings: input.servings } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}), version: { increment: 1 } } });
      if (changed.count !== 1) throw errors.conflict();
      const updated = await tx.plannedMeal.findUniqueOrThrow({ where: { id: mealId }, include: recipeInclude });
      await recordEvent(tx, request, householdId, mealId, updated.recipeId, "meal.recipe_link_updated");
      return { ...updated, mealDate: asText(updated.mealDate) };
    });
  });

  app.delete("/api/v1/households/:householdId/meal-plans/:planId/meals/:mealId", async (request, reply) => {
    const { householdId, planId, mealId } = mealParams.parse(request.params);
    const { version } = deleteQuery.parse(request.query);
    await requireHousehold(request, householdId, true);
    const deleted = await db.plannedMeal.deleteMany({ where: { id: mealId, mealPlanId: planId, version } });
    if (deleted.count !== 1) throw errors.conflict();
    return reply.code(204).send();
  });
}
