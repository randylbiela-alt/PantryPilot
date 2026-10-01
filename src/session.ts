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
  const production =
    config.NODE_ENV === "production";

  return {
    path: "/",
    httpOnly: true,

    // Cross-site cookies for Vercel -> Railway
    sameSite: production
      ? ("none" as const)
      : ("lax" as const),

    secure: production,

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
  const production =
    config.NODE_ENV === "production";

  reply.clearCookie(
    sessionCookieName(config),
    {
      path: "/",
      httpOnly: true,
      sameSite: production
        ? ("none" as const)
        : ("lax" as const),
      secure: production
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
