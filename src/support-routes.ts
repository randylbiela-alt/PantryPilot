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

  const releaseStatus=z.enum(["PLANNED","IN_DEVELOPMENT","READY_FOR_PREVIEW","PREVIEW_VALIDATION","BLOCKED","READY_FOR_PRODUCTION","PRODUCTION","ROLLED_BACK","ARCHIVED"]); const releaseEnvironment=z.enum(["LOCAL","PREVIEW","PRODUCTION"]); const validationResult=z.enum(["NOT_STARTED","PASS","FAIL","BLOCKED","NOT_APPLICABLE"]);
  const releaseSelect={id:true,version:true,name:true,description:true,status:true,environment:true,releaseNotes:true,validationNotes:true,backendCommit:true,frontendCommit:true,supportCommit:true,railwayUrl:true,vercelPreviewUrl:true,productionUrl:true,versionNumber:true,createdAt:true,updatedAt:true,previewDeployedAt:true,productionDeployedAt:true,validations:{orderBy:{sortOrder:"asc" as const},select:{id:true,name:true,result:true,notes:true,sortOrder:true,updatedAt:true}}} as const;
  app.get("/api/v1/support/releases",async request=>{requireSupport(request);const items=await db.supportRelease.findMany({orderBy:{updatedAt:"desc"},take:100,select:releaseSelect});return{items};});
  app.post("/api/v1/support/releases",async(request,reply)=>{requireSupport(request);const input=z.object({version:z.string().trim().min(1).max(40),name:z.string().trim().min(3).max(180),description:z.string().trim().min(3).max(10000),environment:releaseEnvironment.default("PREVIEW"),releaseNotes:z.string().trim().max(20000).nullable().optional()}).strict().parse(request.body);const actor=request.authUser!.id;const checks=["Authentication","Pantry","Shopping","Recipes","Meals","Analytics","Support Operations","Railway deployment","Vercel deployment","Browser console","Regression testing"];const item=await db.$transaction(async tx=>{const created=await tx.supportRelease.create({data:{...input,releaseNotes:input.releaseNotes??null,createdByUserId:actor,updatedByUserId:actor,validations:{create:checks.map((name,sortOrder)=>({name,sortOrder,updatedByUserId:actor}))}},select:releaseSelect});await tx.auditEvent.create({data:{actorUserId:actor,action:"support.release.created",resourceType:"SupportRelease",resourceId:created.id,result:"success",correlationId:request.correlationId,metadata:{version:created.version,status:created.status}}});return created;});return reply.code(201).send(item);});
  app.patch("/api/v1/support/releases/:releaseId",async request=>{requireSupport(request);const {releaseId}=z.object({releaseId:z.string().uuid()}).parse(request.params);const input=z.object({versionNumber:z.number().int().positive(),status:releaseStatus.optional(),environment:releaseEnvironment.optional(),releaseNotes:z.string().trim().max(20000).nullable().optional(),validationNotes:z.string().trim().max(20000).nullable().optional(),backendCommit:z.string().trim().max(120).nullable().optional(),frontendCommit:z.string().trim().max(120).nullable().optional(),supportCommit:z.string().trim().max(120).nullable().optional(),railwayUrl:z.string().url().nullable().optional(),vercelPreviewUrl:z.string().url().nullable().optional(),productionUrl:z.string().url().nullable().optional()}).strict().parse(request.body);const actor=request.authUser!.id;const {versionNumber,...changes}=input;const data={...(changes.status!==undefined?{status:changes.status}:{}),...(changes.environment!==undefined?{environment:changes.environment}:{}),...(changes.releaseNotes!==undefined?{releaseNotes:changes.releaseNotes}:{}),...(changes.validationNotes!==undefined?{validationNotes:changes.validationNotes}:{}),...(changes.backendCommit!==undefined?{backendCommit:changes.backendCommit}:{}),...(changes.frontendCommit!==undefined?{frontendCommit:changes.frontendCommit}:{}),...(changes.supportCommit!==undefined?{supportCommit:changes.supportCommit}:{}),...(changes.railwayUrl!==undefined?{railwayUrl:changes.railwayUrl}:{}),...(changes.vercelPreviewUrl!==undefined?{vercelPreviewUrl:changes.vercelPreviewUrl}:{}),...(changes.productionUrl!==undefined?{productionUrl:changes.productionUrl}:{}),updatedByUserId:actor,versionNumber:{increment:1},...(changes.status==="PREVIEW_VALIDATION"?{previewDeployedAt:new Date()}:{}),...(changes.status==="PRODUCTION"?{productionDeployedAt:new Date()}:{})};return db.$transaction(async tx=>{const changed=await tx.supportRelease.updateMany({where:{id:releaseId,versionNumber},data});if(changed.count!==1)throw errors.conflict();const item=await tx.supportRelease.findUniqueOrThrow({where:{id:releaseId},select:releaseSelect});await tx.auditEvent.create({data:{actorUserId:actor,action:"support.release.updated",resourceType:"SupportRelease",resourceId:item.id,result:"success",correlationId:request.correlationId,metadata:{version:item.version,status:item.status}}});return item;});});
  app.patch("/api/v1/support/releases/:releaseId/validations/:validationId",async request=>{requireSupport(request);const params=z.object({releaseId:z.string().uuid(),validationId:z.string().uuid()}).parse(request.params);const input=z.object({result:validationResult,notes:z.string().trim().max(5000).nullable().optional()}).strict().parse(request.body);const actor=request.authUser!.id;return db.$transaction(async tx=>{const item=await tx.supportReleaseValidation.update({where:{id:params.validationId},data:{result:input.result,...(input.notes!==undefined?{notes:input.notes}:{}),updatedByUserId:actor},select:{id:true,name:true,result:true,notes:true,sortOrder:true,updatedAt:true}});await tx.auditEvent.create({data:{actorUserId:actor,action:"support.release.validation_updated",resourceType:"SupportRelease",resourceId:params.releaseId,result:"success",correlationId:request.correlationId,metadata:{validation:item.name,result:item.result}}});return item;});});

  const rolloutStatus = z.enum(["OFF", "INTERNAL", "BETA", "PERCENTAGE", "GLOBAL"]);
  const featureFlagParams = z.object({ featureKey: z.string().trim().min(1).max(120) }).strict();
  const featureFlagInput = z.object({ version: z.number().int().positive(), rollout: rolloutStatus, previewEnabled: z.boolean(), productionEnabled: z.boolean(), percentage: z.number().int().min(0).max(100) }).strict().superRefine((input, context) => { if (input.rollout !== "PERCENTAGE" && input.percentage !== 0) context.addIssue({ code: "custom", path: ["percentage"], message: "Percentage must be zero unless the rollout strategy is PERCENTAGE." }); });
  const defaultFlags = [
    { key: "inventory-intelligence-v2", description: "Next-generation pantry and inventory intelligence." },
    { key: "smart-shopping-v2", description: "Enhanced shopping recommendations and list automation." },
    { key: "recipe-assistant-v2", description: "Expanded recipe assistance and pantry-aware guidance." },
    { key: "consumption-forecasting-v2", description: "Improved household consumption forecasting." },
    { key: "household-insights-v2", description: "Advanced household activity and inventory insights." },
  ];
  async function ensureAdministrationFlags(actorUserId: string) {
    await Promise.all(defaultFlags.map(flag => db.featureFlag.upsert({ where: { key: flag.key }, update: {}, create: { ...flag, updatedByUserId: actorUserId } })));
  }
  app.get("/api/v1/support/administration", async request => {
    requireSupport(request);
    await ensureAdministrationFlags(request.authUser!.id);
    const [flags, betaUsers, audit] = await Promise.all([
      db.featureFlag.findMany({ orderBy: { key: "asc" } }),
      db.betaEnrollment.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, user: { select: { id: true, displayName: true, primaryEmail: true, status: true } }, createdByUser: { select: { displayName: true, primaryEmail: true } } } }),
      db.auditEvent.findMany({ where: { action: { startsWith: "support.administration." } }, orderBy: { occurredAt: "desc" }, take: 100 }),
    ]);
    return { flags, betaUsers, audit };
  });
  app.patch("/api/v1/support/administration/flags/:featureKey", async request => {
    requireSupport(request);
    const { featureKey } = featureFlagParams.parse(request.params);
    const input = featureFlagInput.parse(request.body);
    const actor = request.authUser!.id;
    return db.$transaction(async tx => {
      const changed = await tx.featureFlag.updateMany({ where: { key: featureKey, version: input.version }, data: { rollout: input.rollout, previewEnabled: input.previewEnabled, productionEnabled: input.productionEnabled, percentage: input.percentage, version: { increment: 1 }, updatedByUserId: actor } });
      if (changed.count !== 1) throw errors.conflict();
      const flag = await tx.featureFlag.findUniqueOrThrow({ where: { key: featureKey } });
      await tx.auditEvent.create({ data: { actorUserId: actor, action: "support.administration.flag.updated", resourceType: "FeatureFlag", resourceId: flag.id, result: "success", correlationId: request.correlationId, metadata: { key: flag.key, rollout: flag.rollout, previewEnabled: flag.previewEnabled, productionEnabled: flag.productionEnabled, percentage: flag.percentage } } });
      return flag;
    });
  });
  app.post("/api/v1/support/administration/beta-users", async (request, reply) => {
    requireSupport(request);
    const { email } = z.object({ email: z.string().trim().email().max(320) }).strict().parse(request.body);
    const actor = request.authUser!.id;
    const user = await db.user.findFirst({ where: { primaryEmail: { equals: email, mode: "insensitive" }, status: "ACTIVE" } });
    if (!user) throw errors.notFound();
    const enrollment = await db.$transaction(async tx => {
      const created = await tx.betaEnrollment.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, createdByUserId: actor }, select: { id: true, createdAt: true, user: { select: { id: true, displayName: true, primaryEmail: true, status: true } } } });
      await tx.auditEvent.create({ data: { actorUserId: actor, action: "support.administration.beta_user.added", resourceType: "BetaEnrollment", resourceId: created.id, result: "success", correlationId: request.correlationId, metadata: { userId: user.id, email: user.primaryEmail } } });
      return created;
    });
    return reply.code(201).send(enrollment);
  });
  app.delete("/api/v1/support/administration/beta-users/:enrollmentId", async (request, reply) => {
    requireSupport(request);
    const { enrollmentId } = z.object({ enrollmentId: z.string().uuid() }).strict().parse(request.params);
    const actor = request.authUser!.id;
    await db.$transaction(async tx => {
      const enrollment = await tx.betaEnrollment.findUnique({ where: { id: enrollmentId }, include: { user: true } });
      if (!enrollment) throw errors.notFound();
      await tx.betaEnrollment.delete({ where: { id: enrollmentId } });
      await tx.auditEvent.create({ data: { actorUserId: actor, action: "support.administration.beta_user.removed", resourceType: "BetaEnrollment", resourceId: enrollmentId, result: "success", correlationId: request.correlationId, metadata: { userId: enrollment.userId, email: enrollment.user.primaryEmail } } });
    });
    return reply.code(204).send();
  });

  const recoveryParams = z.object({ userId: z.string().uuid() }).strict();
  const recoveryInput = z.object({
    mode: z.enum(["SESSIONS", "PROFILE", "ONBOARDING", "SAFE_BETA_RESET"]),
    reason: z.string().trim().min(10).max(500),
    confirmation: z.string().trim().min(1).max(320),
  }).strict();
  const requireSuperAdmin = (request: FastifyRequest) => {
    requireSupport(request);
    if (request.authUser!.applicationRole !== "SUPER_ADMIN") throw errors.forbidden();
  };
  const recoveryPreview = async (userId: string) => {
    const now = new Date();
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true, displayName: true, primaryEmail: true, status: true, applicationRole: true,
        profile: true,
        betaEnrollments: { select: { id: true, createdAt: true } },
        memberships: {
          select: {
            role: true, status: true,
            household: { select: { id: true, name: true, _count: { select: { members: true, pantryItems: true, groceryLists: true, recipes: true, mealPlans: true } } } },
          },
        },
      },
    });
    if (!user) throw errors.notFound();
    const [totalSessions, activeSessions, linkedIssues] = await Promise.all([
      db.userSession.count({ where: { userId } }),
      db.userSession.count({ where: { userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } } }),
      db.supportIssue.count({ where: { affectedUserId: userId } }),
    ]);
    return {
      user,
      impact: {
        totalSessions, activeSessions, linkedIssues,
        profileExists: Boolean(user.profile),
        onboardingComplete: user.profile?.onboardingComplete ?? false,
        betaEnrolled: user.betaEnrollments.length > 0,
        householdMemberships: user.memberships.length,
        ownedHouseholds: user.memberships.filter(item => item.role === "OWNER" && item.status === "ACTIVE").length,
        sharedHouseholds: user.memberships.filter(item => item.household._count.members > 1).length,
      },
      preserved: ["User identity", "External login identity", "Beta enrollment", "Household memberships", "Household data", "Support issues", "Feedback", "Audit history"],
      safeguards: ["No household data is deleted", "No membership is removed", "Destructive actions require SUPER_ADMIN", "Every recovery action is audited"],
    };
  };

  app.get("/api/v1/support/users/:userId/recovery-preview", async request => {
    requireSupport(request);
    const { userId } = recoveryParams.parse(request.params);
    return recoveryPreview(userId);
  });

  app.get("/api/v1/support/users/:userId/recovery-history", async request => {
    requireSupport(request);
    const { userId } = recoveryParams.parse(request.params);
    const items = await db.auditEvent.findMany({
      where: { resourceType: "UserRecovery", resourceId: userId },
      orderBy: { occurredAt: "desc" }, take: 25,
      select: { id: true, occurredAt: true, actorUserId: true, action: true, result: true, correlationId: true, metadata: true },
    });
    return { items };
  });

  app.post("/api/v1/support/users/:userId/recovery-actions", async (request, reply) => {
    requireSuperAdmin(request);
    const { userId } = recoveryParams.parse(request.params);
    const input = recoveryInput.parse(request.body);
    if (request.authUser!.id === userId) throw errors.forbidden();
    const preview = await recoveryPreview(userId);
    const targetEmail = preview.user.primaryEmail?.trim().toLowerCase();
    if (!targetEmail || input.confirmation.toLowerCase() !== targetEmail) throw errors.forbidden();
    const now = new Date();
    const result = await db.$transaction(async tx => {
      let revokedSessions = 0;
      let profileReset = false;
      let onboardingReset = false;
      if (["SESSIONS", "ONBOARDING", "SAFE_BETA_RESET"].includes(input.mode)) {
        const updated = await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
        revokedSessions = updated.count;
      }
      if (["PROFILE", "SAFE_BETA_RESET"].includes(input.mode)) {
        await tx.userProfile.upsert({
          where: { userId },
          create: { userId, householdSizeDefault: 1, weeklyBudget: null, defaultDiet: "No restrictions", onboardingComplete: false, locale: "en-US", timeZone: "America/Indiana/Indianapolis", version: 1 },
          update: { householdSizeDefault: 1, weeklyBudget: null, defaultDiet: "No restrictions", locale: "en-US", timeZone: "America/Indiana/Indianapolis", version: { increment: 1 }, ...(input.mode === "SAFE_BETA_RESET" ? { onboardingComplete: false } : {}) },
        });
        profileReset = true;
        onboardingReset = input.mode === "SAFE_BETA_RESET";
      }
      if (input.mode === "ONBOARDING") {
        await tx.userProfile.upsert({ where: { userId }, create: { userId, onboardingComplete: false }, update: { onboardingComplete: false, version: { increment: 1 } } });
        onboardingReset = true;
      }
      await tx.auditEvent.create({ data: {
        actorUserId: request.authUser!.id, action: `support.recovery.${input.mode.toLowerCase()}`,
        resourceType: "UserRecovery", resourceId: userId, result: "success", correlationId: request.correlationId,
        metadata: { targetUserId: userId, targetEmail: preview.user.primaryEmail, mode: input.mode, reason: input.reason, revokedSessions, profileReset, onboardingReset, preserved: preview.preserved },
      } });
      return { mode: input.mode, revokedSessions, profileReset, onboardingReset };
    });
    return reply.code(200).send({ recoveredAt: now, result, preview: await recoveryPreview(userId) });
  });

}
