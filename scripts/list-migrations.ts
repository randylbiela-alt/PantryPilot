import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const rows =
    await prisma.$queryRawUnsafe(`
      SELECT
        migration_name,
        finished_at,
        rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY finished_at;
    `);

  console.log(JSON.stringify(rows, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
