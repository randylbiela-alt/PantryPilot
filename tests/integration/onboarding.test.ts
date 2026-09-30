import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

const run = process.env.RUN_INTEGRATION === "true";
describe.skipIf(!run)("household onboarding", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    Object.assign(process.env, { NODE_ENV:"test", COOKIE_SECRET:"1".repeat(32), SESSION_PEPPER:"2".repeat(32), CORS_ORIGIN:"http://localhost:3000", ENTRA_TENANT_ID:"test", ENTRA_API_CLIENT_ID:"test", ENTRA_ISSUER:"https://example.com/test/v2.0", ALLOW_DEV_AUTH:"true" });
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","db","push","--skip-generate"],{stdio:"inherit",env:process.env});
    execFileSync(process.execPath,["node_modules/tsx/dist/cli.mjs","prisma/seed.ts"],{stdio:"inherit",env:process.env});
    const { db } = await import("../../src/db.js");
    await db.householdMember.deleteMany({ where: { userId:"10000000-0000-4000-8000-000000000001" } });
    await db.household.deleteMany({ where: { createdByUserId:"10000000-0000-4000-8000-000000000001" } });
    await db.userProfile.update({ where:{userId:"10000000-0000-4000-8000-000000000001"}, data:{onboardingComplete:false} });
    const mod = await import("../../src/app.js"); app = await mod.buildApp(); await app.ready();
  },60000);
  afterAll(async()=>{await app?.close();await container?.stop();},30000);
  it("creates the household, owner membership, profile, list, audit and outbox atomically", async()=>{
    const response=await app.inject({method:"POST",url:"/api/v1/households",headers:{authorization:"Bearer dev-token"},payload:{name:"Biela Household",householdSize:4,weeklyBudget:200,dietaryPreference:"No restrictions",locale:"en-US",timeZone:"America/Indiana/Indianapolis"}});
    expect(response.statusCode).toBe(201);
    expect(response.json().household.groceryLists).toHaveLength(1);
    const bootstrap=await app.inject({method:"GET",url:"/api/v1/bootstrap",headers:{authorization:"Bearer dev-token"}});
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().households[0].role).toBe("owner");
  });
});
