import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { db } from "./db.js";
import {
 createPantry,
 householdParams,
 itemParams,
 updatePantry
} from "./contracts.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { normalizeName } from "./security.js";

const pantrySelect = {
 id: true,
 name: true,
 quantity: true,
 unit: true,
 category: true,
 expirationDate: true,
 version: true
} satisfies Prisma.PantryItemSelect;

export async function pantryRoutes(app: FastifyInstance): Promise<void> {
 app.get(
 "/api/v1/households/:householdId/pantry",
 async request => {
 const { householdId } = householdParams.parse(request.params);
 await requireHousehold(request, householdId);

 return db.pantryItem.findMany({
 where: { householdId, archivedAt: null },
 select: pantrySelect,
 orderBy: { name: "asc" }
 });
 }
 );

 app.post(
 "/api/v1/households/:householdId/pantry",
 async (request, reply) => {
 const { householdId } = householdParams.parse(request.params);
 await requireHousehold(request, householdId, true);
 const input = createPantry.parse(request.body);

 const createData: Prisma.PantryItemUncheckedCreateInput = {
 householdId,
 name: input.name,
 normalizedName: normalizeName(input.name),
 quantity: input.quantity,
 unit: input.unit,
 category: input.category ?? null,
 expirationDate: input.expirationDate
 ? new Date(input.expirationDate)
 : null,
 createdByUserId: request.authUser!.id,
 updatedByUserId: request.authUser!.id
 };

 const item = await db.$transaction(async transaction => {
 const row = await transaction.pantryItem.create({
 data: createData,
 select: pantrySelect
 });
 await transaction.inventoryEvent.create({
 data: {
 householdId,
 pantryItemId: row.id,
 pantryItemName: row.name,
 type: "ADDED",
 quantityBefore: 0,
 quantityAfter: row.quantity,
 quantityDelta: row.quantity,
 unit: row.unit,
 reason: "Pantry item created",
 actorUserId: request.authUser!.id,
 correlationId: request.correlationId
 }
 });

 await transaction.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "pantry.item.created",
 resourceType: "PantryItem",
 resourceId: row.id,
 result: "success",
 correlationId: request.correlationId,
 metadata: { version: row.version }
 }
 });

 await transaction.outboxMessage.create({
 data: {
 topic: "pantry-events",
 messageType: "pantry.item.created",
 aggregateType: "PantryItem",
 aggregateId: row.id,
 correlationId: request.correlationId,
 payload: { householdId, itemId: row.id }
 }
 });

 return row;
 });

 return reply.code(201).send(item);
 }
 );

 app.patch(
 "/api/v1/households/:householdId/pantry/:itemId",
 async request => {
 const { householdId, itemId } = itemParams.parse(request.params);
 await requireHousehold(request, householdId, true);
 const input = updatePantry.parse(request.body);

 const updateData: Prisma.PantryItemUncheckedUpdateManyInput = {
 version: { increment: 1 },
 updatedByUserId: request.authUser!.id
 };

 if (input.name !== undefined) {
 updateData.name = input.name;
 updateData.normalizedName = normalizeName(input.name);
 }
 if (input.quantity !== undefined) updateData.quantity = input.quantity;
 if (input.unit !== undefined) updateData.unit = input.unit;
 if (input.category !== undefined) updateData.category = input.category;
 if (input.expirationDate !== undefined) {
 updateData.expirationDate = input.expirationDate === null
 ? null
 : new Date(input.expirationDate);
 }

 return db.$transaction(async transaction => {
 const previous = await transaction.pantryItem.findFirst({ where: { id: itemId, householdId, archivedAt: null } });
 if (!previous) throw errors.notFound();
 const result = await transaction.pantryItem.updateMany({
 where: {
 id: itemId,
 householdId,
 version: input.version,
 archivedAt: null
 },
 data: updateData
 });

 if (result.count !== 1) throw errors.conflict();

 const row = await transaction.pantryItem.findUniqueOrThrow({
 where: { id: itemId },
 select: pantrySelect
 });
 if (input.quantity !== undefined && !new Prisma.Decimal(row.quantity).equals(previous.quantity)) {
 await transaction.inventoryEvent.create({
 data: {
 householdId,
 pantryItemId: row.id,
 pantryItemName: row.name,
 type: "ADJUSTED",
 quantityBefore: previous.quantity,
 quantityAfter: row.quantity,
 quantityDelta: new Prisma.Decimal(row.quantity).minus(previous.quantity),
 unit: row.unit,
 reason: "Pantry quantity updated",
 actorUserId: request.authUser!.id,
 correlationId: request.correlationId
 }
 });
 }

 await transaction.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "pantry.item.updated",
 resourceType: "PantryItem",
 resourceId: itemId,
 result: "success",
 correlationId: request.correlationId,
 metadata: { version: row.version }
 }
 });

 await transaction.outboxMessage.create({
 data: {
 topic: "pantry-events",
 messageType: "pantry.item.updated",
 aggregateType: "PantryItem",
 aggregateId: itemId,
 correlationId: request.correlationId,
 payload: { householdId, itemId }
 }
 });

 return row;
 });
 }
 );

 app.delete(
 "/api/v1/households/:householdId/pantry/:itemId",
 async (request, reply) => {
 const { householdId, itemId } = itemParams.parse(request.params);
 await requireHousehold(request, householdId, true);

 const query = request.query as { version?: string };
 const version = Number(query.version);
 if (!Number.isInteger(version) || version < 1) throw errors.conflict();

 await db.$transaction(async transaction => {
 const previous = await transaction.pantryItem.findFirst({
  where: {
   id: itemId,
   householdId,
   archivedAt: null
  }
 });

 if (!previous) throw errors.notFound();

 const result = await transaction.pantryItem.updateMany({
 where: { id: itemId, householdId, version, archivedAt: null },
 data: {
 archivedAt: new Date(),
 version: { increment: 1 },
 updatedByUserId: request.authUser!.id
 }
 });

 if (result.count !== 1) throw errors.conflict();

 await transaction.inventoryEvent.create({
  data: {
   householdId,
   pantryItemId: previous.id,
   pantryItemName: previous.name,
   type: "ARCHIVED",
   quantityBefore: previous.quantity,
   quantityAfter: previous.quantity,
   quantityDelta: 0,
   unit: previous.unit,
   reason: "Pantry item archived",
   actorUserId: request.authUser!.id,
   correlationId: request.correlationId
  }
 });

 await transaction.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "pantry.item.deleted",
 resourceType: "PantryItem",
 resourceId: itemId,
 result: "success",
 correlationId: request.correlationId,
 metadata: { version }
 }
 });

 await transaction.outboxMessage.create({
 data: {
 topic: "pantry-events",
 messageType: "pantry.item.deleted",
 aggregateType: "PantryItem",
 aggregateId: itemId,
 correlationId: request.correlationId,
 payload: { householdId, itemId }
 }
 });
 });

 return reply.code(204).send();
 }
 );
}
