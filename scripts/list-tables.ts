import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const tables = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  console.log(JSON.stringify(tables, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
