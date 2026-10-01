import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
const run = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;
run("recipe meal linking", () => {
  let container: StartedPostgreSqlContainer;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
  const householdId = "20000000-0000-4000-8000-000000000001";
  const headers = { authorization: "Bearer dev-token" };
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.ALLOW_DEV_AUTH = "true";
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "inherit", env: process.env });
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"], { stdio: "inherit", env: process.env });
    app = await (await import("../../src/app.js")).buildApp();
  }, 60000);
  afterAll(async () => { if (app) await app.close(); const { db } = await import("../../src/db.js"); await db.$disconnect(); if (container) await container.stop(); }, 30000);
  it("links and replaces a recipe with optimistic concurrency", async () => {
    const recipeResponse = await app.inject({ method: "POST", url: `/api/v1/households/${householdId}/recipes`, headers, payload: { name: "Oatmeal", description: null, servings: 2, prepMinutes: 5, cookMinutes: 5, favorite: false, tags: ["breakfast"], ingredients: [{ name: "Oats", quantity: 1, unit: "cup" }] } });
    expect(recipeResponse.statusCode).toBe(201);
    const recipe = recipeResponse.json();
    const planResponse = await app.inject({ method: "POST", url: `/api/v1/households/${householdId}/meal-plans`, headers, payload: { weekStartDate: "2026-10-05" } });
    expect(planResponse.statusCode).toBe(201);
    const plan = planResponse.json();
    const mealResponse = await app.inject({ method: "POST", url: `/api/v1/households/${householdId}/meal-plans/${plan.id}/meals`, headers, payload: { mealDate: "2026-10-05", mealType: "BREAKFAST", recipeId: recipe.id } });
    expect(mealResponse.statusCode).toBe(201);
    expect(mealResponse.json().recipe.id).toBe(recipe.id);
    const stale = await app.inject({ method: "PATCH", url: `/api/v1/households/${householdId}/meal-plans/${plan.id}/meals/${mealResponse.json().id}`, headers, payload: { recipeId: recipe.id, version: 99 } });
    expect(stale.statusCode).toBe(409);
  });
});
