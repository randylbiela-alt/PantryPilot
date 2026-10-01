import { mealPlanningRoutes } from "./meal-planning.js";
import { recipeRoutes } from "./recipes.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { loadConfig, type Config } from "./config.js";
import { db } from "./db.js";
import auth from "./auth.js";
import { AppError } from "./errors.js";
import { pantryRoutes } from "./pantry.js";
import { groceryRoutes } from "./grocery.js";
import { onboardingRoutes } from "./onboarding.js";
import { sessionRoutes } from "./session-routes.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}

export async function buildApp(overrides?: Partial<Config>) {
  const config = { ...loadConfig(), ...overrides };
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    },
    genReqId: request =>
      (request.headers["x-correlation-id"] as string | undefined) ?? randomUUID()
  });

  app.decorate("config", config);
  app.decorateRequest("correlationId", "");
  app.addHook("onRequest", async request => { request.correlationId = request.id; });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Correlation-ID", request.correlationId);
    return payload;
  });

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Client-Version", "X-Correlation-ID"],
    exposedHeaders: ["X-Correlation-ID"]
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(swagger, { openapi: { info: { title: "PantryPilot API", version: "1.0.0" } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", async () => app.swagger());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => { await db.$queryRaw`SELECT 1`; return { status: "ready" }; });
  app.get("/health", async () => ({ status: "ok" }));

  await app.register(auth);
  await sessionRoutes(app);

  app.get("/api/v1/auth/session", async request => ({
    user: request.authUser ? {
      id: request.authUser.id,
      email: request.authUser.primaryEmail,
      displayName: request.authUser.displayName
    } : null
  }));

  app.get("/api/v1/bootstrap", async request => {
    const userId = request.authUser!.id;
    const [profile, memberships] = await Promise.all([
      db.userProfile.findUnique({ where: { userId } }),
      db.householdMember.findMany({
        where: { userId, status: "ACTIVE" },
        include: {
          household: {
            include: {
              pantryItems: { where: { archivedAt: null }, orderBy: { name: "asc" } },
              groceryLists: {
                where: { status: "ACTIVE" },
                include: { items: { orderBy: [{ checked: "asc" }, { name: "asc" }] } },
                orderBy: { updatedAt: "desc" },
                take: 1
              },
              mealPlans: {
                where: { status: "READY" },
                include: { meals: true },
                orderBy: { weekStartDate: "desc" },
                take: 1
              }
            }
          }
        }
      })
    ]);

    const firstMembership = memberships[0];
    let activeGroceryList = firstMembership?.household.groceryLists[0] ?? null;

    if (firstMembership && !activeGroceryList) {
      activeGroceryList = await db.$transaction(async transaction => {
        const existing = await transaction.groceryList.findFirst({
          where: { householdId: firstMembership.householdId, status: "ACTIVE" },
          include: { items: { orderBy: [{ checked: "asc" }, { name: "asc" }] } },
          orderBy: { updatedAt: "desc" }
        });
        if (existing) return existing;

        const created = await transaction.groceryList.create({
          data: {
            householdId: firstMembership.householdId,
            name: "Current List",
            status: "ACTIVE",
            createdByUserId: userId
          },
          include: { items: { orderBy: [{ checked: "asc" }, { name: "asc" }] } }
        });

        await transaction.auditEvent.create({
          data: {
            actorUserId: userId,
            householdId: firstMembership.householdId,
            action: "grocery.list.auto_created",
            resourceType: "GroceryList",
            resourceId: created.id,
            result: "success",
            correlationId: request.correlationId,
            metadata: { reason: "no_active_list", version: created.version }
          }
        });
        await transaction.outboxMessage.create({
          data: {
            topic: "grocery-events",
            messageType: "grocery.list.auto_created",
            aggregateType: "GroceryList",
            aggregateId: created.id,
            correlationId: request.correlationId,
            payload: {
              householdId: firstMembership.householdId,
              groceryListId: created.id,
              reason: "no_active_list"
            }
          }
        });
        return created;
      });
    }

    return {
      user: {
        id: userId,
        email: request.authUser!.primaryEmail,
        displayName: request.authUser!.displayName
      },
      profile,
      onboardingRequired: memberships.length === 0 || !profile?.onboardingComplete,
      households: memberships.map(membership => ({
        id: membership.householdId,
        name: membership.household.name,
        role: membership.role.toLowerCase()
      })),
      activeHouseholdId: firstMembership?.householdId ?? null,
      pantry: firstMembership?.household.pantryItems ?? [],
      groceryList: activeGroceryList ?? {
        id: null,
        name: "Current List",
        status: "ACTIVE",
        version: 1,
        items: []
      },
      mealPlan: firstMembership?.household.mealPlans[0] ?? null
    };
  });

  await pantryRoutes(app);
  await groceryRoutes(app);
  await onboardingRoutes(app);
  await mealPlanningRoutes(app);
  await recipeRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
    const code = error instanceof AppError ? error.code : error instanceof ZodError ? "VALIDATION_FAILED" : "INTERNAL_ERROR";
    if (status >= 500) request.log.error({ err: error }, "request failed");
    reply.code(status).send({
      error: {
        code,
        message: status === 500 ? "An unexpected error occurred." : error instanceof Error ? error.message : "The request could not be completed.",
        correlationId: request.correlationId,
        ...(error instanceof ZodError ? { details: error.issues } : {})
      }
    });
  });
  return app;
}
