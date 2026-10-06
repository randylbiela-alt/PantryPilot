import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { AppError, errors } from "./errors.js";

const householdParams = z.object({ householdId: z.string().uuid() }).strict();
const memberParams = householdParams.extend({ userId: z.string().uuid() }).strict();
const inviteParams = householdParams.extend({ inviteId: z.string().uuid() }).strict();
const roleInput = z.object({ role: z.enum(["OWNER", "ADMIN", "ADULT", "MEMBER", "READ_ONLY"]) }).strict();
const extendInput = z.object({ expiresInDays: z.number().int().min(1).max(30) }).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();

async function requireAdministrator(request: any, householdId: string) {
 const membership = await requireHousehold(request, householdId, true);
 if (membership.role !== "OWNER" && membership.role !== "ADMIN") throw errors.forbidden();
 return membership;
}

async function recordAdministration(request: any, input: { householdId: string; action: string; resourceType: string; resourceId: string; metadata: Prisma.InputJsonValue }) {
 await db.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId: input.householdId,
 action: input.action,
 resourceType: input.resourceType,
 resourceId: input.resourceId,
 result: "success",
 correlationId: request.correlationId,
 metadata: input.metadata
 }
 });
}

export async function collaborationRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/collaboration", async request => {
 const { householdId } = householdParams.parse(request.params);
 const current = await requireHousehold(request, householdId);
 const canManage = current.role === "OWNER" || current.role === "ADMIN";

 const [members, invites] = await Promise.all([
 db.householdMember.findMany({
 where: { householdId },
 orderBy: { role: "asc" },
 select: {
 userId: true,
 role: true,
 status: true,
 user: {
 select: {
 displayName: true,
 primaryEmail: true,
 lastLoginAt: true,
 identities: {
 orderBy: { lastUsedAt: "desc" },
 take: 1,
 select: { provider: true }
 }
 }
 }
 }
 }),
 canManage ? db.householdInvite.findMany({
 where: { householdId },
 orderBy: { createdAt: "desc" },
 select: {
 id: true,
 email: true,
 role: true,
 status: true,
 expiresAt: true,
 acceptedAt: true,
 createdAt: true,
 acceptedByUser: { select: { displayName: true, primaryEmail: true } }
 }
 }) : Promise.resolve([])
 ]);

 return {
 currentUserId: request.authUser!.id,
 currentRole: current.role,
 canManage,
 members: members.map(member => ({
 userId: member.userId,
 displayName: member.user.displayName,
 email: member.user.primaryEmail,
 role: member.role,
 status: member.status,
 joinedAt: null,
 lastLoginAt: member.user.lastLoginAt,
 provider: member.user.identities[0]?.provider ?? null
 })),
 invites: invites.map(invite => ({
 id: invite.id,
 email: invite.email,
 role: invite.role,
 status: invite.status === "PENDING" && invite.expiresAt <= new Date() ? "EXPIRED" : invite.status,
 expiresAt: invite.expiresAt,
 acceptedAt: invite.acceptedAt,
 createdAt: invite.createdAt,
 acceptedBy: invite.acceptedByUser?.displayName ?? invite.acceptedByUser?.primaryEmail ?? null
 }))
 };
 });

 app.get("/api/v1/households/:householdId/activity", async request => {
 const { householdId } = householdParams.parse(request.params);
 const { limit } = activityQuery.parse(request.query);
 await requireHousehold(request, householdId);
 const events = await db.auditEvent.findMany({
 where: { householdId, result: "success" },
 orderBy: { occurredAt: "desc" },
 take: limit,
 select: {
 id: true,
 action: true,
 resourceType: true,
 resourceId: true,
 metadata: true,
 occurredAt: true,
 actorUserId: true
 }
 });
 const actorIds = Array.from(new Set(events.map(event => event.actorUserId).filter((value): value is string => value !== null)));
 const actors = await db.user.findMany({
 where: { id: { in: actorIds } },
 select: { id: true, displayName: true, primaryEmail: true }
 });
 const actorNames = new Map(actors.map(actor => [actor.id, actor.displayName ?? actor.primaryEmail ?? "PantryPilot member"]));
 return {
 items: events.map(event => ({
 id: event.id,
 action: event.action,
 resourceType: event.resourceType,
 resourceId: event.resourceId,
 metadata: event.metadata,
 occurredAt: event.occurredAt,
 actorName: event.actorUserId ? actorNames.get(event.actorUserId) ?? "PantryPilot member" : "PantryPilot system"
 }))
 };
 });

 app.patch("/api/v1/households/:householdId/members/:userId", async request => {
 const { householdId, userId } = memberParams.parse(request.params);
 const administrator = await requireAdministrator(request, householdId);
 const input = roleInput.parse(request.body);
 const target = await db.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });
 if (!target || target.status !== "ACTIVE") throw errors.notFound();
 if (userId === request.authUser!.id) throw new AppError(409, "SELF_ROLE_CHANGE_NOT_ALLOWED", "Use another household owner to change your role.");
 if (administrator.role !== "OWNER" && (target.role === "OWNER" || input.role === "OWNER")) throw errors.forbidden();
 if (target.role === "OWNER" && input.role !== "OWNER") {
 const owners = await db.householdMember.count({ where: { householdId, role: "OWNER", status: "ACTIVE" } });
 if (owners <= 1) throw new AppError(409, "LAST_OWNER_REQUIRED", "A household must retain at least one active owner.");
 }
 const updated = await db.householdMember.update({
 where: { householdId_userId: { householdId, userId } },
 data: { role: input.role },
 select: { userId: true, role: true, status: true }
 });
 await recordAdministration(request, { householdId, action: "household.member.role_updated", resourceType: "HouseholdMember", resourceId: userId, metadata: { previousRole: target.role, role: input.role } });
 return updated;
 });

 app.delete("/api/v1/households/:householdId/members/:userId", async (request, reply) => {
 const { householdId, userId } = memberParams.parse(request.params);
 const administrator = await requireAdministrator(request, householdId);
 const target = await db.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });
 if (!target || target.status !== "ACTIVE") throw errors.notFound();
 if (userId === request.authUser!.id) throw new AppError(409, "SELF_REMOVAL_NOT_ALLOWED", "Household administrators cannot remove themselves here.");
 if (administrator.role !== "OWNER" && target.role === "OWNER") throw errors.forbidden();
 if (target.role === "OWNER") {
 const owners = await db.householdMember.count({ where: { householdId, role: "OWNER", status: "ACTIVE" } });
 if (owners <= 1) throw new AppError(409, "LAST_OWNER_REQUIRED", "A household must retain at least one active owner.");
 }
 await db.householdMember.update({ where: { householdId_userId: { householdId, userId } }, data: { status: "REMOVED" } });
 await recordAdministration(request, { householdId, action: "household.member.removed", resourceType: "HouseholdMember", resourceId: userId, metadata: { previousRole: target.role } });
 return reply.code(204).send();
 });

 app.post("/api/v1/households/:householdId/invites/:inviteId/revoke", async request => {
 const { householdId, inviteId } = inviteParams.parse(request.params);
 await requireAdministrator(request, householdId);
 const changed = await db.householdInvite.updateMany({ where: { id: inviteId, householdId, status: "PENDING" }, data: { status: "REVOKED" } });
 if (changed.count !== 1) throw errors.notFound();
 await recordAdministration(request, { householdId, action: "household.invite.revoked", resourceType: "HouseholdInvite", resourceId: inviteId, metadata: {} });
 return { id: inviteId, status: "REVOKED" };
 });

 app.post("/api/v1/households/:householdId/invites/:inviteId/extend", async request => {
 const { householdId, inviteId } = inviteParams.parse(request.params);
 await requireAdministrator(request, householdId);
 const input = extendInput.parse(request.body);
 const expiresAt = new Date(Date.now() + input.expiresInDays * 86400000);
 const changed = await db.householdInvite.updateMany({ where: { id: inviteId, householdId, status: "PENDING" }, data: { expiresAt } });
 if (changed.count !== 1) throw errors.notFound();
 await recordAdministration(request, { householdId, action: "household.invite.extended", resourceType: "HouseholdInvite", resourceId: inviteId, metadata: { expiresAt } });
 return { id: inviteId, status: "PENDING", expiresAt };
 });
}
