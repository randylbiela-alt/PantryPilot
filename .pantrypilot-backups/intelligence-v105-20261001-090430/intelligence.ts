import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";

const householdParams = z.object({
  householdId: z.string().uuid()
}).strict();

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

export type RecommendationIngredient = {
  name: string;
  requiredQuantity: number;
  availableQuantity: number;
  unit: string;
};

export type RecipeRecommendation = {
  recipeId: string;
  recipeName: string;
  score: number;
  availableIngredients: number;
  totalIngredients: number;
  missingIngredients: RecommendationIngredient[];
};

type PantryQuantity = {
  quantity: Prisma.Decimal;
  unit: string;
};

export function calculateRecommendations(
  recipes: Array<{
    id: string;
    name: string;
    favorite: boolean;
    ingredients: Array<{
      name: string;
      quantity: Prisma.Decimal;
      unit: string;
    }>;
  }>,
  pantryItems: Array<{
    name: string;
    normalizedName: string;
    quantity: Prisma.Decimal;
    unit: string;
  }>
): RecipeRecommendation[] {
  const pantry = new Map<string, PantryQuantity>();

  for (const item of pantryItems) {
    const normalizedName = normalize(item.normalizedName || item.name);
    const normalizedUnit = normalize(item.unit);
    const key = `${normalizedName}|${normalizedUnit}`;
    const existing = pantry.get(key);

    pantry.set(key, {
      quantity: (existing?.quantity ?? new Prisma.Decimal(0)).plus(
        item.quantity
      ),
      unit: item.unit
    });
  }

  return recipes
    .map(recipe => {
      let availableIngredients = 0;
      const missingIngredients: RecommendationIngredient[] = [];

      for (const ingredient of recipe.ingredients) {
        const key = `${normalize(ingredient.name)}|${normalize(
          ingredient.unit
        )}`;
        const available = pantry.get(key)?.quantity ?? new Prisma.Decimal(0);
        const required = new Prisma.Decimal(ingredient.quantity);

        if (available.greaterThanOrEqualTo(required)) {
          availableIngredients += 1;
        } else {
          missingIngredients.push({
            name: ingredient.name,
            requiredQuantity: required.toDecimalPlaces(3).toNumber(),
            availableQuantity: available.toDecimalPlaces(3).toNumber(),
            unit: ingredient.unit
          });
        }
      }

      const totalIngredients = recipe.ingredients.length;
      const score =
        totalIngredients === 0
          ? 0
          : Math.round((availableIngredients / totalIngredients) * 100);

      return {
        recipeId: recipe.id,
        recipeName: recipe.name,
        score,
        availableIngredients,
        totalIngredients,
        missingIngredients,
        favorite: recipe.favorite
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.favorite) - Number(left.favorite) ||
        left.recipeName.localeCompare(right.recipeName)
    )
    .map(({ favorite: _favorite, ...recommendation }) => recommendation);
}

export async function intelligenceRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get(
    "/api/v1/households/:householdId/intelligence/recommendations",
    async request => {
      const { householdId } = householdParams.parse(request.params);
      await requireHousehold(request, householdId);

      const [recipes, pantryItems] = await Promise.all([
        db.recipe.findMany({
          where: { householdId },
          include: {
            ingredients: {
              orderBy: { sortOrder: "asc" }
            }
          },
          orderBy: [{ favorite: "desc" }, { name: "asc" }]
        }),
        db.pantryItem.findMany({
          where: {
            householdId,
            archivedAt: null
          }
        })
      ]);

      const recommendations = calculateRecommendations(recipes, pantryItems);

      await db.$transaction([
        db.auditEvent.create({
          data: {
            actorUserId: request.authUser!.id,
            householdId,
            action: "intelligence.recommendation_generated",
            resourceType: "Household",
            resourceId: householdId,
            result: "success",
            correlationId: request.correlationId,
            metadata: {
              recommendationCount: recommendations.length
            }
          }
        }),
        db.outboxMessage.create({
          data: {
            topic: "intelligence-events",
            messageType: "intelligence.refresh",
            aggregateType: "Household",
            aggregateId: householdId,
            correlationId: request.correlationId,
            payload: {
              householdId,
              recommendationCount: recommendations.length
            }
          }
        })
      ]);

      return {
        recommendations
      };
    }
  );
}
