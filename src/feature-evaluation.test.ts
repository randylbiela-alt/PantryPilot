import { describe, expect, it } from "vitest";
import { evaluateFeature, stableFeatureBucket } from "./feature-evaluation.js";
const base = { featureKey: "household-insights-v2", percentage: 50, previewEnabled: true, productionEnabled: true, environment: "preview" as const, userId: "user-1", applicationRole: "USER" as const, betaEnrolled: false };
describe("feature evaluation", () => {
  it("uses stable buckets", () => expect(stableFeatureBucket("user-1", "flag")).toBe(stableFeatureBucket("user-1", "flag")));
  it("honors environment gates", () => expect(evaluateFeature({ ...base, rollout: "GLOBAL", previewEnabled: false })).toBe(false));
  it("keeps OFF disabled", () => expect(evaluateFeature({ ...base, rollout: "OFF" })).toBe(false));
  it("limits INTERNAL to internal roles", () => { expect(evaluateFeature({ ...base, rollout: "INTERNAL" })).toBe(false); expect(evaluateFeature({ ...base, rollout: "INTERNAL", applicationRole: "SUPPORT" })).toBe(true); });
  it("includes enrolled beta users", () => expect(evaluateFeature({ ...base, rollout: "BETA", betaEnrolled: true })).toBe(true));
  it("enables zero and one hundred percent boundaries", () => { expect(evaluateFeature({ ...base, rollout: "PERCENTAGE", percentage: 0 })).toBe(false); expect(evaluateFeature({ ...base, rollout: "PERCENTAGE", percentage: 100 })).toBe(true); });
  it("enables GLOBAL users when the environment is on", () => expect(evaluateFeature({ ...base, rollout: "GLOBAL" })).toBe(true));
});
