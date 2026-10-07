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
  const issueStatus = z.enum(["OPEN","IN_PROGRESS","WAITING_FOR_USER","READY_FOR_VALIDATION","RESOLVED","CLOSED","DUPLICATE"]);
  const issuePriority = z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]);
  const issueCategory = z.enum(["AUTHENTICATION","HOUSEHOLD_ACCESS","PANTRY_DATA","SHOPPING","RECIPES","MEALS","IMPORT","ANALYTICS","PERFORMANCE","DISPLAY","DATA","OTHER"]);
  const issueSelect = { id:true,issueNumber:true,title:true,description:true,status:true,priority:true,category:true,affectedUserId:true,affectedHouseholdId:true,assignedToUserId:true,correlationId:true,resolutionNotes:true,version:true,createdAt:true,updatedAt:true,resolvedAt:true,closedAt:true,affectedUser:{select:{id:true,displayName:true,primaryEmail:true}},affectedHousehold:{select:{id:true,name:true}},assignedToUser:{select:{id:true,displayName:true,primaryEmail:true}},createdByUser:{select:{id:true,displayName:true,primaryEmail:true}},updatedByUser:{select:{id:true,displayName:true,primaryEmail:true}},comments:{orderBy:{createdAt:"asc" as const},select:{id:true,body:true,createdAt:true,author:{select:{id:true,displayName:true,primaryEmail:true}}}} } as const;
  const issueInput = z.object({title:z.string().trim().min(3).max(180),description:z.string().trim().min(3).max(10000),priority:issuePriority.default("MEDIUM"),category:issueCategory.default("OTHER"),affectedUserId:z.string().uuid().nullable().optional(),affectedHouseholdId:z.string().uuid().nullable().optional(),assignedToUserId:z.string().uuid().nullable().optional(),correlationId:z.string().trim().max(160).nullable().optional()}).strict();
  app.get("/api/v1/support/issues",async request=>{requireSupport(request);const query=z.object({q:z.string().trim().max(120).optional(),status:issueStatus.optional(),priority:issuePriority.optional(),take:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);const where={...(query.status?{status:query.status}:{}),...(query.priority?{priority:query.priority}:{}),...(query.q?{OR:[{title:{contains:query.q,mode:"insensitive" as const}},{description:{contains:query.q,mode:"insensitive" as const}},{correlationId:{contains:query.q,mode:"insensitive" as const}}]}:{})};const [items,grouped]=await Promise.all([db.supportIssue.findMany({where,orderBy:[{priority:"desc"},{updatedAt:"desc"}],take:query.take,select:issueSelect}),db.supportIssue.groupBy({by:["status"],_count:{_all:true}})]);return{items,counts:Object.fromEntries(grouped.map(row=>[row.status,row._count._all]))};});
  app.post("/api/v1/support/issues",async(request,reply)=>{requireSupport(request);const input=issueInput.parse(request.body);const actor=request.authUser!.id;const issue=await db.$transaction(async tx=>{const created=await tx.supportIssue.create({data:{...input,affectedUserId:input.affectedUserId??null,affectedHouseholdId:input.affectedHouseholdId??null,assignedToUserId:input.assignedToUserId??null,correlationId:input.correlationId??null,createdByUserId:actor,updatedByUserId:actor},select:issueSelect});await tx.auditEvent.create({data:{actorUserId:actor,householdId:input.affectedHouseholdId??null,action:"support.issue.created",resourceType:"SupportIssue",resourceId:created.id,result:"success",correlationId:request.correlationId,metadata:{issueNumber:created.issueNumber,priority:created.priority,category:created.category}}});return created;});return reply.code(201).send(issue);});
  app.patch("/api/v1/support/issues/:issueId",async request=>{requireSupport(request);const {issueId}=z.object({issueId:z.string().uuid()}).parse(request.params);const input=z.object({version:z.number().int().positive(),title:z.string().trim().min(3).max(180).optional(),description:z.string().trim().min(3).max(10000).optional(),status:issueStatus.optional(),priority:issuePriority.optional(),category:issueCategory.optional(),affectedUserId:z.string().uuid().nullable().optional(),affectedHouseholdId:z.string().uuid().nullable().optional(),assignedToUserId:z.string().uuid().nullable().optional(),correlationId:z.string().trim().max(160).nullable().optional(),resolutionNotes:z.string().trim().max(10000).nullable().optional()}).strict().parse(request.body);const actor=request.authUser!.id;const {version,...changes}=input;const now=new Date();const updateData={...(changes.title!==undefined?{title:changes.title}:{}),...(changes.description!==undefined?{description:changes.description}:{}),...(changes.status!==undefined?{status:changes.status}:{}),...(changes.priority!==undefined?{priority:changes.priority}:{}),...(changes.category!==undefined?{category:changes.category}:{}),...(changes.affectedUserId!==undefined?{affectedUserId:changes.affectedUserId}:{}),...(changes.affectedHouseholdId!==undefined?{affectedHouseholdId:changes.affectedHouseholdId}:{}),...(changes.assignedToUserId!==undefined?{assignedToUserId:changes.assignedToUserId}:{}),...(changes.correlationId!==undefined?{correlationId:changes.correlationId}:{}),...(changes.resolutionNotes!==undefined?{resolutionNotes:changes.resolutionNotes}:{}),updatedByUserId:actor,version:{increment:1},...(changes.status==="RESOLVED"?{resolvedAt:now}:{}),...(changes.status==="CLOSED"?{closedAt:now}:{})};return db.$transaction(async tx=>{const changed=await tx.supportIssue.updateMany({where:{id:issueId,version},data:updateData});if(changed.count!==1)throw errors.conflict();const issue=await tx.supportIssue.findUniqueOrThrow({where:{id:issueId},select:issueSelect});await tx.auditEvent.create({data:{actorUserId:actor,householdId:issue.affectedHouseholdId,action:"support.issue.updated",resourceType:"SupportIssue",resourceId:issue.id,result:"success",correlationId:request.correlationId,metadata:{issueNumber:issue.issueNumber,status:issue.status,priority:issue.priority}}});return issue;});});
  app.post("/api/v1/support/issues/:issueId/comments",async(request,reply)=>{requireSupport(request);const {issueId}=z.object({issueId:z.string().uuid()}).parse(request.params);const {body}=z.object({body:z.string().trim().min(1).max(10000)}).strict().parse(request.body);const actor=request.authUser!.id;const comment=await db.$transaction(async tx=>{const created=await tx.supportIssueComment.create({data:{issueId,authorUserId:actor,body},select:{id:true,body:true,createdAt:true,author:{select:{id:true,displayName:true,primaryEmail:true}}}});await tx.supportIssue.update({where:{id:issueId},data:{updatedByUserId:actor,version:{increment:1}}});await tx.auditEvent.create({data:{actorUserId:actor,action:"support.issue.comment_added",resourceType:"SupportIssue",resourceId:issueId,result:"success",correlationId:request.correlationId,metadata:{commentId:created.id}}});return created;});return reply.code(201).send(comment);});

}
