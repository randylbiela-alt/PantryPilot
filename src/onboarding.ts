import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { AppError, errors } from "./errors.js";

const diet = z.enum(["No restrictions", "Vegetarian", "Vegan", "Gluten-free", "Dairy-free", "Low carb"]);
const createHouseholdSchema = z.object({
 name: z.string().trim().min(1).max(120),
 householdSize: z.number().int().min(1).max(50),
 weeklyBudget: z.number().finite().min(0).max(100000).nullable(),
 dietaryPreference: diet,
 locale: z.string().trim().min(2).max(20).default("en-US"),
 timeZone: z.string().trim().min(1).max(100)
}).strict();
const updateProfileSchema = z.object({
 householdSize: z.number().int().min(1).max(50).optional(),
 weeklyBudget: z.number().finite().min(0).max(100000).nullable().optional(),
 dietaryPreference: diet.optional(),
 locale: z.string().trim().min(2).max(20).optional(),
 timeZone: z.string().trim().min(1).max(100).optional(),
 onboardingComplete: z.boolean().optional(),
 version: z.number().int().min(1)
}).strict();
const householdParams = z.object({ householdId: z.string().uuid() });
const updateHouseholdSchema = z.object({
 name: z.string().trim().min(1).max(120).optional(),
 timeZone: z.string().trim().min(1).max(100).optional(),
 version: z.number().int().min(1)
}).strict().refine(value => value.name !== undefined || value.timeZone !== undefined, { message: "At least one editable field is required." });

async function event(tx: Prisma.TransactionClient, input: { actorUserId: string; householdId: string; action: string; resourceType: string; resourceId: string; correlationId: string; metadata: Prisma.InputJsonValue }) {
 await tx.auditEvent.create({ data: { actorUserId: input.actorUserId, householdId: input.householdId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, result: "success", correlationId: input.correlationId, metadata: input.metadata } });
 await tx.outboxMessage.create({ data: { topic: "household-events", messageType: input.action, aggregateType: input.resourceType, aggregateId: input.resourceId, correlationId: input.correlationId, payload: { householdId: input.householdId } } });
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/me/profile", async request => {
 const profile = await db.userProfile.findUnique({ where: { userId: request.authUser!.id } });
 return profile ?? { userId: request.authUser!.id, householdSizeDefault: 1, weeklyBudget: null, defaultDiet: "No restrictions", locale: "en-US", timeZone: "America/Indiana/Indianapolis", onboardingComplete: false, version: 1 };
 });

 app.patch("/api/v1/me/profile", async request => {
 const input = updateProfileSchema.parse(request.body);
 const data: Prisma.UserProfileUpdateManyMutationInput = { version: { increment: 1 } };
 if (input.householdSize !== undefined) data.householdSizeDefault = input.householdSize;
 if (input.weeklyBudget !== undefined) data.weeklyBudget = input.weeklyBudget;
 if (input.dietaryPreference !== undefined) data.defaultDiet = input.dietaryPreference;
 if (input.locale !== undefined) data.locale = input.locale;
 if (input.timeZone !== undefined) data.timeZone = input.timeZone;
 if (input.onboardingComplete !== undefined) data.onboardingComplete = input.onboardingComplete;
 const result = await db.userProfile.updateMany({ where: { userId: request.authUser!.id, version: input.version }, data });
 if (result.count !== 1) throw errors.conflict();
 return db.userProfile.findUniqueOrThrow({ where: { userId: request.authUser!.id } });
 });

 app.post("/api/v1/households", async (request, reply) => {
 const input = createHouseholdSchema.parse(request.body);
 const existing = await db.householdMember.findFirst({ where: { userId: request.authUser!.id, status: "ACTIVE" } });
 if (existing) throw new AppError(409, "HOUSEHOLD_ALREADY_EXISTS", "The user already belongs to an active household.");
 const result = await db.$transaction(async tx => {
 const profile = await tx.userProfile.upsert({
 where: { userId: request.authUser!.id },
 update: { householdSizeDefault: input.householdSize, weeklyBudget: input.weeklyBudget, defaultDiet: input.dietaryPreference, locale: input.locale, timeZone: input.timeZone, onboardingComplete: true, version: { increment: 1 } },
 create: { userId: request.authUser!.id, householdSizeDefault: input.householdSize, weeklyBudget: input.weeklyBudget, defaultDiet: input.dietaryPreference, locale: input.locale, timeZone: input.timeZone, onboardingComplete: true }
 });
 const household = await tx.household.create({ data: { name: input.name, timeZone: input.timeZone, createdByUserId: request.authUser!.id, members: { create: { userId: request.authUser!.id, role: "OWNER" } }, groceryLists: { create: { name: "Current List", createdByUserId: request.authUser!.id } } }, include: { groceryLists: { include: { items: true } } } });
 await event(tx, { actorUserId: request.authUser!.id, householdId: household.id, action: "household.created", resourceType: "Household", resourceId: household.id, correlationId: request.correlationId, metadata: { version: household.version } });
 return { household, profile };
 });
 return reply.code(201).send(result);
 });

 app.get("/api/v1/households/:householdId", async request => {
 const { householdId } = householdParams.parse(request.params);
 await requireHousehold(request, householdId);
 return db.household.findUniqueOrThrow({ where: { id: householdId }, select: { id: true, name: true, timeZone: true, version: true } });
 });

 app.patch("/api/v1/households/:householdId", async request => {
 const { householdId } = householdParams.parse(request.params);
 const membership = await requireHousehold(request, householdId, true);
 if (membership.role !== "OWNER" && membership.role !== "ADMIN") throw errors.forbidden();
 const input = updateHouseholdSchema.parse(request.body);
 const data: Prisma.HouseholdUpdateManyMutationInput = { version: { increment: 1 } };
 if (input.name !== undefined) data.name = input.name;
 if (input.timeZone !== undefined) data.timeZone = input.timeZone;
 return db.$transaction(async tx => {
 const update = await tx.household.updateMany({ where: { id: householdId, version: input.version }, data });
 if (update.count !== 1) throw errors.conflict();
 const household = await tx.household.findUniqueOrThrow({ where: { id: householdId }, select: { id: true, name: true, timeZone: true, version: true } });
 await event(tx, { actorUserId: request.authUser!.id, householdId, action: "household.updated", resourceType: "Household", resourceId: householdId, correlationId: request.correlationId, metadata: { version: household.version } });
 return household;
 });
 });
}
