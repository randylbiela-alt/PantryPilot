import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {

  const result =
    await prisma.$queryRawUnsafe(`
      SELECT
        current_database(),
        inet_server_addr(),
        inet_server_port()
    `);

  console.log(JSON.stringify(result,null,2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
