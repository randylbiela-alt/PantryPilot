import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
const run = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;
run("recipe management integration", () => {
  let container: StartedPostgreSqlContainer;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
  const householdId = "20000000-0000-4000-8000-000000000001";
  const headers = { authorization: "Bearer dev-token" };
  const input = { name: "Chicken tacos", description: "Weeknight dinner", servings: 4, prepMinutes: 15, cookMinutes: 20, favorite: true, tags: ["dinner", "quick"], ingredients: [{ name: "Chicken", quantity: 1, unit: "lb" }, { name: "Tortillas", quantity: 8, unit: "item" }] };
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.ALLOW_DEV_AUTH = "true";
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","db","push","--skip-generate"],{stdio:"inherit",env:process.env});
    execFileSync(process.execPath,["node_modules/tsx/dist/cli.mjs","prisma/seed.ts"],{stdio:"inherit",env:process.env});
    app = await (await import("../../src/app.js")).buildApp();
  },60000);
  afterAll(async()=>{if(app)await app.close();const{db}=await import("../../src/db.js");await db.$disconnect();if(container)await container.stop()},30000);
  it("creates, searches, updates with concurrency and deletes", async()=>{
    const created=await app.inject({method:"POST",url:`/api/v1/households/${householdId}/recipes`,headers,payload:input});
    expect(created.statusCode).toBe(201); const recipe=created.json(); expect(recipe.ingredients).toHaveLength(2);
    const list=await app.inject({method:"GET",url:`/api/v1/households/${householdId}/recipes?search=Chicken`,headers});
    expect(list.statusCode).toBe(200); expect(list.json()).toHaveLength(1);
    const updated=await app.inject({method:"PATCH",url:`/api/v1/households/${householdId}/recipes/${recipe.id}`,headers,payload:{...input,name:"Turkey tacos",version:1}});
    expect(updated.statusCode).toBe(200); expect(updated.json().version).toBe(2);
    const stale=await app.inject({method:"PATCH",url:`/api/v1/households/${householdId}/recipes/${recipe.id}`,headers,payload:{...input,version:1}});
    expect(stale.statusCode).toBe(409);
    const removed=await app.inject({method:"DELETE",url:`/api/v1/households/${householdId}/recipes/${recipe.id}?version=2`,headers});
    expect(removed.statusCode).toBe(204);
  });
});
