import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { errors } from "./errors.js";

function requireSupport(request: FastifyRequest) {
  if (!request.authUser) throw errors.unauthorized();
  if (
    request.authUser.applicationRole !== "SUPPORT" &&
    request.authUser.applicationRole !== "SUPER_ADMIN"
  ) throw errors.forbidden();
}

const paging = z.object({
  q: z.string().trim().max(120).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
});

const explorerQuery = z.object({
  q: z.string().trim().min(1).max(120),
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function supportRoutes(app: FastifyInstance) {
  app.get("/api/v1/support/me", async request => {
    requireSupport(request);
    return {
      user: {
        id: request.authUser!.id,
        email: request.authUser!.primaryEmail,
        displayName: request.authUser!.displayName,
        role: request.authUser!.applicationRole,
      },
    };
  });

  app.get("/api/v1/support/overview", async request => {
    requireSupport(request);
    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 86400000);
    const [users, households, activeSessions, recentUsers, recentEvents] = await Promise.all([
      db.user.count(),
      db.household.count(),
      db.userSession.count({ where: { revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } } }),
      db.user.count({ where: { lastLoginAt: { gte: d7 } } }),
      db.auditEvent.findMany({
        orderBy: { occurredAt: "desc" },
        take: 12,
        select: { id: true, action: true, resourceType: true, result: true, correlationId: true, occurredAt: true, actorUserId: true, householdId: true },
      }),
    ]);
    return { checkedAt: now, metrics: { users, households, activeSessions, activeUsers7d: recentUsers, openIssues: 0 }, recentEvents };
  });

  app.get("/api/v1/support/users", async request => {
    requireSupport(request);
    const { q, take } = paging.parse(request.query);
    const users = await db.user.findMany({
      ...(q ? { where: { OR: [{ primaryEmail: { contains: q, mode: "insensitive" } }, { displayName: { contains: q, mode: "insensitive" } }] } } : {}),
      orderBy: { lastLoginAt: "desc" },
      take,
      select: { id: true, displayName: true, primaryEmail: true, status: true, applicationRole: true, createdAt: true, lastLoginAt: true, _count: { select: { sessions: true, memberships: true } } },
    });
    return { items: users };
  });

  app.get("/api/v1/support/explorer", async request => {
    requireSupport(request);
    const { q } = explorerQuery.parse(request.query);
    const user = await db.user.findFirst({
      where: {
        OR: [
          ...(uuidPattern.test(q) ? [{ id: q }] : []),
          { primaryEmail: { contains: q, mode: "insensitive" } },
          { displayName: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { lastLoginAt: "desc" },
      select: {
        id: true,
        displayName: true,
        primaryEmail: true,
        status: true,
        applicationRole: true,
        createdAt: true,
        lastLoginAt: true,
        profile: { select: { onboardingComplete: true, locale: true, timeZone: true } },
        memberships: {
          orderBy: { household: { name: "asc" } },
          select: {
            role: true,
            status: true,
            household: {
              select: {
                id: true,
                name: true,
                timeZone: true,
                createdAt: true,
                members: {
                  orderBy: { user: { displayName: "asc" } },
                  select: { role: true, status: true, user: { select: { id: true, displayName: true, primaryEmail: true, status: true, lastLoginAt: true } } },
                },
                invites: {
                  orderBy: { createdAt: "desc" },
                  select: { id: true, email: true, role: true, status: true, createdAt: true, expiresAt: true, acceptedAt: true },
                },
                _count: { select: { pantryItems: true, groceryLists: true, recipes: true, mealPlans: true, members: true, invites: true } },
              },
            },
          },
        },
      },
    });

    if (!user) return { user: null, sessions: { total: 0, active: 0 }, households: [], invitationsForEmail: [] };

    const now = new Date();
    const householdIds = user.memberships.map(item => item.household.id);
    const [totalSessions, activeSessions, shoppingCounts, mealCounts, invitationsForEmail] = await Promise.all([
      db.userSession.count({ where: { userId: user.id } }),
      db.userSession.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } } }),
      Promise.all(householdIds.map(householdId => db.groceryListItem.count({ where: { groceryList: { householdId } } }))),
      Promise.all(householdIds.map(householdId => db.plannedMeal.count({ where: { mealPlan: { householdId } } }))),
      user.primaryEmail
        ? db.householdInvite.findMany({
            where: { normalizedEmail: user.primaryEmail.trim().toLowerCase() },
            orderBy: { createdAt: "desc" },
            select: { id: true, householdId: true, email: true, role: true, status: true, createdAt: true, expiresAt: true, acceptedAt: true, household: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    const households = user.memberships.map((membership, index) => ({
      id: membership.household.id,
      name: membership.household.name,
      timeZone: membership.household.timeZone,
      createdAt: membership.household.createdAt,
      role: membership.role,
      membershipStatus: membership.status,
      members: membership.household.members,
      invitations: membership.household.invites,
      counts: {
        pantryItems: membership.household._count.pantryItems,
        shoppingItems: shoppingCounts[index] ?? 0,
        groceryLists: membership.household._count.groceryLists,
        recipes: membership.household._count.recipes,
        mealPlans: membership.household._count.mealPlans,
        plannedMeals: mealCounts[index] ?? 0,
        members: membership.household._count.members,
        invitations: membership.household._count.invites,
      },
    }));

    const { memberships: _memberships, ...userDetails } = user;
    return { user: userDetails, sessions: { total: totalSessions, active: activeSessions }, households, invitationsForEmail };
  });

  app.get("/api/v1/support/sessions", async request => {
    requireSupport(request);
    const { take } = paging.parse(request.query);
    const now = new Date();
    const items = await db.userSession.findMany({
      orderBy: { lastSeenAt: "desc" }, take,
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, absoluteExpiresAt: true, revokedAt: true, user: { select: { id: true, displayName: true, primaryEmail: true } } },
    });
    return { items: items.map(x => ({ ...x, status: x.revokedAt ? "REVOKED" : x.expiresAt <= now || x.absoluteExpiresAt <= now ? "EXPIRED" : "ACTIVE" })) };
  });

  app.post("/api/v1/support/sessions/:sessionId/revoke", async request => {
    requireSupport(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const target = await db.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await db.auditEvent.create({ data: { actorUserId: request.authUser!.id, action: "support.session.revoke", resourceType: "UserSession", resourceId: sessionId, result: "SUCCESS", correlationId: request.correlationId, metadata: { targetUserId: target.userId } } });
    return { revoked: true };
  });

  app.get("/api/v1/support/activity", async request => {
    requireSupport(request);
    const { q, take } = paging.parse(request.query);
    const items = await db.auditEvent.findMany({
      ...(q ? { where: { OR: [{ correlationId: { contains: q, mode: "insensitive" } }, { action: { contains: q, mode: "insensitive" } }] } } : {}),
      orderBy: { occurredAt: "desc" }, take,
      select: { id: true, action: true, resourceType: true, resourceId: true, result: true, correlationId: true, occurredAt: true, actorUserId: true, householdId: true, metadata: true },
    });
    return { items };
  });
}
