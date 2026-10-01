import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

const run = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;
run("automatic active grocery list", () => {
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
    const module = await import("../../src/app.js");
    app = await module.buildApp();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    const { db } = await import("../../src/db.js");
    await db.$disconnect();
    if (container) await container.stop();
  }, 30_000);

  it("creates a new active list after the previous list is completed", async () => {
    const { db } = await import("../../src/db.js");
    await db.groceryList.updateMany({
      where: { householdId, status: "ACTIVE" },
      data: { status: "COMPLETED" }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groceryList.id).toBeTruthy();
    expect(body.groceryList.status).toBe("ACTIVE");
    expect(body.groceryList.name).toBe("Current List");

    const activeCount = await db.groceryList.count({ where: { householdId, status: "ACTIVE" } });
    expect(activeCount).toBe(1);
    expect(await db.auditEvent.count({ where: { householdId, action: "grocery.list.auto_created" } })).toBe(1);
    expect(await db.outboxMessage.count({ where: { aggregateId: body.groceryList.id, messageType: "grocery.list.auto_created" } })).toBe(1);
  });

  it("does not create another list when an active list already exists", async () => {
    const { db } = await import("../../src/db.js");
    const before = await db.groceryList.count({ where: { householdId, status: "ACTIVE" } });
    const response = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers });
    expect(response.statusCode).toBe(200);
    const after = await db.groceryList.count({ where: { householdId, status: "ACTIVE" } });
    expect(after).toBe(before);
  });
});
