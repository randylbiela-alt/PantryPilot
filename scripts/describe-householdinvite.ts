import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const result =
    await prisma.$queryRawUnsafe(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'HouseholdInvite'
      ORDER BY ordinal_position;
    `);

  console.log(JSON.stringify(result, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
