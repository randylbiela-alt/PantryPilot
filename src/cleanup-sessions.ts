import { db } from "./db.js";

const now = new Date();
const revokedRetention = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const result = await db.userSession.deleteMany({
  where: {
    OR: [
      { expiresAt: { lt: now } },
      { absoluteExpiresAt: { lt: now } },
      { revokedAt: { lt: revokedRetention } }
    ]
  }
});
console.log(`Deleted ${result.count} expired or old revoked sessions.`);
await db.$disconnect();
