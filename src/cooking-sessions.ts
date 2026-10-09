import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const sessionParams = z.object({ householdId: z.string().uuid(), sessionId: z.string().uuid() }).strict();
const createInput = z.object({ recipeId: z.string().uuid(), desiredServings: z.number().positive().max(100), origin: z.enum(["AD_HOC", "PLANNED_MEAL"]).default("AD_HOC"), plannedMealId: z.string().uuid().nullable().optional() }).strict();
const updateInput = z.object({ desiredServings: z.number().positive().max(100).optional(), status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(), version: z.number().int().positive() }).strict();

const serialize = (session: any) => ({ ...session, desiredServings: Number(session.desiredServings), batchMultiplier: Number(session.batchMultiplier) });

export async function cookingSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/cooking-sessions", async request => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId);
    const sessions = await db.recipeCookingSession.findMany({ where: { householdId }, orderBy: { createdAt: "desc" }, take: 25 });
    return sessions.map(serialize);
  });

  app.post("/api/v1/households/:householdId/cooking-sessions", async request => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = createInput.parse(request.body);
    const recipe = await db.recipe.findFirst({ where: { id: input.recipeId, householdId }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } });
    if (!recipe) throw errors.notFound();
    const multiplier = new Prisma.Decimal(input.desiredServings).div(recipe.servings).toDecimalPlaces(4);
    const ingredientSnapshot = recipe.ingredients.map(item => ({ id: item.id, name: item.name, quantity: new Prisma.Decimal(item.quantity).mul(multiplier).toDecimalPlaces(3).toNumber(), unit: item.unit, sortOrder: item.sortOrder }));
    const session = await db.recipeCookingSession.create({ data: { householdId, recipeId: recipe.id, plannedMealId: input.plannedMealId ?? null, createdByUserId: request.authUser!.id, origin: input.origin, recipeVersion: recipe.version, originalServings: recipe.servings, desiredServings: input.desiredServings, batchMultiplier: multiplier, ingredientSnapshot } });
    return serialize(session);
  });

  app.patch("/api/v1/households/:householdId/cooking-sessions/:sessionId", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = updateInput.parse(request.body);
    const current = await db.recipeCookingSession.findFirst({ where: { id: sessionId, householdId, version: input.version } });
    if (!current) throw errors.conflict();
    const data: Prisma.RecipeCookingSessionUpdateInput = { version: { increment: 1 } };
    if (input.status !== undefined) data.status = input.status;
    if (input.desiredServings !== undefined) data.desiredServings = input.desiredServings;
    if (input.status === "COMPLETED") data.completedAt = new Date();
    if (input.status === "CANCELLED") data.cancelledAt = new Date();
    const session = await db.recipeCookingSession.update({ where: { id: sessionId }, data });
    return serialize(session);
  });
}
