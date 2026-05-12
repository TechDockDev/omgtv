
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkWeirdSubscriptions() {
  const now = new Date();
  console.log("Current time (UTC):", now.toISOString());

  // 1. Users who are ACTIVE or CANCELED but endsAt is in the past
  const expiredButMarkedActive = await prisma.userSubscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'CANCELED'] },
      endsAt: { lt: now }
    },
    select: {
      userId: true,
      status: true,
      endsAt: true,
      planId: true
    }
  });

  console.log(`Found ${expiredButMarkedActive.length} users who are ACTIVE/CANCELED but endsAt is in the past.`);
  if (expiredButMarkedActive.length > 0) {
    console.log("Samples:", expiredButMarkedActive.slice(0, 5));
  }

  // 2. Total counts for active status
  const activeCount = await prisma.userSubscription.count({
    where: {
        status: 'ACTIVE',
        endsAt: { gt: now }
    }
  });
  console.log("Total Active & Not Expired:", activeCount);

  const canceledCount = await prisma.userSubscription.count({
    where: {
        status: 'CANCELED',
        endsAt: { gt: now }
    }
  });
  console.log("Total Canceled & Not Expired:", canceledCount);

  // 3. Check for specific userId if provided (placeholder)
}

checkWeirdSubscriptions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
