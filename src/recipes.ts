import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";

const uuid = z.string().uuid();

const ingredientInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    quantity: z.number().positive().max(100000),
    unit: z.string().trim().min(1).max(40)
  })
  .strict();

const optionalText = (maximumLength: number) =>
  z.string().trim().max(maximumLength).nullable().optional();

const recipeInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: optionalText(2000),
    instructions: optionalText(20000),
    imageUrl: z.string().trim().url().max(2000).nullable().optional(),
    source: optionalText(500),
    servings: z.number().int().min(1).max(50),
    prepMinutes: z.number().int().min(0).max(1440),
    cookMinutes: z.number().int().min(0).max(1440),
    favorite: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    ingredients: z.array(ingredientInput).min(1).max(100)
  })
  .strict();

const updateInput = recipeInput
  .extend({ version: z.number().int().min(1) })
  .strict();

const householdParams = z.object({ householdId: uuid }).strict();
const recipeParams = z
  .object({ householdId: uuid, recipeId: uuid })
  .strict();
const listQuery = z
  .object({ search: z.string().trim().max(100).optional() })
  .strict();
const deleteQuery = z
  .object({ version: z.coerce.number().int().min(1) })
  .strict();

const include = {
  ingredients: { orderBy: { sortOrder: "asc" as const } }
};

async function publish(
  tx: Prisma.TransactionClient,
  request: FastifyRequest,
  householdId: string,
  recipeId: string,
  action: string
) {
  await tx.auditEvent.create({
    data: {
      actorUserId: request.authUser!.id,
      householdId,
      action,
      resourceType: "Recipe",
      resourceId: recipeId,
      result: "success",
      correlationId: request.correlationId,
      metadata: { versioned: true }
    }
  });

  await tx.outboxMessage.create({
    data: {
      topic: "recipe-events",
      messageType: action,
      aggregateType: "Recipe",
      aggregateId: recipeId,
      correlationId: request.correlationId,
      payload: { householdId, recipeId }
    }
  });
}

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/recipes", async request => {
    const { householdId } = householdParams.parse(request.params);
    const { search } = listQuery.parse(request.query);
    await requireHousehold(request, householdId);

    return db.recipe.findMany({
      where: {
        householdId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" as const } },
                { tags: { has: search } }
              ]
            }
          : {})
      },
      include,
      orderBy: [{ favorite: "desc" }, { name: "asc" }]
    });
  });

  app.get(
    "/api/v1/households/:householdId/recipes/:recipeId",
    async request => {
      const { householdId, recipeId } = recipeParams.parse(request.params);
      await requireHousehold(request, householdId);

      const row = await db.recipe.findFirst({
        where: { id: recipeId, householdId },
        include
      });

      if (!row) throw errors.notFound();
      return row;
    }
  );

  app.post(
    "/api/v1/households/:householdId/recipes",
    async (request, reply) => {
      const { householdId } = householdParams.parse(request.params);
      const input = recipeInput.parse(request.body);
      await requireHousehold(request, householdId, true);

      const row = await db.$transaction(async tx => {
        const created = await tx.recipe.create({
          data: {
            householdId,
            name: input.name,
            description: input.description ?? null,
            instructions: input.instructions ?? null,
            imageUrl: input.imageUrl ?? null,
            source: input.source ?? null,
            servings: input.servings,
            prepMinutes: input.prepMinutes,
            cookMinutes: input.cookMinutes,
            favorite: input.favorite,
            tags: input.tags,
            ingredients: {
              create: input.ingredients.map((value, index) => ({
                ...value,
                sortOrder: index
              }))
            }
          },
          include
        });

        await publish(
          tx,
          request,
          householdId,
          created.id,
          "recipe.created"
        );
        return created;
      });

      return reply.code(201).send(row);
    }
  );

  app.patch(
    "/api/v1/households/:householdId/recipes/:recipeId",
    async request => {
      const { householdId, recipeId } = recipeParams.parse(request.params);
      const input = updateInput.parse(request.body);
      await requireHousehold(request, householdId, true);

      return db.$transaction(async tx => {
        const changed = await tx.recipe.updateMany({
          where: {
            id: recipeId,
            householdId,
            version: input.version
          },
          data: {
            name: input.name,
            description: input.description ?? null,
            instructions: input.instructions ?? null,
            imageUrl: input.imageUrl ?? null,
            source: input.source ?? null,
            servings: input.servings,
            prepMinutes: input.prepMinutes,
            cookMinutes: input.cookMinutes,
            favorite: input.favorite,
            tags: input.tags,
            version: { increment: 1 }
          }
        });

        if (changed.count !== 1) throw errors.conflict();

        await tx.recipeIngredient.deleteMany({ where: { recipeId } });
        await tx.recipeIngredient.createMany({
          data: input.ingredients.map((value, index) => ({
            recipeId,
            ...value,
            sortOrder: index
          }))
        });

        await publish(
          tx,
          request,
          householdId,
          recipeId,
          "recipe.updated"
        );

        return tx.recipe.findUniqueOrThrow({
          where: { id: recipeId },
          include
        });
      });
    }
  );

  app.delete(
    "/api/v1/households/:householdId/recipes/:recipeId",
    async (request, reply) => {
      const { householdId, recipeId } = recipeParams.parse(request.params);
      const { version } = deleteQuery.parse(request.query);
      await requireHousehold(request, householdId, true);

      await db.$transaction(async tx => {
        const deleted = await tx.recipe.deleteMany({
          where: { id: recipeId, householdId, version }
        });

        if (deleted.count !== 1) throw errors.conflict();
        await publish(
          tx,
          request,
          householdId,
          recipeId,
          "recipe.deleted"
        );
      });

      return reply.code(204).send();
    }
  );
}
