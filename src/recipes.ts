import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const uuid = z.string().uuid();
const ingredient = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().positive().max(100000),
  unit: z.string().trim().min(1).max(40)
}).strict();
const recipeInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  servings: z.number().int().min(1).max(50),
  prepMinutes: z.number().int().min(0).max(1440),
  cookMinutes: z.number().int().min(0).max(1440),
  favorite: z.boolean(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  ingredients: z.array(ingredient).min(1).max(100)
}).strict();
const updateInput = recipeInput.extend({ version: z.number().int().min(1) }).strict();
const householdParams = z.object({ householdId: uuid }).strict();
const recipeParams = z.object({ householdId: uuid, recipeId: uuid }).strict();
const listQuery = z.object({ search: z.string().trim().max(100).optional() }).strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const include = { ingredients: { orderBy: { sortOrder: "asc" as const } } };

async function auditAndPublish(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], request: any, householdId: string, recipeId: string, action: string) {
  await tx.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action, resourceType: "Recipe", resourceId: recipeId, result: "success", correlationId: request.correlationId } });
  await tx.outboxMessage.create({ data: { topic: "recipe-events", messageType: action, aggregateType: "Recipe", aggregateId: recipeId, correlationId: request.correlationId, payload: { householdId, recipeId } } });
}

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/recipes", async request => {
    const { householdId } = householdParams.parse(request.params);
    const { search } = listQuery.parse(request.query);
    await requireHousehold(request, householdId);
    return db.recipe.findMany({
      where: { householdId, ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { tags: { has: search } }] } : {}) },
      include,
      orderBy: [{ favorite: "desc" }, { name: "asc" }]
    });
  });

  app.get("/api/v1/households/:householdId/recipes/:recipeId", async request => {
    const { householdId, recipeId } = recipeParams.parse(request.params);
    await requireHousehold(request, householdId);
    const row = await db.recipe.findFirst({ where: { id: recipeId, householdId }, include });
    if (!row) throw errors.notFound();
    return row;
  });

  app.post("/api/v1/households/:householdId/recipes", async (request, reply) => {
    const { householdId } = householdParams.parse(request.params);
    const input = recipeInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    const row = await db.$transaction(async tx => {
      const created = await tx.recipe.create({ data: {
        householdId, name: input.name, description: input.description ?? null,
        servings: input.servings, prepMinutes: input.prepMinutes, cookMinutes: input.cookMinutes,
        favorite: input.favorite, tags: input.tags,
        ingredients: { create: input.ingredients.map((x, i) => ({ ...x, sortOrder: i })) }
      }, include });
      await auditAndPublish(tx as any, request, householdId, created.id, "recipe.created");
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/v1/households/:householdId/recipes/:recipeId", async request => {
    const { householdId, recipeId } = recipeParams.parse(request.params);
    const input = updateInput.parse(request.body);
    await requireHousehold(request, householdId, true);
    return db.$transaction(async tx => {
      const changed = await tx.recipe.updateMany({ where: { id: recipeId, householdId, version: input.version }, data: {
        name: input.name, description: input.description ?? null, servings: input.servings,
        prepMinutes: input.prepMinutes, cookMinutes: input.cookMinutes, favorite: input.favorite,
        tags: input.tags, version: { increment: 1 }
      }});
      if (changed.count !== 1) throw errors.conflict();
      await tx.recipeIngredient.deleteMany({ where: { recipeId } });
      await tx.recipeIngredient.createMany({ data: input.ingredients.map((x, i) => ({ recipeId, ...x, sortOrder: i })) });
      await auditAndPublish(tx as any, request, householdId, recipeId, "recipe.updated");
      return tx.recipe.findUniqueOrThrow({ where: { id: recipeId }, include });
    });
  });

  app.delete("/api/v1/households/:householdId/recipes/:recipeId", async (request, reply) => {
    const { householdId, recipeId } = recipeParams.parse(request.params);
    const { version } = deleteQuery.parse(request.query);
    await requireHousehold(request, householdId, true);
    await db.$transaction(async tx => {
      const deleted = await tx.recipe.deleteMany({ where: { id: recipeId, householdId, version } });
      if (deleted.count !== 1) throw errors.conflict();
      await auditAndPublish(tx as any, request, householdId, recipeId, "recipe.deleted");
    });
    return reply.code(204).send();
  });
}
