import type { FastifyInstance } from "fastify";
import { db } from "./db.js";

const startedAt = new Date();

type CheckStatus = "healthy" | "degraded";

export async function observabilityRoutes(app: FastifyInstance) {
 app.get("/api/v1/observability/summary", async request => {
 const checkedAt = new Date();
 const databaseStarted = performance.now();
 let databaseStatus: CheckStatus = "healthy";
 let databaseLatencyMs: number | null = null;
 try {
 await db.$queryRaw`SELECT 1`;
 databaseLatencyMs = Math.round((performance.now() - databaseStarted) * 10) / 10;
 } catch (error) {
 databaseStatus = "degraded";
 request.log.error({ err: error }, "observability database check failed");
 }

 const memory = process.memoryUsage();
 const apiStatus: CheckStatus = databaseStatus === "healthy" ? "healthy" : "degraded";
 return {
 status: apiStatus,
 checkedAt: checkedAt.toISOString(),
 correlationId: request.correlationId,
 application: {
 name: "PantryPilot API",
 version: process.env.npm_package_version ?? "unknown",
 environment: app.config.NODE_ENV,
 nodeVersion: process.version,
 startedAt: startedAt.toISOString(),
 uptimeSeconds: Math.floor(process.uptime())
 },
 checks: {
 api: { status: apiStatus },
 database: { status: databaseStatus, latencyMs: databaseLatencyMs },
 ocr: {
 status: app.config.OPENAI_API_KEY ? "configured" : "unavailable",
 model: app.config.OPENAI_VISION_MODEL
 },
 productLookup: {
 status: "configured",
 provider: "Open Food Facts"
 }
 },
 runtime: {
 rssMb: Math.round(memory.rss / 1024 / 1024),
 heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
 heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024)
 }
 };
 });
}
