import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

async function main() {

  const sql = readFileSync(
    "prisma\\migrations\\20261003_v390_oauth_foundation\\migration.sql",
    "utf8"
  );

  console.log("Executing migration...");

  await prisma.$executeRawUnsafe(sql);

  console.log("Migration executed.");
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
