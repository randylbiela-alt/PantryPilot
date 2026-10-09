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

type DepletionAllocation = { pantryItemId: string; pantryItemName: string; quantityBefore: number; quantityUsed: number; quantityAfter: number; unit: string; version: number };
type PantryCandidate = { pantryItemId: string; name: string; quantity: number; unit: string; version: number };
type DepletionIngredient = { ingredientKey: string; name: string; requiredQuantity: number; unit: string; status: "MATCHED" | "LEARNED" | "INSUFFICIENT" | "UNMATCHED" | "SPICE"; availableQuantity: number; mappedPantryItemId: string | null; candidates: PantryCandidate[]; allocations: DepletionAllocation[] };

async function depletionPreview(householdId: string, sessionId: string): Promise<{ sessionId: string; canApply: boolean; ingredients: DepletionIngredient[] }> {
  const [session, pantry, mappings] = await Promise.all([
    db.recipeCookingSession.findFirst({ where: { id: sessionId, householdId } }),
    db.pantryItem.findMany({ where: { householdId, archivedAt: null }, orderBy: [{ expirationDate: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    db.recipeIngredientPantryMapping.findMany({ where: { householdId } })
  ]);
  if (!session) throw errors.notFound();
  const snapshot = session.ingredientSnapshot as SnapshotIngredient[];
  const ingredients: DepletionIngredient[] = snapshot.map(ingredient => {
    const ingredientKey = normalizeName(ingredient.name);
    if (canonicalSpiceName(ingredient.name)) return { ingredientKey, name: ingredient.name, requiredQuantity: Number(ingredient.quantity), unit: ingredient.unit, status: "SPICE", availableQuantity: 0, mappedPantryItemId: null, candidates: [], allocations: [] };
    const normalized = ingredientKey;
    const remembered = mappings.find(mapping => mapping.recipeId === session.recipeId && mapping.ingredientNormalizedName === normalized);
    const candidates = pantry.filter(item => compatibleUnit(item.unit, ingredient.unit)).map(item => ({ pantryItemId: item.id, name: item.name, quantity: Number(item.quantity), unit: item.unit, version: item.version }));
    const matches = remembered ? pantry.filter(item => item.id === remembered.pantryItemId && compatibleUnit(item.unit, ingredient.unit)) : pantry.filter(item => item.normalizedName === normalized && compatibleUnit(item.unit, ingredient.unit));
    let remaining = new Prisma.Decimal(ingredient.quantity);
    const allocations: DepletionAllocation[] = [];
    for (const item of matches) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const before = new Prisma.Decimal(item.quantity);
      const used = Prisma.Decimal.min(before, remaining);
      if (used.greaterThan(0)) allocations.push({ pantryItemId: item.id, pantryItemName: item.name, quantityBefore: before.toNumber(), quantityUsed: used.toNumber(), quantityAfter: before.minus(used).toNumber(), unit: item.unit, version: item.version });
      remaining = remaining.minus(used);
    }
    const availableQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantityUsed, 0);
    const status = matches.length === 0 ? "UNMATCHED" : remaining.greaterThan(0) ? "INSUFFICIENT" : remembered ? "LEARNED" : "MATCHED";
    return { ingredientKey, name: ingredient.name, requiredQuantity: Number(ingredient.quantity), unit: ingredient.unit, status, availableQuantity: displayQuantity(availableQuantity), mappedPantryItemId: remembered?.pantryItemId ?? null, candidates, allocations };
  });
  return { sessionId, canApply: ingredients.some(item => item.allocations.length > 0), ingredients };
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

  app.get("/api/v1/households/:householdId/cooking-sessions/:sessionId/depletion-preview", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId);
    return depletionPreview(householdId, sessionId);
  });

  app.post("/api/v1/households/:householdId/cooking-sessions/:sessionId/complete-with-depletion", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const input = z.object({ version: z.number().int().positive(), overrides: z.array(z.object({ ingredientKey: z.string(), action: z.enum(["USE", "SKIP", "NOT_TRACKED"]), pantryItemId: z.string().uuid().optional(), quantityUsed: z.number().nonnegative().optional(), remember: z.boolean().default(false) }).strict()).default([]) }).strict().parse(request.body);
    const basePreview = await depletionPreview(householdId, sessionId);
    const sessionForOverrides = await db.recipeCookingSession.findFirst({ where: { id: sessionId, householdId } });
    if (!sessionForOverrides) throw errors.notFound();
    const pantryForOverrides = await db.pantryItem.findMany({ where: { householdId, archivedAt: null } });
    const preview = { ...basePreview, ingredients: basePreview.ingredients.map(ingredient => { const override = input.overrides.find(item => item.ingredientKey === ingredient.ingredientKey); if (!override || override.action !== "USE" || !override.pantryItemId) return override?.action === "SKIP" || override?.action === "NOT_TRACKED" ? { ...ingredient, allocations: [], availableQuantity: 0 } : ingredient; const item = pantryForOverrides.find(candidate => candidate.id === override.pantryItemId); if (!item || !compatibleUnit(item.unit, ingredient.unit)) return ingredient; const used = Prisma.Decimal.min(new Prisma.Decimal(item.quantity), new Prisma.Decimal(override.quantityUsed ?? ingredient.requiredQuantity)); return { ...ingredient, status: "MATCHED" as const, mappedPantryItemId: item.id, availableQuantity: used.toNumber(), allocations: [{ pantryItemId: item.id, pantryItemName: item.name, quantityBefore: Number(item.quantity), quantityUsed: used.toNumber(), quantityAfter: new Prisma.Decimal(item.quantity).minus(used).toNumber(), unit: item.unit, version: item.version }] }; }) };
    const correlationId = `cooking-session:${sessionId}`;
    return db.$transaction(async tx => {
      const session = await tx.recipeCookingSession.findFirst({ where: { id: sessionId, householdId, version: input.version } });
      if (!session || session.status === "COMPLETED") throw errors.conflict();
      for (const override of input.overrides) { if (override.action === "USE" && override.pantryItemId && override.remember) await tx.recipeIngredientPantryMapping.upsert({ where: { householdId_recipeId_ingredientNormalizedName: { householdId, recipeId: session.recipeId, ingredientNormalizedName: override.ingredientKey } }, create: { householdId, recipeId: session.recipeId, ingredientNormalizedName: override.ingredientKey, pantryItemId: override.pantryItemId, confirmedByUserId: request.authUser!.id, matchMethod: "MANUAL" }, update: { pantryItemId: override.pantryItemId, confirmedByUserId: request.authUser!.id, matchMethod: "MANUAL" } }); }
      for (const ingredient of preview.ingredients) for (const allocation of ingredient.allocations) {
        const changed = await tx.pantryItem.updateMany({ where: { id: allocation.pantryItemId, householdId, version: allocation.version, archivedAt: null }, data: { quantity: allocation.quantityAfter, updatedByUserId: request.authUser!.id, version: { increment: 1 } } });
        if (changed.count !== 1) throw errors.conflict();
        await tx.inventoryEvent.create({ data: { householdId, pantryItemId: allocation.pantryItemId, pantryItemName: allocation.pantryItemName, type: "CONSUMED", quantityBefore: allocation.quantityBefore, quantityAfter: allocation.quantityAfter, quantityDelta: -allocation.quantityUsed, unit: allocation.unit, reason: `Recipe completion: ${ingredient.name}`, actorUserId: request.authUser!.id, correlationId } });
      }
      const completed = await tx.recipeCookingSession.update({ where: { id: sessionId }, data: { status: "COMPLETED", completedAt: new Date(), version: { increment: 1 } } });
      return { session: serialize(completed), depletion: preview };
    });
  });

  app.post("/api/v1/households/:householdId/cooking-sessions/:sessionId/undo-depletion", async request => {
    const { householdId, sessionId } = sessionParams.parse(request.params);
    await requireHousehold(request, householdId, true);
    const correlationId = `cooking-session:${sessionId}`;
    return db.$transaction(async tx => {
      const events = await tx.inventoryEvent.findMany({ where: { householdId, correlationId, type: "CONSUMED" }, orderBy: { occurredAt: "desc" } });
      if (events.length === 0) throw errors.notFound();
      for (const event of events) {
        const item = await tx.pantryItem.findFirst({ where: { id: event.pantryItemId, householdId, archivedAt: null } });
        if (!item) throw errors.conflict();
        const before = new Prisma.Decimal(item.quantity); const after = before.minus(event.quantityDelta);
        await tx.pantryItem.update({ where: { id: item.id }, data: { quantity: after, updatedByUserId: request.authUser!.id, version: { increment: 1 } } });
        await tx.inventoryEvent.create({ data: { householdId, pantryItemId: item.id, pantryItemName: item.name, type: "ADJUSTED", quantityBefore: before, quantityAfter: after, quantityDelta: after.minus(before), unit: item.unit, reason: `Undo recipe completion ${sessionId}`, actorUserId: request.authUser!.id, correlationId: `undo:${correlationId}` } });
      }
      return { restored: events.length };
    });
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
