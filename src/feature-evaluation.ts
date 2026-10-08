import { createHash } from "node:crypto";
import type { ApplicationRole, FeatureRollout } from "@prisma/client";

export type FeatureEnvironment = "preview" | "production";
export type EvaluationInput = {
  featureKey: string;
  rollout: FeatureRollout;
  percentage: number;
  previewEnabled: boolean;
  productionEnabled: boolean;
  environment: FeatureEnvironment;
  userId: string;
  applicationRole: ApplicationRole;
  betaEnrolled: boolean;
};

export function stableFeatureBucket(userId: string, featureKey: string): number {
  const digest = createHash("sha256").update(`${userId}:${featureKey}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function evaluateFeature(input: EvaluationInput): boolean {
  const environmentEnabled = input.environment === "preview" ? input.previewEnabled : input.productionEnabled;
  if (!environmentEnabled) return false;
  const internal = input.applicationRole === "SUPPORT" || input.applicationRole === "SUPER_ADMIN";
  switch (input.rollout) {
    case "OFF": return false;
    case "INTERNAL": return internal;
    case "BETA": return internal || input.betaEnrolled;
    case "PERCENTAGE": return stableFeatureBucket(input.userId, input.featureKey) < Math.max(0, Math.min(100, input.percentage));
    case "GLOBAL": return true;
  }
}
