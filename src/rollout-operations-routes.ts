import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { errors } from "./errors.js";
import { evaluateFeature, stableFeatureBucket, type FeatureEnvironment } from "./feature-evaluation.js";

function requireSupport(request: FastifyRequest) {
  if (!request.authUser) throw errors.unauthorized();
  if (!new Set(["SUPPORT", "SUPER_ADMIN"]).has(request.authUser.applicationRole)) throw errors.forbidden();
}
function reason(flag: any, user: any, beta: boolean, environment: FeatureEnvironment) {
  const gate = environment === "preview" ? flag.previewEnabled : flag.productionEnabled;
  if (!gate) return "ENVIRONMENT_DISABLED";
  if (flag.rollout === "OFF") return "OFF";
  if (flag.rollout === "GLOBAL") return "GLOBAL";
  if (flag.rollout === "INTERNAL") return ["SUPPORT","SUPER_ADMIN"].includes(user.applicationRole) ? "INTERNAL" : "NOT_INTERNAL";
  if (flag.rollout === "BETA") return ["SUPPORT","SUPER_ADMIN"].includes(user.applicationRole) ? "INTERNAL" : beta ? "BETA" : "NOT_BETA";
  return `PERCENTAGE_BUCKET_${stableFeatureBucket(user.id, flag.key)}`;
}
function enabled(flag:any,user:any,beta:boolean,environment:FeatureEnvironment){return evaluateFeature({featureKey:flag.key,rollout:flag.rollout,percentage:flag.percentage,previewEnabled:flag.previewEnabled,productionEnabled:flag.productionEnabled,environment,userId:user.id,applicationRole:user.applicationRole,betaEnrolled:beta});}

export async function rolloutOperationsRoutes(app: FastifyInstance) {
  app.get("/api/v1/support/rollout-operations/summary", async request => {
    requireSupport(request);
    const [flags, users, enrollments] = await Promise.all([
      db.featureFlag.findMany({ orderBy: { key: "asc" } }),
      db.user.findMany({ where: { status: "ACTIVE" }, select: { id:true, applicationRole:true } }),
      db.betaEnrollment.findMany({ select: { userId:true } }),
    ]);
    const beta = new Set(enrollments.map(x=>x.userId));
    return { items: flags.map(flag => ({ ...flag, eligibleUsers: users.length, internalUsers: users.filter(u=>u.applicationRole!=="USER").length, betaUsers: beta.size,
      previewEnabledUsers: users.filter(u=>enabled(flag,u,beta.has(u.id),"preview")).length,
      productionEnabledUsers: users.filter(u=>enabled(flag,u,beta.has(u.id),"production")).length })) };
  });
  app.get("/api/v1/support/rollout-operations/user", async request => {
    requireSupport(request);
    const { query } = z.object({ query:z.string().trim().min(1).max(320) }).strict().parse(request.query);
    const user = await db.user.findFirst({ where: { OR:[{id:query},{primaryEmail:{equals:query,mode:"insensitive"}}] }, select:{id:true,displayName:true,primaryEmail:true,status:true,applicationRole:true} });
    if (!user) throw errors.notFound();
    const [flags, enrollment] = await Promise.all([db.featureFlag.findMany({orderBy:{key:"asc"}}),db.betaEnrollment.findUnique({where:{userId:user.id},select:{id:true}})]);
    const beta=Boolean(enrollment);
    return { user, betaEnrolled:beta, evaluations:flags.map(flag=>({key:flag.key,bucket:stableFeatureBucket(user.id,flag.key),preview:{enabled:enabled(flag,user,beta,"preview"),reason:reason(flag,user,beta,"preview")},production:{enabled:enabled(flag,user,beta,"production"),reason:reason(flag,user,beta,"production")}})) };
  });
  app.post("/api/v1/support/rollout-operations/simulate", async request => {
    requireSupport(request);
    const { query, featureKey, proposedPercentage } = z.object({query:z.string().trim().min(1).max(320),featureKey:z.string().trim().min(1).max(120),proposedPercentage:z.number().int().min(0).max(100)}).strict().parse(request.body);
    const [user,flag]=await Promise.all([db.user.findFirst({where:{OR:[{id:query},{primaryEmail:{equals:query,mode:"insensitive"}}]},select:{id:true,displayName:true,primaryEmail:true}}),db.featureFlag.findUnique({where:{key:featureKey}})]);
    if(!user||!flag) throw errors.notFound();
    const bucket=stableFeatureBucket(user.id,featureKey);
    return { user, featureKey, bucket, currentPercentage:flag.percentage, proposedPercentage, currentEnabled:bucket<flag.percentage, proposedEnabled:bucket<proposedPercentage, thresholds:[10,25,50,75,100].map(percentage=>({percentage,enabled:bucket<percentage})) };
  });
}
