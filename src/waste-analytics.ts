import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";
import { requireHousehold } from "./authorize.js";

const paramsSchema = z.object({ householdId: z.string().uuid() }).strict();
const querySchema = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).strict();
const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export async function wasteAnalyticsRoutes(app: FastifyInstance): Promise<void> {
 app.get("/api/v1/households/:householdId/waste-analytics", async request => {
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

 const [wasteEvents, consumedEvents, pantry] = await Promise.all([
 db.inventoryEvent.findMany({ where: { householdId, type: { in: ["DISCARDED", "EXPIRED"] }, occurredAt: { gte: periodStart } }, orderBy: { occurredAt: "asc" } }),
 db.inventoryEvent.findMany({ where: { householdId, type: "CONSUMED", occurredAt: { gte: periodStart } } }),
 db.pantryItem.findMany({ where: { householdId } })
 ]);

 const pantryById = new Map(pantry.map(item => [item.id, item]));
 const byItem = new Map<string, { pantryItemId: string; name: string; unit: string; category: string; discarded: number; expired: number; totalWaste: number; events: number }>();
 const byCategory = new Map<string, { discarded: number; expired: number; totalWaste: number }>();
 const byDay = new Map<string, { discarded: number; expired: number }>();
 let totalDiscarded = 0;
 let totalExpired = 0;
 let weekWaste = 0;
 let monthWaste = 0;

 for (const event of wasteEvents) {
 const amount = Math.abs(Number(event.quantityDelta));
 const item = pantryById.get(event.pantryItemId);
 const category = item?.category?.trim() || "Uncategorized";
 const current = byItem.get(event.pantryItemId) ?? { pantryItemId: event.pantryItemId, name: event.pantryItemName, unit: event.unit, category, discarded: 0, expired: 0, totalWaste: 0, events: 0 };
 if (event.type === "DISCARDED") { current.discarded += amount; totalDiscarded += amount; }
 else { current.expired += amount; totalExpired += amount; }
 current.totalWaste += amount;
 current.events += 1;
 byItem.set(event.pantryItemId, current);

 const categoryValue = byCategory.get(category) ?? { discarded: 0, expired: 0, totalWaste: 0 };
 if (event.type === "DISCARDED") categoryValue.discarded += amount;
 else categoryValue.expired += amount;
 categoryValue.totalWaste += amount;
 byCategory.set(category, categoryValue);

 const day = dateKey(event.occurredAt);
 const dayValue = byDay.get(day) ?? { discarded: 0, expired: 0 };
 if (event.type === "DISCARDED") dayValue.discarded += amount;
 else dayValue.expired += amount;
 byDay.set(day, dayValue);
 if (event.occurredAt >= weekStart) weekWaste += amount;
 if (event.occurredAt >= monthStart) monthWaste += amount;
 }

 const totalWaste = totalDiscarded + totalExpired;
 const totalConsumed = consumedEvents.reduce((sum, event) => sum + Math.abs(Number(event.quantityDelta)), 0);
 const trackedUsage = totalConsumed + totalWaste;
 const wasteRatePercent = trackedUsage > 0 ? (totalWaste / trackedUsage) * 100 : 0;
 const topItems = [...byItem.values()].map(item => ({ ...item, discarded: round(item.discarded), expired: round(item.expired), totalWaste: round(item.totalWaste) })).sort((a, b) => b.totalWaste - a.totalWaste || a.name.localeCompare(b.name)).slice(0, 10);
 const categoryWaste = [...byCategory.entries()].map(([category, value]) => ({ category, discarded: round(value.discarded), expired: round(value.expired), totalWaste: round(value.totalWaste), percentOfWaste: totalWaste > 0 ? round((value.totalWaste / totalWaste) * 100, 1) : 0 })).sort((a, b) => b.totalWaste - a.totalWaste || a.category.localeCompare(b.category));
 const trend = Array.from({ length: days }, (_, index) => { const date = new Date(periodStart); date.setUTCDate(periodStart.getUTCDate() + index); const key = dateKey(date); const value = byDay.get(key) ?? { discarded: 0, expired: 0 }; return { date: key, discarded: round(value.discarded), expired: round(value.expired), totalWaste: round(value.discarded + value.expired) }; });

 const response = {
 generatedAt: now.toISOString(),
 period: { days, startDate: dateKey(periodStart), endDate: dateKey(today) },
 summary: { wasteThisWeek: round(weekWaste), wasteLast30Days: round(monthWaste), totalDiscarded: round(totalDiscarded), totalExpired: round(totalExpired), totalWaste: round(totalWaste), wasteEventCount: wasteEvents.length, wasteRatePercent: round(wasteRatePercent, 1), consumedToWastedRatio: totalWaste > 0 ? round(totalConsumed / totalWaste, 2) : null },
 topItems,
 categoryWaste,
 trend,
 insights: { highestWasteCategory: categoryWaste[0]?.category ?? null, mostWastedItem: topItems[0]?.name ?? null, expirationSharePercent: totalWaste > 0 ? round((totalExpired / totalWaste) * 100, 1) : 0 },
 limitations: ["Waste analytics include InventoryEvent records classified as DISCARDED or EXPIRED.", "Amounts with different units are shown as recorded and are not converted across units.", "Waste rate compares recorded consumed quantities with recorded discarded and expired quantities for the selected period."]
 };

 await db.auditEvent.create({ data: { actorUserId: request.authUser!.id, householdId, action: "waste.analytics_viewed", resourceType: "Household", resourceId: householdId, result: "success", correlationId: request.correlationId, metadata: { days, wasteEventCount: wasteEvents.length, wasteRatePercent: response.summary.wasteRatePercent } } });
 return response;
 });
}
