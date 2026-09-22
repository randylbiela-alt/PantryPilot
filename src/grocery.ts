import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { db } from "./db.js";
import {
  createGroceryItem,
  createGroceryList,
  groceryItemParams,
  householdParams,
  listParams,
  updateGroceryItem,
  updateGroceryList
} from "./contracts.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { normalizeName } from "./security.js";

const itemSelect = {
  id: true,
  name: true,
  checked: true,
  version: true
} satisfies Prisma.GroceryListItemSelect;

const listSelect = {
  id: true,
  name: true,
  status: true,
  version: true,
  items: {
    select: itemSelect,
    orderBy: [{ checked: "asc" }, { name: "asc" }]
  }
} satisfies Prisma.GroceryListSelect;

async function writeAuditAndOutbox(
  transaction: Prisma.TransactionClient,
  input: {
    actorUserId: string;
    householdId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    messageType: string;
    correlationId: string;
    payload: Prisma.InputJsonValue;
    metadata: Prisma.InputJsonValue;
  }
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      actorUserId: input.actorUserId,
      householdId: input.householdId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: "success",
      correlationId: input.correlationId,
      metadata: input.metadata
    }
  });

  await transaction.outboxMessage.create({
    data: {
      topic: "grocery-events",
      messageType: input.messageType,
      aggregateType: input.resourceType,
      aggregateId: input.resourceId,
      correlationId: input.correlationId,
      payload: input.payload
    }
  });
}

export async function groceryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/households/:householdId/grocery-lists", async request => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId);
    return db.groceryList.findMany({
      where: { householdId, status: { not: "ARCHIVED" } },
      select: listSelect,
      orderBy: { updatedAt: "desc" }
    });
  });

  app.post("/api/v1/households/:householdId/grocery-lists", async (request, reply) => {
    const { householdId } = householdParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = createGroceryList.parse(request.body);

    const list = await db.$transaction(async transaction => {
      const row = await transaction.groceryList.create({
        data: {
          householdId,
          name: input.name,
          createdByUserId: request.authUser!.id
        },
        select: listSelect
      });
      await writeAuditAndOutbox(transaction, {
        actorUserId: request.authUser!.id,
        householdId,
        action: "grocery.list.created",
        resourceType: "GroceryList",
        resourceId: row.id,
        messageType: "grocery.list.created",
        correlationId: request.correlationId,
        metadata: { version: row.version },
        payload: { householdId, listId: row.id }
      });
      return row;
    });

    return reply.code(201).send(list);
  });

  app.patch("/api/v1/households/:householdId/grocery-lists/:listId", async request => {
    const { householdId, listId } = listParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = updateGroceryList.parse(request.body);

    const data: Prisma.GroceryListUpdateManyMutationInput = {
      version: { increment: 1 }
    };
    if (input.name !== undefined) data.name = input.name;
    if (input.status !== undefined) data.status = input.status;

    return db.$transaction(async transaction => {
      const result = await transaction.groceryList.updateMany({
        where: { id: listId, householdId, version: input.version },
        data
      });
      if (result.count !== 1) throw errors.conflict();
      const row = await transaction.groceryList.findUniqueOrThrow({ where: { id: listId }, select: listSelect });
      await writeAuditAndOutbox(transaction, {
        actorUserId: request.authUser!.id,
        householdId,
        action: "grocery.list.updated",
        resourceType: "GroceryList",
        resourceId: listId,
        messageType: "grocery.list.updated",
        correlationId: request.correlationId,
        metadata: { version: row.version, status: row.status },
        payload: { householdId, listId }
      });
      return row;
    });
  });

  app.post("/api/v1/households/:householdId/grocery-lists/:listId/items", async (request, reply) => {
    const { householdId, listId } = listParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = createGroceryItem.parse(request.body);

    const item = await db.$transaction(async transaction => {
      const list = await transaction.groceryList.findFirst({ where: { id: listId, householdId, status: "ACTIVE" } });
      if (!list) throw errors.notFound();
      const row = await transaction.groceryListItem.create({
        data: { groceryListId: listId, name: input.name, normalizedName: normalizeName(input.name) },
        select: itemSelect
      });
      await writeAuditAndOutbox(transaction, {
        actorUserId: request.authUser!.id,
        householdId,
        action: "grocery.item.created",
        resourceType: "GroceryListItem",
        resourceId: row.id,
        messageType: "grocery.item.created",
        correlationId: request.correlationId,
        metadata: { version: row.version },
        payload: { householdId, listId, itemId: row.id }
      });
      return row;
    });

    return reply.code(201).send(item);
  });

  app.patch("/api/v1/households/:householdId/grocery-lists/:listId/items/:itemId", async request => {
    const { householdId, listId, itemId } = groceryItemParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = updateGroceryItem.parse(request.body);

    const data: Prisma.GroceryListItemUpdateManyMutationInput = { version: { increment: 1 } };
    if (input.name !== undefined) {
      data.name = input.name;
      data.normalizedName = normalizeName(input.name);
    }
    if (input.checked !== undefined) data.checked = input.checked;

    return db.$transaction(async transaction => {
      const list = await transaction.groceryList.findFirst({ where: { id: listId, householdId, status: "ACTIVE" } });
      if (!list) throw errors.notFound();
      const result = await transaction.groceryListItem.updateMany({
        where: { id: itemId, groceryListId: listId, version: input.version },
        data
      });
      if (result.count !== 1) throw errors.conflict();
      const row = await transaction.groceryListItem.findUniqueOrThrow({ where: { id: itemId }, select: itemSelect });
      await writeAuditAndOutbox(transaction, {
        actorUserId: request.authUser!.id,
        householdId,
        action: "grocery.item.updated",
        resourceType: "GroceryListItem",
        resourceId: itemId,
        messageType: "grocery.item.updated",
        correlationId: request.correlationId,
        metadata: { version: row.version, checked: row.checked },
        payload: { householdId, listId, itemId }
      });
      return row;
    });
  });

  app.delete("/api/v1/households/:householdId/grocery-lists/:listId/items/:itemId", async (request, reply) => {
    const { householdId, listId, itemId } = groceryItemParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const version = Number((request.query as { version?: string }).version);
    if (!Number.isInteger(version) || version < 1) throw errors.conflict();

    await db.$transaction(async transaction => {
      const list = await transaction.groceryList.findFirst({ where: { id: listId, householdId, status: "ACTIVE" } });
      if (!list) throw errors.notFound();
      const result = await transaction.groceryListItem.deleteMany({
        where: { id: itemId, groceryListId: listId, version }
      });
      if (result.count !== 1) throw errors.conflict();
      await writeAuditAndOutbox(transaction, {
        actorUserId: request.authUser!.id,
        householdId,
        action: "grocery.item.deleted",
        resourceType: "GroceryListItem",
        resourceId: itemId,
        messageType: "grocery.item.deleted",
        correlationId: request.correlationId,
        metadata: { version },
        payload: { householdId, listId, itemId }
      });
    });

    return reply.code(204).send();
  });
}
