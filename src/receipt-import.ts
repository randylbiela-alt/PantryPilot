import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";
import { extractReceipt } from "./receipt-service.js";
import { receiptImageRequest } from "./receipt-types.js";

const params = z.object({ householdId: z.string().uuid() }).strict();

export async function receiptImportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/households/:householdId/receipt-import/analyze",
    {
      bodyLimit: 12 * 1024 * 1024,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
    },
    async request => {
      const { householdId } = params.parse(request.params);
      await requireHousehold(request, householdId, true);
      const input = receiptImageRequest.parse(request.body);
      const result = await extractReceipt(app.config, input.imageBase64, input.mimeType);

      await db.$transaction([
        db.auditEvent.create({
          data: {
            actorUserId: request.authUser!.id,
            householdId,
            action: "receipt.analyzed",
            resourceType: "Household",
            resourceId: householdId,
            result: "success",
            correlationId: request.correlationId,
            metadata: {
              itemCount: result.items.length,
              mimeType: input.mimeType,
              model: app.config.OPENAI_VISION_MODEL
            } satisfies Prisma.InputJsonValue
          }
        }),
        db.outboxMessage.create({
          data: {
            topic: "receipt-events",
            messageType: "receipt.analyzed",
            aggregateType: "Household",
            aggregateId: householdId,
            correlationId: request.correlationId,
            payload: { householdId, itemCount: result.items.length }
          }
        })
      ]);

      return {
        merchantName: result.merchantName || null,
        purchaseDate: result.purchaseDate || null,
        items: result.items.map(item => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit || "item",
          category: item.category || null
        }))
      };
    }
  );
}
