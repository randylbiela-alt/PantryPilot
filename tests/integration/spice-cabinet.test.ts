import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("spice cabinet", () => {
  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/households/00000000-0000-0000-0000-000000000001/spice-cabinet" });
    expect(response.statusCode).toBe(401);
  });
});
