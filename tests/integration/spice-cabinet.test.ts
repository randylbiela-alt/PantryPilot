import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { commonSpiceSummary, normalizeSpiceName } from "../../src/spice-cabinet.js";

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("spice cabinet", () => {
  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/households/00000000-0000-0000-0000-000000000001/spice-cabinet" });
    expect(response.statusCode).toBe(401);
  });
});


describe("common spice helpers", () => {
  it("normalizes spice names consistently", () => {
    expect(normalizeSpiceName("  Garlic-Powder  ")).toBe("garlic powder");
  });

  it("reports an incomplete collection without counting duplicates", () => {
    const summary = commonSpiceSummary(["Salt", "Black Pepper", "salt"]);
    expect(summary.total).toBe(27);
    expect(summary.present).toBe(2);
    expect(summary.missing).toBe(25);
    expect(summary.complete).toBe(false);
  });
});
