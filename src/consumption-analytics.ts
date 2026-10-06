import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";

const paramsSchema = z.object({ householdId: z.string().uuid() }).strict();
const querySchema = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).strict();
const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export async function consumptionAnalyticsRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/consumption-analytics", async request => {
 const { householdId } = paramsSchema.parse(request.params);
 const { days } = querySchema.parse(request.query);
 await requireHousehold(request, householdId);

 const now = new Date();
 const today = startOfUtcDay(now);
 const periodStart = new Date(today);
 periodStart.setUTCDate(periodStart.getUTCDate() - (days - 1));
 const weekStart = new Date(today);
 weekStart.setUTCDate(weekStart.getUTCDate() - 6);
 const monthStart = new Date(today);
 monthStart.setUTCDate(monthStart.getUTCDate() - 29);

 const [events, pantry] = await Promise.all([
 db.inventoryEvent.findMany({
 where: { householdId, type: "CONSUMED", occurredAt: { gte: periodStart } },
 orderBy: { occurredAt: "asc" }
 }),
 db.pantryItem.findMany({ where: { householdId } })
 ]);

 const pantryById = new Map(pantry.map(item => [item.id, item]));
 const byItem = new Map<string, { pantryItemId: string; name: string; unit: string; category: string; consumed: number; events: number }>();
 const byCategory = new Map<string, number>();
 const byDay = new Map<string, number>();
 let weekConsumed = 0;
 let monthConsumed = 0;
 let totalConsumed = 0;

 for (const event of events) {
 const amount = Math.abs(Number(event.quantityDelta));
 const item = pantryById.get(event.pantryItemId);
 const category = item?.category?.trim() || "Uncategorized";
 const current = byItem.get(event.pantryItemId) ?? { pantryItemId: event.pantryItemId, name: event.pantryItemName, unit: event.unit, category, consumed: 0, events: 0 };
 current.consumed += amount;
 current.events += 1;
 byItem.set(event.pantryItemId, current);
 byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
 const day = dateKey(event.occurredAt);
 byDay.set(day, (byDay.get(day) ?? 0) + amount);
 totalConsumed += amount;
 if (event.occurredAt >= weekStart) weekConsumed += amount;
 if (event.occurredAt >= monthStart) monthConsumed += amount;
 }

 const items = [...byItem.values()].map(value => {
 const pantryItem = pantryById.get(value.pantryItemId);
 const averageDaily = value.consumed / days;
 const currentQuantity = pantryItem ? Number(pantryItem.quantity) : null;
 const estimatedDaysRemaining = currentQuantity !== null && averageDaily > 0 ? Math.ceil(currentQuantity / averageDaily) : null;
 return { ...value, consumed: round(value.consumed), averageDaily: round(averageDaily), currentQuantity, estimatedDaysRemaining };
 }).sort((a, b) => b.consumed - a.consumed || a.name.localeCompare(b.name));

 const trend = Array.from({ length: days }, (_, index) => {
 const date = new Date(periodStart);
 date.setUTCDate(periodStart.getUTCDate() + index);
 const key = dateKey(date);
 return { date: key, consumed: round(byDay.get(key) ?? 0) };
 });

 const response = {
 generatedAt: now.toISOString(),
 period: { days, startDate: dateKey(periodStart), endDate: dateKey(today) },
 summary: {
 totalConsumed: round(totalConsumed),
 consumptionThisWeek: round(weekConsumed),
 consumptionLast30Days: round(monthConsumed),
 averageDailyConsumption: round(totalConsumed / days),
 eventCount: events.length,
 activeConsumedItems: items.length
 },
 topItems: items.slice(0, 10),
 categoryConsumption: [...byCategory.entries()].map(([category, consumed]) => ({ category, consumed: round(consumed) })).sort((a, b) => b.consumed - a.consumed || a.category.localeCompare(b.category)),
 trend,
 limitations: [
 "Analytics include InventoryEvent records classified as CONSUMED.",
 "Quantities with different units are displayed as recorded and are not converted across units.",
 "Estimated days remaining requires both current pantry quantity and consumption activity within the selected period."
 ]
 };

 await db.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "consumption.analytics_viewed", resourceType: "Household", resourceId: householdId, result: "success", correlationId: request.correlationId, metadata: { days, eventCount: events.length, activeConsumedItems: items.length } } });
 return response;
 });
}
