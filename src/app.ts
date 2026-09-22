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
import { hashToken } from "./security.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}

export async function buildApp(overrides?: Partial<Config>) {
  const config = {
    ...loadConfig(),
    ...overrides
  };

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie"
      ]
    },
    genReqId: request =>
      (request.headers["x-correlation-id"] as string | undefined) ??
      randomUUID()
  });

  app.decorate("config", config);
  app.decorateRequest("correlationId", "");

  app.addHook("onRequest", async request => {
    request.correlationId = request.id;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Correlation-ID", request.correlationId);
    return payload;
  });

  await app.register(cookie, {
    secret: config.COOKIE_SECRET
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: [
      "GET",
      "HEAD",
      "POST",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Client-Version",
      "X-Correlation-ID"
    ],
    exposedHeaders: ["X-Correlation-ID"]
  });

  await app.register(helmet);

  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute"
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "PantryPilot API",
        version: "1.0.0"
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  app.get("/openapi.json", async () => app.swagger());
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async () => {
    await db.$queryRaw`SELECT 1`;
    return { status: "ready" };
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(auth);

  app.get("/api/v1/auth/session", async request => ({
    user: request.authUser
      ? {
          id: request.authUser.id,
          email: request.authUser.primaryEmail,
          displayName: request.authUser.displayName
        }
      : null
  }));

  app.post("/api/v1/auth/sign-out", async (request, reply) => {
    const token =
      request.cookies["__Host-pantrypilot-session"] ??
      request.cookies["pantrypilot-session"];

    if (token) {
      await db.userSession.updateMany({
        where: {
          tokenHash: hashToken(token, config.SESSION_PEPPER)
        },
        data: {
          revokedAt: new Date()
        }
      });
    }

    reply
      .clearCookie(
        config.NODE_ENV === "production"
          ? "__Host-pantrypilot-session"
          : "pantrypilot-session",
        { path: "/" }
      )
      .code(204)
      .send();
  });

  app.get("/api/v1/bootstrap", async request => {
    const userId = request.authUser!.id;

    const [profile, memberships] = await Promise.all([
      db.userProfile.findUnique({
        where: { userId }
      }),
      db.householdMember.findMany({
        where: {
          userId,
          status: "ACTIVE"
        },
        include: {
          household: {
            include: {
              pantryItems: {
                where: { archivedAt: null },
                orderBy: { name: "asc" }
              },
              groceryLists: {
                where: { status: "ACTIVE" },
                include: {
                  items: {
                    orderBy: [
                      { checked: "asc" },
                      { name: "asc" }
                    ]
                  }
                },
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

    return {
      user: {
        id: userId,
        email: request.authUser!.primaryEmail,
        displayName: request.authUser!.displayName
      },
      profile,
      onboardingRequired:
        memberships.length === 0 ||
        !profile?.onboardingComplete,
      households: memberships.map(membership => ({
        id: membership.householdId,
        name: membership.household.name,
        role: membership.role.toLowerCase()
      })),
      activeHouseholdId: firstMembership?.householdId ?? null,
      pantry: firstMembership?.household.pantryItems ?? [],
      groceryList:
        firstMembership?.household.groceryLists[0] ?? {
          id: null,
          name: "Current List",
          status: "ACTIVE",
          version: 1,
          items: []
        },
      mealPlan:
        firstMembership?.household.mealPlans[0] ?? null
    };
  });

  await pantryRoutes(app);
  await groceryRoutes(app);
  await onboardingRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof ZodError
          ? 400
          : 500;

    const code =
      error instanceof AppError
        ? error.code
        : error instanceof ZodError
          ? "VALIDATION_FAILED"
          : "INTERNAL_ERROR";

    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
    }

    reply.code(status).send({
      error: {
        code,
        message:
          status === 500
            ? "An unexpected error occurred."
            : error instanceof Error
              ? error.message
              : "The request could not be completed.",
        correlationId: request.correlationId,
        ...(error instanceof ZodError
          ? { details: error.issues }
          : {})
      }
    });
  });

  return app;
}
