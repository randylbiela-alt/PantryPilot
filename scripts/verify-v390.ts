import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const result = await prisma.$queryRawUnsafe(`
    SELECT
      table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('AuthFlow','HouseholdInvite');
  `);

  console.log(JSON.stringify(result, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
