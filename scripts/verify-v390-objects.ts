import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const authFlow =
    await prisma.$queryRawUnsafe(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema='public'
        AND table_name='AuthFlow'
      );
    `);

  const invite =
    await prisma.$queryRawUnsafe(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema='public'
        AND table_name='HouseholdInvite'
      );
    `);

  console.log("AuthFlow");
  console.log(JSON.stringify(authFlow,null,2));

  console.log("HouseholdInvite");
  console.log(JSON.stringify(invite,null,2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
