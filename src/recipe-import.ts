import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { extractRecipe } from "./recipe-import-service.js";
import { recipeImportRequestSchema } from "./recipe-import-types.js";

const params = z.object({ householdId: z.string().uuid() }).strict();

export async function recipeImportRoutes(app: FastifyInstance): Promise<void> {
 app.post(
 "/api/v1/households/:householdId/recipe-import/analyze",
 {
 bodyLimit: 36 * 1024 * 1024,
 config: { rateLimit: { max: 8, timeWindow: "1 minute" } }
 },
 async request => {
 const { householdId } = params.parse(request.params);
 await requireHousehold(request, householdId, true);
 const input = recipeImportRequestSchema.parse(request.body);
 const result = await extractRecipe(app.config, input);

 await db.auditEvent.create({
 data: {
 actorUserId: request.authUser!.id,
 householdId,
 action: "recipe.import.analyzed",
 resourceType: "Household",
 resourceId: householdId,
 result: "success",
 correlationId: request.correlationId,
 metadata: {
 imageCount: input.images.length,
 pastedText: Boolean(input.pastedText),
 ingredientCount: result.ingredients.length,
 warningCount: result.warnings.length,
 model: app.config.OPENAI_VISION_MODEL
 } satisfies Prisma.InputJsonValue
 }
 });

 return result;
 }
 );
}
