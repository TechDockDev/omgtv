const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const subs = await prisma.userSubscription.findMany({
    where: { trialPlanId: { not: null } }
  });
  console.log("User IDs in UserSubscription:", subs.map(s => s.userId));
}
main().catch(console.error).finally(() => prisma.$disconnect());
