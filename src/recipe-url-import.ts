import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { extractRecipeFromUrl } from "./recipe-url-import-service.js";

const params = z.object({ householdId: z.string().uuid() }).strict();
const body = z.object({ url: z.string().trim().url().max(2048) }).strict();

export async function recipeUrlImportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/households/:householdId/recipe-import/url",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async request => {
      const { householdId } = params.parse(request.params);
      await requireHousehold(request, householdId, true);
      const input = body.parse(request.body);
      const result = await extractRecipeFromUrl(app.config, input.url);
      await db.auditEvent.create({
        data: {
          actorUserId: request.authUser!.id,
          householdId,
          action: "recipe.url_import.analyzed",
          resourceType: "Household",
          resourceId: householdId,
          result: "success",
          correlationId: request.correlationId,
          metadata: {
            sourceHost: new URL(result.sourceUrl).hostname,
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
