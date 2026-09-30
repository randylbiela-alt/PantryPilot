import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mealType = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);

const householdParams = z.object({ householdId: uuid }).strict();
const planParams = z.object({ householdId: uuid, planId: uuid }).strict();
const mealParams = z.object({ householdId: uuid, planId: uuid, mealId: uuid }).strict();
const weekQuery = z.object({ weekStartDate: isoDate }).strict();

const createPlanInput = z.object({ weekStartDate: isoDate }).strict();
const createMealInput = z.object({
  mealDate: isoDate,
  mealType,
  displayName: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000).nullable().optional(),
  servings: z.number().int().min(1).max(50).default(4)
}).strict();
const updateMealInput = createMealInput.partial().extend({ version: z.number().int().min(1) }).strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();

const mealSelect = {
  id: true, mealPlanId: true, mealDate: true, mealType: true,
  displayName: true, notes: true, servings: true, version: true
} satisfies Prisma.PlannedMealSelect;

const planInclude = {
  meals: { select: mealSelect, orderBy: [{ mealDate: "asc" }, { mealType: "asc" }] }
} satisfies Prisma.MealPlanInclude;

function asDate(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function dateOnly(value: Date): string { return value.toISOString().slice(0, 10); }
function serializePlan<T extends { weekStartDate: Date; meals: Array<{ mealDate: Date }> }>(plan: T) {
  return { ...plan, weekStartDate: dateOnly(plan.weekStartDate), meals: plan.meals.map(m => ({ ...m, mealDate: dateOnly(m.mealDate) })) };
}

async function assertPlan(householdId: string, planId: string) {
  const plan = await db.mealPlan.findFirst({ where: { id: planId, householdId } });
  if (!plan) throw errors.notFound();
  return plan;
}

export async function mealPlanningRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/meal-plans/week", async request => {
    const { householdId } = householdParams.parse(request.params);
    const { weekStartDate } = weekQuery.parse(request.query);
    await requireHousehold(request, householdId);
    const plan = await db.mealPlan.findUnique({
      where: { householdId_weekStartDate: { householdId, weekStartDate: asDate(weekStartDate) } },
      include: planInclude
    });
    return plan ? serializePlan(plan) : null;
  });

  app.post("/api/v1/households/:householdId/meal-plans", async (request, reply) => {
    const { householdId } = householdParams.parse(request.params);
    const input = createPlanInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    const plan = await db.$transaction(async tx => {
      const row = await tx.mealPlan.upsert({
        where: { householdId_weekStartDate: { householdId, weekStartDate: asDate(input.weekStartDate) } },
        update: {},
        create: { householdId, weekStartDate: asDate(input.weekStartDate), status: "DRAFT", generatedBy: "MANUAL" },
        include: planInclude
      });
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "meal.plan.created", resourceType: "MealPlan", resourceId: row.id, result: "success", correlationId: request.correlationId, metadata: { weekStartDate: input.weekStartDate } } });
      await tx.outboxMessage.create({ data: { topic: "meal-events", messageType: "meal.plan.created", aggregateType: "MealPlan", aggregateId: row.id, correlationId: request.correlationId, payload: { householdId, mealPlanId: row.id, weekStartDate: input.weekStartDate } } });
      return row;
    });
    return reply.code(201).send(serializePlan(plan));
  });

  app.post("/api/v1/households/:householdId/meal-plans/:planId/meals", async (request, reply) => {
    const { householdId, planId } = planParams.parse(request.params);
    const input = createMealInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    await assertPlan(householdId, planId);
    const row = await db.$transaction(async tx => {
      const created = await tx.plannedMeal.create({ data: { mealPlanId: planId, mealDate: asDate(input.mealDate), mealType: input.mealType, displayName: input.displayName, notes: input.notes ?? null, servings: input.servings, preparationMinutes: 0, budgetFriendly: true }, select: mealSelect });
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "meal.entry.created", resourceType: "PlannedMeal", resourceId: created.id, result: "success", correlationId: request.correlationId, metadata: { planId, version: created.version } } });
      await tx.outboxMessage.create({ data: { topic: "meal-events", messageType: "meal.entry.created", aggregateType: "PlannedMeal", aggregateId: created.id, correlationId: request.correlationId, payload: { householdId, mealPlanId: planId, mealId: created.id } } });
      return created;
    });
    return reply.code(201).send({ ...row, mealDate: dateOnly(row.mealDate) });
  });

  app.patch("/api/v1/households/:householdId/meal-plans/:planId/meals/:mealId", async request => {
    const { householdId, planId, mealId } = mealParams.parse(request.params);
    const input = updateMealInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    await assertPlan(householdId, planId);
    return db.$transaction(async tx => {
      const data: Prisma.PlannedMealUpdateManyMutationInput = { version: { increment: 1 } };
      if (input.mealDate !== undefined) data.mealDate = asDate(input.mealDate);
      if (input.mealType !== undefined) data.mealType = input.mealType;
      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.servings !== undefined) data.servings = input.servings;
      const result = await tx.plannedMeal.updateMany({ where: { id: mealId, mealPlanId: planId, version: input.version }, data });
      if (result.count !== 1) throw errors.conflict();
      const updated = await tx.plannedMeal.findUniqueOrThrow({ where: { id: mealId }, select: mealSelect });
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "meal.entry.updated", resourceType: "PlannedMeal", resourceId: mealId, result: "success", correlationId: request.correlationId, metadata: { planId, version: updated.version } } });
      await tx.outboxMessage.create({ data: { topic: "meal-events", messageType: "meal.entry.updated", aggregateType: "PlannedMeal", aggregateId: mealId, correlationId: request.correlationId, payload: { householdId, mealPlanId: planId, mealId } } });
      return { ...updated, mealDate: dateOnly(updated.mealDate) };
    });
  });

  app.delete("/api/v1/households/:householdId/meal-plans/:planId/meals/:mealId", async (request, reply) => {
    const { householdId, planId, mealId } = mealParams.parse(request.params);
    const { version } = deleteQuery.parse(request.query);
    await requireHousehold(request, householdId, true);
    await assertPlan(householdId, planId);
    await db.$transaction(async tx => {
      const result = await tx.plannedMeal.deleteMany({ where: { id: mealId, mealPlanId: planId, version } });
      if (result.count !== 1) throw errors.conflict();
      await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "meal.entry.deleted", resourceType: "PlannedMeal", resourceId: mealId, result: "success", correlationId: request.correlationId, metadata: { planId, version } } });
      await tx.outboxMessage.create({ data: { topic: "meal-events", messageType: "meal.entry.deleted", aggregateType: "PlannedMeal", aggregateId: mealId, correlationId: request.correlationId, payload: { householdId, mealPlanId: planId, mealId } } });
    });
    return reply.code(204).send();
  });
}
