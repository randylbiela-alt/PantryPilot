import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Config } from "./config.js";
import { hashToken } from "./security.js";

export function sessionCookieName(
  config: Config
): string {
  return config.NODE_ENV === "production"
    ? "__Host-pantrypilot-session"
    : "pantrypilot-session";
}

export function newSessionToken(): string {
  return randomBytes(48).toString("base64url");
}

export function sessionCookieOptions(
  config: Config,
  absoluteExpiresAt: Date
) {
  const crossSite =
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(process.env.RAILWAY_SERVICE_ID) ||
    Boolean(process.env.VERCEL);

  return {
    path: "/",
    httpOnly: true,

    sameSite: crossSite
      ? ("none" as const)
      : ("lax" as const),

    secure: crossSite,

    expires: absoluteExpiresAt
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  absoluteExpiresAt: Date
): void {
  reply.setCookie(
    sessionCookieName(config),
    token,
    sessionCookieOptions(
      config,
      absoluteExpiresAt
    )
  );
}

export function clearSessionCookie(
  reply: FastifyReply,
  config: Config
): void {
  const crossSite =
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(process.env.RAILWAY_SERVICE_ID) ||
    Boolean(process.env.VERCEL);

  reply.clearCookie(
    sessionCookieName(config),
    {
      path: "/",
      httpOnly: true,
      sameSite: crossSite
        ? ("none" as const)
        : ("lax" as const),
      secure: crossSite
    }
  );
}

export function tokenHash(
  token: string,
  config: Config
): string {
  return hashToken(
    token,
    config.SESSION_PEPPER
  );
}
