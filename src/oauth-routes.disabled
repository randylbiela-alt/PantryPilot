import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { ConfidentialClientApplication, CryptoProvider } from "@azure/msal-node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { IdentityProvider, type Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { newSessionToken, setSessionCookie, tokenHash } from "./session.js";
import { randomToken, hashToken } from "./security.js";
import { AppError, errors } from "./errors.js";
import { requireHousehold } from "./authorize.js";

const startQuery = z.object({ invite: z.string().min(20).max(500).optional(), returnUrl: z.string().optional() }).strict();
const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(20), error: z.string().optional(), error_description: z.string().optional() }).passthrough();
const inviteParams = z.object({ householdId: z.string().uuid() }).strict();
const inviteInput = z.object({ email: z.string().email().max(320), role: z.enum(["ADMIN","ADULT","MEMBER","READ_ONLY"]).default("MEMBER"), expiresInDays: z.number().int().min(1).max(30).default(7) }).strict();
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const safeReturnUrl = (value: string | undefined, frontend: string) => value && value.startsWith(frontend) ? value : frontend;

async function createPantrySession(app: FastifyInstance, reply: FastifyReply, userId: string): Promise<void> {
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + app.config.SESSION_ABSOLUTE_TTL_SECONDS * 1000);
  const expiresAt = new Date(Math.min(now.getTime() + app.config.SESSION_IDLE_TTL_SECONDS * 1000, absoluteExpiresAt.getTime()));
  const token = newSessionToken();
  await db.userSession.create({ data: { userId, tokenHash: tokenHash(token, app.config), expiresAt, absoluteExpiresAt, lastSeenAt: now, rotatedAt: now } });
  setSessionCookie(reply, app.config, token, absoluteExpiresAt);
}

async function consumeInvite(tx: Prisma.TransactionClient, inviteTokenHash: string | null, email: string | null, userId: string) {
  if (!inviteTokenHash) return false;
  const invite = await tx.householdInvite.findUnique({ where: { tokenHash: inviteTokenHash } });
  if (!invite || invite.status !== "PENDING" || invite.expiresAt <= new Date()) throw new AppError(403, "INVITE_INVALID", "The tester invitation is invalid or expired.");
  if (!email || invite.normalizedEmail !== normalizeEmail(email)) throw new AppError(403, "INVITE_EMAIL_MISMATCH", "Sign in with the email address that received the invitation.");
  await tx.householdMember.upsert({ where: { householdId_userId: { householdId: invite.householdId, userId } }, update: { role: invite.role, status: "ACTIVE" }, create: { householdId: invite.householdId, userId, role: invite.role, status: "ACTIVE" } });
  await tx.householdInvite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedByUserId: userId } });
  return true;
}

