const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.subscriptionPlan.findMany({
    select: { id: true, name: true, pricePaise: true, durationDays: true }
  });
  console.log('Plans:', JSON.stringify(plans, null, 2));

  const trials = await prisma.trialPlan.findMany({
    select: { id: true, trialPricePaise: true, durationDays: true }
  });
  console.log('Trials:', JSON.stringify(trials, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
