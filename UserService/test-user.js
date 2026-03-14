const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.customerProfile.findMany({ take: 5 });
  console.log("CustomerProfiles:", users);
}
main().catch(console.error).finally(() => prisma.$disconnect());
