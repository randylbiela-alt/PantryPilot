import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

const run = process.env.RUN_INTEGRATION === "true";

describe.skipIf(!run)("grocery integration", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    Object.assign(process.env, {
      NODE_ENV: "test",
      COOKIE_SECRET: "1".repeat(32),
      SESSION_PEPPER: "2".repeat(32),
      CORS_ORIGIN: "http://localhost:3000",
      ENTRA_TENANT_ID: "test",
      ENTRA_API_CLIENT_ID: "test",
      ENTRA_ISSUER: "https://example.com/test/v2.0",
      ALLOW_DEV_AUTH: "true"
    });

    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "inherit", env: process.env });
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"], { stdio: "inherit", env: process.env });
    const module = await import("../../src/app.js");
    app = await module.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it("creates, checks, rejects stale updates and deletes an item", async () => {
    const householdId = "20000000-0000-4000-8000-000000000001";
    const headers = { authorization: "Bearer dev-token" };
    const bootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers });
    const listId = bootstrap.json().groceryList.id as string;

    let response = await app.inject({
      method: "POST",
      url: `/api/v1/households/${householdId}/grocery-lists/${listId}/items`,
      headers,
      payload: { name: "Apples" }
    });
    expect(response.statusCode).toBe(201);
    const item = response.json();

    response = await app.inject({
      method: "PATCH",
      url: `/api/v1/households/${householdId}/grocery-lists/${listId}/items/${item.id}`,
      headers,
      payload: { checked: true, version: item.version }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().checked).toBe(true);

    response = await app.inject({
      method: "PATCH",
      url: `/api/v1/households/${householdId}/grocery-lists/${listId}/items/${item.id}`,
      headers,
      payload: { name: "Green apples", version: item.version }
    });
    expect(response.statusCode).toBe(409);

    response = await app.inject({
      method: "DELETE",
      url: `/api/v1/households/${householdId}/grocery-lists/${listId}/items/${item.id}?version=2`,
      headers
    });
    expect(response.statusCode).toBe(204);
  });
});
