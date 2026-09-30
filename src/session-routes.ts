import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { clearSessionCookie, newSessionToken, setSessionCookie, tokenHash } from "./session.js";
import { errors } from "./errors.js";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/dev-session", async (request, reply) => {
    if (app.config.NODE_ENV === "production" || !app.config.ALLOW_DEV_AUTH) {
      throw errors.notFound();
    }

    const user = await db.user.findFirst({ where: { primaryEmail: "demo@pantrypilot.test" } });
    if (!user) throw errors.unauthorized();

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + app.config.SESSION_ABSOLUTE_TTL_SECONDS * 1000);
    const expiresAt = new Date(Math.min(
      now.getTime() + app.config.SESSION_IDLE_TTL_SECONDS * 1000,
      absoluteExpiresAt.getTime()
    ));
    const token = newSessionToken();

    await db.userSession.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token, app.config),
        expiresAt,
        absoluteExpiresAt,
        lastSeenAt: now,
        rotatedAt: now
      }
    });

    setSessionCookie(reply, app.config, token, absoluteExpiresAt);
    return reply.code(201).send({
      user: {
        id: user.id,
        email: user.primaryEmail,
        displayName: user.displayName
      }
    });
  });

  app.post("/api/v1/auth/sign-out", async (request, reply) => {
    const token = request.cookies["__Host-pantrypilot-session"] ?? request.cookies["pantrypilot-session"];
    if (token) {
      await db.userSession.updateMany({
        where: { tokenHash: tokenHash(token, app.config), revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }
    clearSessionCookie(reply, app.config);
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/sign-out-all", async (request, reply) => {
    if (!request.authUser) throw errors.unauthorized();
    await db.userSession.updateMany({
      where: { userId: request.authUser.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    clearSessionCookie(reply, app.config);
    return reply.code(204).send();
  });
}