async function provisionIdentity(input: { provider: IdentityProvider; issuer: string; subject: string; email: string | null; emailVerified: boolean; displayName: string | null; inviteTokenHash: string | null }) {
  return db.$transaction(async tx => {
    const existingIdentity = await tx.externalIdentity.findUnique({ where: { issuer_providerSubject: { issuer: input.issuer, providerSubject: input.subject } }, include: { user: true } });
    if (existingIdentity) {
      await tx.externalIdentity.update({ where: { id: existingIdentity.id }, data: { lastUsedAt: new Date(), emailAtProvider: input.email, emailVerified: input.emailVerified } });
      await consumeInvite(tx, input.inviteTokenHash, input.email, existingIdentity.userId);
      await tx.user.update({ where: { id: existingIdentity.userId }, data: { lastLoginAt: new Date(), displayName: input.displayName ?? existingIdentity.user.displayName } });
      return existingIdentity.user;
    }
    const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
    let user = normalizedEmail ? await tx.user.findFirst({ where: { primaryEmail: { equals: normalizedEmail, mode: "insensitive" }, status: "ACTIVE" } }) : null;
    const invite = input.inviteTokenHash ? await tx.householdInvite.findUnique({ where: { tokenHash: input.inviteTokenHash } }) : null;
    if (!user && !invite && process.env.AUTH_INVITE_ONLY !== "false") throw new AppError(403, "INVITATION_REQUIRED", "A valid PantryPilot tester invitation is required.");
    if (!user) user = await tx.user.create({ data: { displayName: input.displayName, primaryEmail: normalizedEmail, lastLoginAt: new Date(), profile: { create: {} } } });
    await tx.externalIdentity.create({ data: { userId: user.id, provider: input.provider, issuer: input.issuer, providerSubject: input.subject, emailAtProvider: input.email, emailVerified: input.emailVerified, lastUsedAt: new Date() } });
    await consumeInvite(tx, input.inviteTokenHash, input.email, user.id);
    return user;
  });
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const frontend = process.env.FRONTEND_APP_URL ?? app.config.CORS_ORIGIN;
  const crypto = new CryptoProvider();
  const microsoft = () => new ConfidentialClientApplication({ auth: { clientId: process.env.MICROSOFT_CLIENT_ID ?? "", clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "", authority: process.env.MICROSOFT_AUTHORITY ?? "https://login.microsoftonline.com/common" } });

  app.get("/api/v1/auth/microsoft/start", async (request, reply) => {
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET || !process.env.MICROSOFT_CALLBACK_URL) throw new AppError(503, "MICROSOFT_LOGIN_UNAVAILABLE", "Microsoft sign-in is not configured.");
    const query = startQuery.parse(request.query); const state = randomToken(); const nonce = randomToken(); const { verifier, challenge } = await crypto.generatePkceCodes();
    await db.authFlow.create({ data: { provider: "MICROSOFT", stateHash: hashToken(state, app.config.SESSION_PEPPER), nonce, pkceVerifier: verifier, inviteTokenHash: query.invite ? hashToken(query.invite, app.config.SESSION_PEPPER) : null, returnUrl: safeReturnUrl(query.returnUrl, frontend), expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
    const url = await microsoft().getAuthCodeUrl({ redirectUri: process.env.MICROSOFT_CALLBACK_URL, scopes: ["openid","profile","email"], state, nonce, codeChallenge: challenge, codeChallengeMethod: "S256", prompt: "select_account" });
    return reply.redirect(url);
  });

  app.get("/api/v1/auth/microsoft/callback", async (request, reply) => {
    const query = callbackQuery.parse(request.query); const flow = await db.authFlow.findUnique({ where: { stateHash: hashToken(query.state, app.config.SESSION_PEPPER) } });
    if (!flow || flow.provider !== "MICROSOFT" || flow.expiresAt <= new Date()) throw new AppError(400, "AUTH_FLOW_INVALID", "The sign-in request is invalid or expired.");
    await db.authFlow.delete({ where: { id: flow.id } });
    const result = await microsoft().acquireTokenByCode({ code: query.code, redirectUri: process.env.MICROSOFT_CALLBACK_URL!, scopes: ["openid","profile","email"], codeVerifier: flow.pkceVerifier });
    const claims = result.idTokenClaims as Record<string, unknown> | undefined; const subject = typeof claims?.sub === "string" ? claims.sub : null; if (!subject) throw errors.unauthorized();
    const email = typeof claims?.email === "string" ? claims.email : typeof claims?.preferred_username === "string" ? claims.preferred_username : null;
    const user = await provisionIdentity({ provider: IdentityProvider.MICROSOFT, issuer: typeof claims?.iss === "string" ? claims.iss : (process.env.MICROSOFT_AUTHORITY ?? "microsoft"), subject, email, emailVerified: true, displayName: typeof claims?.name === "string" ? claims.name : null, inviteTokenHash: flow.inviteTokenHash });
    await createPantrySession(app, reply, user.id); return reply.redirect(flow.returnUrl);
  });

  app.get("/api/v1/auth/google/start", async (request, reply) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) throw new AppError(503, "GOOGLE_LOGIN_UNAVAILABLE", "Google sign-in is not configured.");
    const query = startQuery.parse(request.query); const state = randomToken(); const nonce = randomToken(); const verifier = randomToken(); const challenge = createHash("sha256").update(verifier).digest("base64url");
    await db.authFlow.create({ data: { provider: "GOOGLE", stateHash: hashToken(state, app.config.SESSION_PEPPER), nonce, pkceVerifier: verifier, inviteTokenHash: query.invite ? hashToken(query.invite, app.config.SESSION_PEPPER) : null, returnUrl: safeReturnUrl(query.returnUrl, frontend), expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth"); url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID); url.searchParams.set("redirect_uri", process.env.GOOGLE_CALLBACK_URL); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", "openid email profile"); url.searchParams.set("state", state); url.searchParams.set("nonce", nonce); url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256"); url.searchParams.set("prompt", "select_account"); return reply.redirect(url.toString());
  });

  app.get("/api/v1/auth/google/callback", async (request, reply) => {
    const query = callbackQuery.parse(request.query); const flow = await db.authFlow.findUnique({ where: { stateHash: hashToken(query.state, app.config.SESSION_PEPPER) } });
    if (!flow || flow.provider !== "GOOGLE" || flow.expiresAt <= new Date()) throw new AppError(400, "AUTH_FLOW_INVALID", "The sign-in request is invalid or expired."); await db.authFlow.delete({ where: { id: flow.id } });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: query.code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: process.env.GOOGLE_CALLBACK_URL!, grant_type: "authorization_code", code_verifier: flow.pkceVerifier }) });
    if (!tokenResponse.ok) throw errors.unauthorized(); const tokens = await tokenResponse.json() as { id_token?: string }; if (!tokens.id_token) throw errors.unauthorized();
    const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")); const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: ["https://accounts.google.com","accounts.google.com"], audience: process.env.GOOGLE_CLIENT_ID! }); if (payload.nonce !== flow.nonce || !payload.sub) throw errors.unauthorized();
    const user = await provisionIdentity({ provider: IdentityProvider.GOOGLE, issuer: String(payload.iss), subject: payload.sub, email: typeof payload.email === "string" ? payload.email : null, emailVerified: payload.email_verified === true, displayName: typeof payload.name === "string" ? payload.name : null, inviteTokenHash: flow.inviteTokenHash });
    await createPantrySession(app, reply, user.id); return reply.redirect(flow.returnUrl);
  });

  app.post("/api/v1/households/:householdId/invites", async (request, reply) => {
    const { householdId } = inviteParams.parse(request.params); const membership = await requireHousehold(request, householdId, true); if (membership.role !== "OWNER" && membership.role !== "ADMIN") throw errors.forbidden(); const input = inviteInput.parse(request.body); const rawToken = randomToken();
    const invite = await db.householdInvite.create({ data: { householdId, email: input.email.trim(), normalizedEmail: normalizeEmail(input.email), role: input.role, tokenHash: hashToken(rawToken, app.config.SESSION_PEPPER), invitedByUserId: request.authUser!.id, expiresAt: new Date(Date.now() + input.expiresInDays * 86400000) } });
    const inviteUrl = `${frontend}?invite=${encodeURIComponent(rawToken)}`; return reply.code(201).send({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, inviteUrl });
  });
}
