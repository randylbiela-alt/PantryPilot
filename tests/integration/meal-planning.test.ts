import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

const run = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;
run("meal planning integration", () => {
  let container: StartedPostgreSqlContainer;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
  const auth = { authorization: "Bearer dev-token" };
  const householdId = "20000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.ALLOW_DEV_AUTH = "true";
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "inherit", env: process.env });
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"], { stdio: "inherit", env: process.env });
    const module = await import("../../src/app.js");
    app = await module.buildApp();
  }, 60_000);
  afterAll(async () => { if (app) await app.close(); const { db } = await import("../../src/db.js"); await db.$disconnect(); if (container) await container.stop(); }, 30_000);
  it("creates a weekly plan and versioned meal entries", async () => {
    const plan = await app.inject({ method: "POST", url: `/api/v1/households/${householdId}/meal-plans`, headers: auth, payload: { weekStartDate: "2026-09-28" } });
    expect(plan.statusCode).toBe(201);
    const planBody = plan.json();
    const created = await app.inject({ method: "POST", url: `/api/v1/households/${householdId}/meal-plans/${planBody.id}/meals`, headers: auth, payload: { mealDate: "2026-09-28", mealType: "DINNER", displayName: "Chicken tacos", servings: 4 } });
    expect(created.statusCode).toBe(201);
    const meal = created.json();
    const updated = await app.inject({ method: "PATCH", url: `/api/v1/households/${householdId}/meal-plans/${planBody.id}/meals/${meal.id}`, headers: auth, payload: { displayName: "Turkey tacos", version: 1 } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);
    const stale = await app.inject({ method: "PATCH", url: `/api/v1/households/${householdId}/meal-plans/${planBody.id}/meals/${meal.id}`, headers: auth, payload: { displayName: "Stale", version: 1 } });
    expect(stale.statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/households/${householdId}/meal-plans/${planBody.id}/meals/${meal.id}?version=2`, headers: auth });
    expect(deleted.statusCode).toBe(204);
  });
});
