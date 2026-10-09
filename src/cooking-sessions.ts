import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { errors } from "./errors.js";
import { normalizeName } from "./security.js";
import { canonicalSpiceName } from "./spice-recognition.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const sessionParams = z.object({ householdId: z.string().uuid(), sessionId: z.string().uuid() }).strict();
const createInput = z.object({ recipeId: z.string().uuid(), desiredServings: z.number().positive().max(100), origin: z.enum(["AD_HOC", "PLANNED_MEAL"]).default("AD_HOC"), plannedMealId: z.string().uuid().nullable().optional() }).strict();
const updateInput = z.object({ desiredServings: z.number().positive().max(100).optional(), status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(), version: z.number().int().positive() }).strict();



type SnapshotIngredient = { id?: string; name: string; quantity: number; unit: string; sortOrder?: number };
type ShoppingRequirement = { name: string; normalizedName: string; requiredQuantity: number; pantryQuantity: number; shortageQuantity: number; unit: string; kind: "INGREDIENT" | "SPICE"; alreadyInShopping: boolean };

const compatibleUnit = (left: string, right: string) => normalizeName(left) === normalizeName(right);
const displayQuantity = (value: number) => Number(value.toFixed(3));

async function scaledShoppingRequirements(householdId: string, sessionId: string): Promise<{ sessionId: string; requirements: ShoppingRequirement[] }> {
  const [session, pantry, spices, activeList] = await Promise.all([
    db.recipeCookingSession.findFirst({ where: { id: sessionId, householdId } }),
    db.pantryItem.findMany({ where: { householdId, archivedAt: null } }),
    db.spiceCabinetItem.findMany({ where: { householdId } }),
    db.groceryList.findFirst({ where: { householdId, status: "ACTIVE" }, include: { items: { where: { checked: false } } }, orderBy: { updatedAt: "desc" } })
  ]);
  if (!session) throw errors.notFound();
  const shoppingNames = new Set((activeList?.items ?? []).map(item => item.normalizedName));
  const snapshot = session.ingredientSnapshot as SnapshotIngredient[];
  const requirements: ShoppingRequirement[] = [];
  for (const ingredient of snapshot) {
    const normalized = normalizeName(ingredient.name);
    const spiceName = canonicalSpiceName(ingredient.name);
    if (spiceName) {
      const onHand = spices.some(item => normalizeName(item.name) === normalizeName(spiceName) && item.onHand);
      if (!onHand) requirements.push({ name: spiceName, normalizedName: normalizeName(spiceName), requiredQuantity: 1, pantryQuantity: 0, shortageQuantity: 1, unit: "item", kind: "SPICE", alreadyInShopping: shoppingNames.has(normalizeName(spiceName)) });
      continue;
    }
    const pantryQuantity = pantry.filter(item => item.normalizedName === normalized && compatibleUnit(item.unit, ingredient.unit)).reduce((total, item) => total + Number(item.quantity), 0);
    const shortageQuantity = Math.max(0, Number(ingredient.quantity) - pantryQuantity);
    if (shortageQuantity > 0) requirements.push({ name: ingredient.name, normalizedName: normalized, requiredQuantity: displayQuantity(Number(ingredient.quantity)), pantryQuantity: displayQuantity(pantryQuantity), shortageQuantity: displayQuantity(shortageQuantity), unit: ingredient.unit, kind: "INGREDIENT", alreadyInShopping: shoppingNames.has(normalized) });
  }
  return { sessionId, requirements };
}

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


  app.get("/api/v1/households/:householdId/cooking-sessions/:sessionId/shopping-requirements", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId);
    return scaledShoppingRequirements(householdId, sessionId);
  });

  app.post("/api/v1/households/:householdId/cooking-sessions/:sessionId/add-shopping-requirements", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const preview = await scaledShoppingRequirements(householdId, sessionId);
    const missing = preview.requirements.filter(item => !item.alreadyInShopping);
    if (missing.length === 0) return { added: 0, skipped: preview.requirements.length, requirements: preview.requirements };
    const list = await db.groceryList.findFirst({ where: { householdId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" } }) ?? await db.groceryList.create({ data: { householdId, name: "Shopping", createdByUserId: request.authUser!.id } });
    await db.groceryListItem.createMany({ data: missing.map(item => ({ groceryListId: list.id, name: item.kind === "SPICE" ? item.name : `${item.name} (${item.shortageQuantity} ${item.unit})`, normalizedName: item.normalizedName })) });
    return { added: missing.length, skipped: preview.requirements.length - missing.length, requirements: preview.requirements.map(item => ({ ...item, alreadyInShopping: true })) };
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
