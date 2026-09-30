import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

const run = process.env.RUN_INTEGRATION === "true";
describe.skipIf(!run)("secure development session", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let app: Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    Object.assign(process.env, {
      NODE_ENV:"test", COOKIE_SECRET:"1".repeat(32), SESSION_PEPPER:"2".repeat(32), CORS_ORIGIN:"http://localhost:3000",
      ENTRA_TENANT_ID:"test", ENTRA_API_CLIENT_ID:"test", ENTRA_ISSUER:"https://example.com/test/v2.0", ALLOW_DEV_AUTH:"true",
      SESSION_IDLE_TTL_SECONDS:"1800", SESSION_ABSOLUTE_TTL_SECONDS:"28800", SESSION_ROTATION_SECONDS:"900"
    });
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","db","push","--skip-generate"],{stdio:"inherit",env:process.env});
    execFileSync(process.execPath,["node_modules/tsx/dist/cli.mjs","prisma/seed.ts"],{stdio:"inherit",env:process.env});
    const mod=await import("../../src/app.js"); app=await mod.buildApp(); await app.ready();
  },60000);
  afterAll(async()=>{await app?.close();const { db }=await import("../../src/db.js");await db.$disconnect();await container?.stop();},30000);

  it("creates a hashed database session, authenticates by cookie and revokes it", async()=>{
    const created=await app.inject({method:"POST",url:"/api/v1/auth/dev-session"});
    expect(created.statusCode).toBe(201);
    const setCookie=created.headers["set-cookie"] as string;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("dev-token");
    const cookie=setCookie.split(";")[0];
    const { db } = await import("../../src/db.js");
    const session=await db.userSession.findFirstOrThrow({orderBy:{createdAt:"desc"}});
    if (!cookie) {
      throw new Error("Expected session cookie.");
    }

    const rawToken = cookie.split("=")[1] ?? "";

    expect(session.tokenHash).not.toContain(rawToken);

    const current=await app.inject({method:"GET",url:"/api/v1/auth/session",headers:{cookie}});
    expect(current.statusCode).toBe(200);
    expect(current.json().user.email).toBe("demo@pantrypilot.test");

    const signedOut=await app.inject({method:"POST",url:"/api/v1/auth/sign-out",headers:{cookie}});
    expect(signedOut.statusCode).toBe(204);
    expect((await db.userSession.findUniqueOrThrow({where:{id:session.id}})).revokedAt).not.toBeNull();
  });

  it("disables dev-session in production", async()=>{
    const original=app.config.NODE_ENV;
    Object.assign(app.config,{NODE_ENV:"production"});
    const response=await app.inject({method:"POST",url:"/api/v1/auth/dev-session"});
    expect(response.statusCode).toBe(404);
    Object.assign(app.config,{NODE_ENV:original});
  });
});


