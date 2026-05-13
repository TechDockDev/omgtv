
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  console.log('=== VERIFYING RECONCILIATION LOGIC ===');

  // 1. Run the same query we just implemented in the API
  const userStats: any[] = await prisma.$queryRaw`
      WITH UserPayments AS (
          SELECT 
              "userId",
              SUM("amountPaise") as total_paid_paise,
              MAX("createdAt") as last_payment_date
          FROM "Transaction"
          WHERE "status" = 'SUCCESS'
          GROUP BY "userId"
      ),
      LatestSubscription AS (
          SELECT DISTINCT ON ("userId") 
              "userId", 
              "status", 
              "endsAt"
          FROM "UserSubscription"
          ORDER BY "userId", "createdAt" DESC
      ),
      CategorizedUsers AS (
          SELECT 
              up."userId",
              CASE WHEN up.total_paid_paise >= 9900 THEN 'SUBSCRIBER' ELSE 'TRIAL' END as category,
              CASE WHEN COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') > NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END as status
          FROM UserPayments up
          LEFT JOIN LatestSubscription ls ON up."userId" = ls."userId"
      )
      SELECT 
          category,
          status,
          COUNT(*)::int as user_count
      FROM CategorizedUsers
      GROUP BY 1, 2
  `;

  console.log('\n--- Master Truth Aggregated Stats ---');
  console.table(userStats);

  const activeSubscribers = userStats.find(s => s.category === 'SUBSCRIBER' && s.status === 'ACTIVE')?.user_count || 0;
  const activeTrials = userStats.find(s => s.category === 'TRIAL' && s.status === 'ACTIVE')?.user_count || 0;

  console.log('\n--- Final Verification ---');
  console.log(`Active Subscribers: ${activeSubscribers} (Expected: 97)`);
  console.log(`Active Trials: ${activeTrials} (Expected: 11)`);
  
  if (activeSubscribers === 97 && activeTrials === 11) {
    console.log('\n✅ SUCCESS: Counts are perfectly synchronized!');
  } else {
    console.log('\n❌ DISCREPANCY: Counts do not match expected values.');
  }

  // 2. Check for Orphan Transactions specifically
  const orphans: any[] = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT t."userId")::int as orphan_count
      FROM "Transaction" t
      LEFT JOIN "UserSubscription" us ON t."userId" = us."userId"
      WHERE t."status" = 'SUCCESS' AND us."id" IS NULL
  `;
  console.log(`\nOrphan Transactions (Paid but no sub record): ${orphans[0].orphan_count}`);

  await prisma.$disconnect();
}

check().catch(console.error);
