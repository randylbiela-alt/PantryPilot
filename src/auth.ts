import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { IdentityProvider } from "@prisma/client";
import { db } from "./db.js";
import { errors } from "./errors.js";
import {
  newSessionToken,
  setSessionCookie,
  tokenHash
} from "./session.js";

export default fp(async function authenticationPlugin(app) {
  const config = app.config;

  const discoveryBase =
    config.ENTRA_ISSUER.replace(/\/v2\.0$/, "/");

  const jwks = createRemoteJWKSet(
    new URL(`${discoveryBase}discovery/v2.0/keys`)
  );

  app.decorateRequest("authUser", undefined);

  app.addHook("preHandler", async (request, reply) => {
    const isSessionInspection =
      request.url === "/api/v1/auth/session";

    const publicRoute =
      request.url.startsWith("/health") ||
      request.url.startsWith("/docs") ||
      request.url === "/openapi.json" ||
      request.url === "/api/v1/auth/dev-session";

    if (publicRoute) {
      return;
    }

    const rawSession =
      request.cookies["__Host-pantrypilot-session"] ??
      request.cookies["pantrypilot-session"];

    if (rawSession) {
      const now = new Date();

      const session = await db.userSession.findUnique({
        where: {
          tokenHash: tokenHash(rawSession, config)
        },
        include: {
          user: true
        }
      });

      const sessionIsValid =
        session !== null &&
        session.revokedAt === null &&
        session.expiresAt > now &&
        session.absoluteExpiresAt > now;

      if (session && sessionIsValid) {
        request.authUser = session.user;

        const idleExpiresAt = new Date(
          Math.min(
            now.getTime() +
              config.SESSION_IDLE_TTL_SECONDS * 1000,
            session.absoluteExpiresAt.getTime()
          )
        );

        const shouldRotate =
          now.getTime() - session.rotatedAt.getTime() >=
          config.SESSION_ROTATION_SECONDS * 1000;

        if (shouldRotate) {
          const replacement = newSessionToken();

          const update =
            await db.userSession.updateMany({
              where: {
                id: session.id,
                tokenHash: session.tokenHash,
                revokedAt: null
              },
              data: {
                tokenHash: tokenHash(
                  replacement,
                  config
                ),
                expiresAt: idleExpiresAt,
                lastSeenAt: now,
                rotatedAt: now
              }
            });

          if (update.count === 1) {
            setSessionCookie(
              reply,
              config,
              replacement,
              session.absoluteExpiresAt
            );
          }
        } else if (
          now.getTime() -
            session.lastSeenAt.getTime() >=
          60_000
        ) {
          await db.userSession.update({
            where: {
              id: session.id
            },
            data: {
              expiresAt: idleExpiresAt,
              lastSeenAt: now
            }
          });
        }

        return;
      }

      if (session && !session.revokedAt) {
        await db.userSession.update({
          where: {
            id: session.id
          },
          data: {
            revokedAt: now
          }
        });
      }
    }

    /*
     * The session-inspection endpoint permits anonymous access,
     * but only after attempting to resolve the session cookie.
     */
    if (isSessionInspection) {
      return;
    }

    const authorization =
      request.headers.authorization;

    if (
      config.NODE_ENV !== "production" &&
      config.ALLOW_DEV_AUTH &&
      authorization === "Bearer dev-token"
    ) {
      const developmentUser =
        await db.user.findFirst({
          where: {
            primaryEmail:
              "demo@pantrypilot.test"
          }
        });

      if (!developmentUser) {
        throw errors.unauthorized();
      }

      request.authUser = developmentUser;
      return;
    }

    if (!authorization?.startsWith("Bearer ")) {
      throw errors.unauthorized();
    }

    const { payload } = await jwtVerify(
      authorization.slice(7),
      jwks,
      {
        issuer: config.ENTRA_ISSUER,
        audience: config.ENTRA_API_CLIENT_ID
      }
    );

    if (!payload.sub) {
      throw errors.unauthorized();
    }

    const email =
      typeof payload.email === "string"
        ? payload.email
        : typeof payload.preferred_username ===
            "string"
          ? payload.preferred_username
          : null;

    const displayName =
      typeof payload.name === "string"
        ? payload.name
        : null;

    const identity =
      await db.externalIdentity.upsert({
        where: {
          issuer_providerSubject: {
            issuer: config.ENTRA_ISSUER,
            providerSubject: payload.sub
          }
        },
        update: {
          lastUsedAt: new Date()
        },
        create: {
          provider: IdentityProvider.ENTRA,
          issuer: config.ENTRA_ISSUER,
          providerSubject: payload.sub,
          emailAtProvider: email,
          user: {
            create: {
              displayName,
              primaryEmail: email,
              profile: {
                create: {}
              }
            }
          }
        },
        include: {
          user: true
        }
      });

    request.authUser = identity.user;
  });
});
