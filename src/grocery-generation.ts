import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";

const params = z.object({ householdId: z.string().uuid() }).strict();
const body = z.object({ weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const weekDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

type RequiredIngredient = {
 name: string;
 normalizedName: string;
 unit: string;
 quantity: Prisma.Decimal;
};

async function recordEvents(
 tx: Prisma.TransactionClient,
 request: FastifyRequest,
 householdId: string,
 listId: string,
 generated: number,
 existingSkipped: number
) {
 await tx.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "grocery.generation_completed",
 resourceType: "GroceryList",
 resourceId: listId,
 result: "success",
 correlationId: request.correlationId,
 metadata: { generated, existingSkipped }
 }
 });
 await tx.outboxMessage.create({
 data: {
 topic: "grocery-events",
 messageType: "grocery.generated",
 aggregateType: "GroceryList",
 aggregateId: listId,
 correlationId: request.correlationId,
 payload: { householdId, groceryListId: listId, generated, existingSkipped }
 }
 });
}

export async function groceryGenerationRoutes(app: FastifyInstance): Promise<void> {
 app.post("/api/v1/households/:householdId/grocery-generation", async request => {
 const { householdId } = params.parse(request.params);
 const { weekStartDate } = body.parse(request.body);
 await requireHousehold(request, householdId, true);

 const [plan, pantryItems] = await Promise.all([
 db.mealPlan.findUnique({
 where: { householdId_weekStartDate: { householdId, weekStartDate: weekDate(weekStartDate) } },
 include: {
 meals: {
 where: { recipeId: { not: null } },
 include: { recipe: { include: { ingredients: true } } }
 }
 }
 }),
 db.pantryItem.findMany({ where: { householdId, archivedAt: null } })
 ]);

 const required = new Map<string, RequiredIngredient>();
 for (const meal of plan?.meals ?? []) {
 for (const ingredient of meal.recipe?.ingredients ?? []) {
 const normalizedName = normalize(ingredient.name);
 const unit = normalize(ingredient.unit);
 const key = `${normalizedName}|${unit}`;
 const multiplier = new Prisma.Decimal(meal.servings).div(meal.recipe!.servings);
 const quantity = new Prisma.Decimal(ingredient.quantity).mul(multiplier);
 const current = required.get(key);
 required.set(key, current
 ? { ...current, quantity: current.quantity.plus(quantity) }
 : { name: ingredient.name, normalizedName, unit: ingredient.unit, quantity });
 }
 }

 const pantry = new Map<string, Prisma.Decimal>();
 for (const item of pantryItems) {
 const key = `${normalize(item.normalizedName || item.name)}|${normalize(item.unit)}`;
 pantry.set(key, (pantry.get(key) ?? new Prisma.Decimal(0)).plus(item.quantity));
 }

 return db.$transaction(async tx => {
 let list = await tx.groceryList.findFirst({
 where: { householdId, status: "ACTIVE" },
 include: { items: true },
 orderBy: { updatedAt: "desc" }
 });
 if (!list) {
 list = await tx.groceryList.create({
 data: { householdId, name: "Current List", status: "ACTIVE", createdByUserId: request.authUser!.id },
 include: { items: true }
 });
 }

 const existing = new Set(list.items.filter(item => !item.checked).map(item => item.normalizedName));
 const items: Array<{ id: string; name: string; quantity: number; unit: string }> = [];
 let existingSkipped = 0;

 for (const [key, ingredient] of required) {
 const shortage = ingredient.quantity.minus(pantry.get(key) ?? new Prisma.Decimal(0));
 if (!shortage.greaterThan(0)) continue;
 if (existing.has(ingredient.normalizedName)) {
 existingSkipped += 1;
 continue;
 }
 const displayQuantity = shortage.toDecimalPlaces(3).toNumber();
 const created = await tx.groceryListItem.create({
 data: {
 groceryListId: list.id,
 name: `${ingredient.name} (${displayQuantity} ${ingredient.unit})`,
 normalizedName: ingredient.normalizedName,
 checked: false
 }
 });
 existing.add(ingredient.normalizedName);
 items.push({ id: created.id, name: ingredient.name, quantity: displayQuantity, unit: ingredient.unit });
 }

 await recordEvents(tx, request, householdId, list.id, items.length, existingSkipped);
 return { groceryListId: list.id, generated: items.length, existingSkipped, items };
 });
 });
}
