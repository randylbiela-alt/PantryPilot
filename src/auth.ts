import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { IdentityProvider } from "@prisma/client";
import { db } from "./db.js";
import { errors } from "./errors.js";
import { hashToken } from "./security.js";

export default fp(async function authenticationPlugin(app) {
  const config = app.config;

  const discoveryBase = config.ENTRA_ISSUER.replace(/\/v2\.0$/, "/");
  const jwks = createRemoteJWKSet(
    new URL(`${discoveryBase}discovery/v2.0/keys`)
  );

  app.decorateRequest("authUser", undefined);

  app.addHook("preHandler", async request => {
    const publicRoute =
      request.url.startsWith("/health") ||
      request.url.startsWith("/docs") ||
      request.url === "/openapi.json";

    if (publicRoute) {
      return;
    }

    const sessionToken =
      request.cookies["__Host-pantrypilot-session"] ??
      request.cookies["pantrypilot-session"];

    if (sessionToken) {
      const session = await db.userSession.findUnique({
        where: {
          tokenHash: hashToken(
            sessionToken,
            config.SESSION_PEPPER
          )
        },
        include: {
          user: true
        }
      });

      if (
        session &&
        !session.revokedAt &&
        session.expiresAt > new Date()
      ) {
        request.authUser = session.user;
        return;
      }
    }

    const authorization = request.headers.authorization;

    if (
      config.ALLOW_DEV_AUTH &&
      authorization === "Bearer dev-token"
    ) {
      const developmentUser = await db.user.findFirst({
        where: {
          primaryEmail: "demo@pantrypilot.test"
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

    const rawToken = authorization.slice(7);

    const { payload } = await jwtVerify(rawToken, jwks, {
      issuer: config.ENTRA_ISSUER,
      audience: config.ENTRA_API_CLIENT_ID
    });

    if (!payload.sub) {
      throw errors.unauthorized();
    }

    const email =
      typeof payload.email === "string"
        ? payload.email
        : typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : null;

    const displayName =
      typeof payload.name === "string"
        ? payload.name
        : null;

    const identity = await db.externalIdentity.upsert({
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
