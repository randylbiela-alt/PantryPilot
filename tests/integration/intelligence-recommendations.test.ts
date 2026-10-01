import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { calculateRecommendations } from "../../src/intelligence.js";

describe("recipe recommendations", () => {
  it("returns a 100 percent match when pantry quantities cover the recipe", () => {
    const recommendations = calculateRecommendations(
      [
        {
          id: "10000000-0000-4000-8000-000000000001",
          name: "Chicken Tacos",
          favorite: false,
          ingredients: [
            { name: "Chicken", quantity: new Prisma.Decimal(1), unit: "lb" },
            { name: "Tortillas", quantity: new Prisma.Decimal(8), unit: "item" },
            { name: "Cheese", quantity: new Prisma.Decimal(1), unit: "bag" }
          ]
        }
      ],
      [
        { name: "Chicken", normalizedName: "chicken", quantity: new Prisma.Decimal(2), unit: "lb" },
        { name: "Tortillas", normalizedName: "tortillas", quantity: new Prisma.Decimal(8), unit: "item" },
        { name: "Cheese", normalizedName: "cheese", quantity: new Prisma.Decimal(1), unit: "bag" }
      ]
    );

    expect(recommendations[0]).toMatchObject({
      recipeName: "Chicken Tacos",
      score: 100,
      availableIngredients: 3,
      totalIngredients: 3,
      missingIngredients: []
    });
  });

  it("reports a quantity shortage as missing", () => {
    const recommendations = calculateRecommendations(
      [
        {
          id: "10000000-0000-4000-8000-000000000002",
          name: "Tacos",
          favorite: false,
          ingredients: [
            { name: "Tortillas", quantity: new Prisma.Decimal(8), unit: "item" }
          ]
        }
      ],
      [
        { name: "Tortillas", normalizedName: "tortillas", quantity: new Prisma.Decimal(4), unit: "item" }
      ]
    );

    expect(recommendations).toHaveLength(1);

const recommendation = recommendations[0]!;

expect(recommendation.score).toBe(0);
    expect(recommendation.missingIngredients[0]).toEqual({
      name: "Tortillas",
      requiredQuantity: 8,
      availableQuantity: 4,
      unit: "item"
    });
  });

  it("orders recipes by score", () => {
    const recommendations = calculateRecommendations(
      [
        {
          id: "10000000-0000-4000-8000-000000000003",
          name: "Missing Recipe",
          favorite: false,
          ingredients: [
            { name: "Pasta", quantity: new Prisma.Decimal(1), unit: "box" }
          ]
        },
        {
          id: "10000000-0000-4000-8000-000000000004",
          name: "Ready Recipe",
          favorite: false,
          ingredients: [
            { name: "Eggs", quantity: new Prisma.Decimal(2), unit: "item" }
          ]
        }
      ],
      [
        { name: "Eggs", normalizedName: "eggs", quantity: new Prisma.Decimal(6), unit: "item" }
      ]
    );

    expect(recommendations.map(value => value.recipeName)).toEqual([
      "Ready Recipe",
      "Missing Recipe"
    ]);
  });
});
