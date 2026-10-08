import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { errors } from "./errors.js";
import { evaluateFeature, type FeatureEnvironment } from "./feature-evaluation.js";

const querySchema = z.object({ environment: z.enum(["preview", "production"]) }).strict();

export async function featureEvaluationRoutes(app: FastifyInstance) {
  app.get("/api/v1/features", async request => {
    if (!request.authUser) throw errors.unauthorized();
    const { environment } = querySchema.parse(request.query) as { environment: FeatureEnvironment };
    const [flags, betaEnrollment] = await Promise.all([
      db.featureFlag.findMany({ orderBy: { key: "asc" } }),
      db.betaEnrollment.findUnique({ where: { userId: request.authUser.id }, select: { id: true } }),
    ]);
    const features = Object.fromEntries(flags.map(flag => [flag.key, evaluateFeature({
      featureKey: flag.key, rollout: flag.rollout, percentage: flag.percentage,
      previewEnabled: flag.previewEnabled, productionEnabled: flag.productionEnabled, environment,
      userId: request.authUser!.id, applicationRole: request.authUser!.applicationRole, betaEnrolled: Boolean(betaEnrollment),
    })]));
    return { environment, features };
  });
}
