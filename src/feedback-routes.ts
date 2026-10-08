import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { AppError } from "./errors.js";

const params = z.object({ householdId: z.string().uuid() });
const input = z.object({
  type: z.enum(["BUG", "FEATURE_REQUEST", "GENERAL_FEEDBACK"]),
  rating: z.number().int().min(1).max(5),
  subject: z.string().trim().min(3).max(180),
  details: z.string().trim().min(3).max(8000),
  expectedOutcome: z.string().trim().max(4000).nullable().optional(),
  buildVersion: z.string().trim().min(1).max(80),
  deployment: z.string().trim().min(1).max(80),
  diagnosticsIncluded: z.boolean(),
  diagnostics: z.string().max(8000).nullable().optional(),
}).strict();

const categoryByType = { BUG: "OTHER", FEATURE_REQUEST: "OTHER", GENERAL_FEEDBACK: "OTHER" } as const;
const priorityByType = { BUG: "MEDIUM", FEATURE_REQUEST: "LOW", GENERAL_FEEDBACK: "LOW" } as const;
const labelByType = { BUG: "Bug report", FEATURE_REQUEST: "Feature request", GENERAL_FEEDBACK: "General feedback" } as const;

export async function feedbackRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/households/:householdId/feedback",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const { householdId } = params.parse(request.params);
      await requireHousehold(request, householdId, false);
      const body = input.parse(request.body);
      const actor = request.authUser!.id;
      const rawKey = request.headers["x-idempotency-key"];
      const idempotencyKey = typeof rawKey === "string" ? rawKey.trim().slice(0, 160) : "";
      if (!idempotencyKey) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "X-Idempotency-Key is required.");
      const storedCorrelation = `feedback:${idempotencyKey}`;
      const existing = await db.supportIssue.findFirst({ where: { affectedUserId: actor, affectedHouseholdId: householdId, correlationId: storedCorrelation }, select: { id: true, issueNumber: true, createdAt: true } });
      if (existing) return { ...existing, reference: `ISS-${String(existing.issueNumber).padStart(4, "0")}`, duplicate: true, correlationId: request.correlationId };
      const description = [
        "[PantryPilot Feedback]",
        `Feedback type: ${labelByType[body.type]}`,
        `Rating: ${body.rating} of 5`,
        `Build version: ${body.buildVersion}`,
        `Deployment: ${body.deployment}`,
        `Diagnostics included: ${body.diagnosticsIncluded ? "Yes" : "No"}`,
        "",
        "Details",
        body.details,
        "",
        "Expected outcome",
        body.expectedOutcome || "Not provided",
        ...(body.diagnosticsIncluded && body.diagnostics ? ["", "Diagnostics", body.diagnostics] : []),
      ].join("\n");
      const issue = await db.$transaction(async tx => {
        const created = await tx.supportIssue.create({ data: { title: body.subject, description, priority: priorityByType[body.type], category: categoryByType[body.type], affectedUserId: actor, affectedHouseholdId: householdId, correlationId: storedCorrelation, createdByUserId: actor, updatedByUserId: actor }, select: { id: true, issueNumber: true, createdAt: true } });
        await tx.auditEvent.create({ data: { actorUserId: actor, householdId, action: "feedback.issue.created", resourceType: "SupportIssue", resourceId: created.id, result: "success", correlationId: request.correlationId, metadata: { issueNumber: created.issueNumber, source: "PANTRYPILOT_FEEDBACK", feedbackType: body.type, rating: body.rating, buildVersion: body.buildVersion, deployment: body.deployment, diagnosticsIncluded: body.diagnosticsIncluded } } });
        return created;
      });
      return reply.code(201).send({ ...issue, reference: `ISS-${String(issue.issueNumber).padStart(4, "0")}`, duplicate: false, correlationId: request.correlationId });
    },
  );
}
