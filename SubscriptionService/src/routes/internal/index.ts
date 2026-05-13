import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";
import { CoinService } from "../../services/coinService";
import { TransactionSource } from "@prisma/client";
const coinService = new CoinService();

const entitlementRequest = z.object({
  userId: z.string(),
  contentType: z.enum(["REEL", "EPISODE"]),
});

export default async function internalRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.post("/entitlements/check", {
    schema: { body: entitlementRequest },
  }, async (request) => {
    const { userId, contentType } = request.body as z.infer<typeof entitlementRequest>;

    const subscription = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIAL", "CANCELED"] },
        endsAt: { gt: new Date() } // Ensure subscription hasn't expired
      },
      orderBy: { startsAt: "desc" },
      include: { plan: true, trialPlan: true },
    });

    if (subscription && (subscription.plan || subscription.trialPlan)) {
      return {
        allowed: true,
        planId: subscription.planId || subscription.trialPlanId,
        status: subscription.status,
        isTrial: !!subscription.trialPlan,
        contentType,
      };
    }

    const freePlan = await prisma.freePlanConfig.findUnique({ where: { id: 1 } });
    return {
      allowed: true,
      planId: "free",
      status: "FREE",
      contentType,
      freeLimits: freePlan,
    };
  });

  app.get("/revenue/stats", {
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        granularity: z.enum(["daily", "monthly", "yearly"]).optional().default("daily"),
      }),
    },
  }, async (request) => {
    const { startDate, endDate, granularity = "daily" } = request.query as { startDate?: string; endDate?: string; granularity?: string };
    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();

    const [stats, trend] = await Promise.all([
      prisma.transaction.aggregate({
        where: {
          status: "SUCCESS",
          createdAt: { gte: start, lte: end },
        },
        _sum: { amountPaise: true },
        _count: { id: true },
      }),
      prisma.transaction.groupBy({
        by: ["createdAt"],
        where: {
          status: "SUCCESS",
          createdAt: { gte: start, lte: end },
        },
        _sum: { amountPaise: true },
      }),
    ]);

    // Format trend data by requested granularity
    const buckets: Record<string, number> = {};
    trend.forEach(item => {
      let key = item.createdAt.toISOString().split("T")[0]; // default daily
      if (granularity === "monthly") {
        key = item.createdAt.toISOString().substring(0, 7); // YYYY-MM
      } else if (granularity === "yearly") {
        key = item.createdAt.toISOString().substring(0, 4); // YYYY
      }
      buckets[key] = (buckets[key] || 0) + (item._sum.amountPaise || 0);
    });

    const trendData = Object.entries(buckets).map(([date, value]) => ({
      date,
      value: value / 100, // Convert to main currency unit
    })).sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalRevenuePaise: stats._sum.amountPaise || 0,
      totalTransactions: stats._count.id,
      trend: trendData,
    };
  });

  app.get("/stats/users", {
    schema: {},
  }, async (request) => {
    // We use the Master Reconciliation Logic (same as the SQL query we verified)
    // 1. Get total revenue and user categorization from Transactions + fallback for Orphans
    const userStats = await prisma.$queryRaw<any[]>`
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
              CASE WHEN COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') > NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END as expiry_status
          FROM UserPayments up
          LEFT JOIN LatestSubscription ls ON up."userId" = ls."userId"
      )
      SELECT 
          category,
          expiry_status as status,
          COUNT(*)::int as user_count
      FROM CategorizedUsers
      GROUP BY 1, 2
    `;

    let active_subscribers = 0;
    let expired_subscribers = 0;
    let active_trials = 0;
    let expired_trials = 0;

    userStats.forEach(row => {
      if (row.category === 'SUBSCRIBER') {
        if (row.status === 'ACTIVE') active_subscribers = row.user_count;
        else expired_subscribers = row.user_count;
      } else {
        if (row.status === 'ACTIVE') active_trials = row.user_count;
        else expired_trials = row.user_count;
      }
    });

    // For the Plan breakdown, we still use the linked subscriptions for accuracy of names
    const planBreakdownRaw = await prisma.userSubscription.groupBy({
      by: ['planId'],
      where: {
        status: { in: ['ACTIVE', 'CANCELED'] },
        endsAt: { gt: new Date() },
        trialPlanId: null
      },
      _count: true
    });

    const plans = await prisma.subscriptionPlan.findMany({
      where: { id: { in: planBreakdownRaw.map(p => p.planId).filter(id => id !== null) as string[] } }
    });

    const plan_breakdown = plans.map(p => ({
      name: p.name,
      price: p.pricePaise / 100,
      count: planBreakdownRaw.find(r => r.planId === p.id)?._count || 0
    }));

    return {
      active_subscribers,
      canceled_subscribers: 0, // Simplified for this view, active includes canceled
      expired_subscribers,
      active_trials,
      canceled_trials: 0,
      expired_trials,
      plan_breakdown
    };
  });

  app.get("/subscriptions/by-plan", {
    schema: {
      querystring: z.object({
        planId: z.string().optional(),
        pricePaise: z.coerce.number().optional(),
        limit: z.coerce.number().optional().default(10000),
      }),
    },
  }, async (request) => {
    const { planId, pricePaise, limit } = request.query as { planId?: string; pricePaise?: number; limit: number };

    const where: any = {
      status: { in: ["ACTIVE", "CANCELED"] },
      endsAt: { gt: new Date() },
      trialPlanId: null
    };

    if (planId) {
      where.planId = planId;
    } else if (pricePaise) {
      where.plan = { pricePaise };
    }

    const subscriptions = await prisma.userSubscription.findMany({
      where,
      select: {
        userId: true,
        endsAt: true,
        plan: { select: { name: true } }
      },
      distinct: ['userId'],
      orderBy: { endsAt: 'desc' },
      take: limit,
    });

    return {
      users: subscriptions.map(s => ({
        userId: s.userId,
        endsAt: s.endsAt,
        planName: s.plan?.name || "Premium"
      }))
    };
  });

  app.get("/subscriptions/active-users", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(10000),
      }),
    },
  }, async (request) => {
    const { limit } = request.query as { limit: number };

    // Smart Logic: Find users who paid full price (cumulative >= 99) OR have an active subscription record
    // This matches the /stats/users categorization exactly.
    const users = await prisma.$queryRaw<any[]>`
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
      )
      SELECT 
          up."userId",
          COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') as "endsAt",
          'Premium' as "planName"
      FROM UserPayments up
      LEFT JOIN LatestSubscription ls ON up."userId" = ls."userId"
      WHERE up.total_paid_paise >= 9900
        AND COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') > NOW()
      LIMIT ${limit}
    `;

    return { users };
  });

  app.get("/subscriptions/trial-users", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(10000),
      }),
    },
  }, async (request) => {
    const { limit } = request.query as { limit: number };

    // Smart Logic for Trials: Cumulative Paid < 9900 AND Active
    const users = await prisma.$queryRaw<any[]>`
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
      )
      SELECT 
          up."userId",
          COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') as "endsAt",
          'Trial' as "planName"
      FROM UserPayments up
      LEFT JOIN LatestSubscription ls ON up."userId" = ls."userId"
      WHERE up.total_paid_paise < 9900
        AND COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') > NOW()
      LIMIT ${limit}
    `;

    return { users };
  });

  app.get("/subscriptions/trial-converted-users", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(20),
        offset: z.coerce.number().optional().default(0),
        status: z.enum(["all", "active", "expired"]).optional().default("all"),
      }),
    },
  }, async (request) => {
    const { limit, offset, status } = request.query as { limit: number; offset: number; status: string };

    let statusFilter = '';
    if (status === 'active') {
      statusFilter = 'AND COALESCE(us."endsAt", ce.converted_at + interval \'30 days\') > NOW()';
    } else if (status === 'expired') {
      statusFilter = 'AND COALESCE(us."endsAt", ce.converted_at + interval \'30 days\') <= NOW()';
    }

    // Smart Logic: Find users whose cumulative payments crossed 9900 paise
    const convertedUsers = await prisma.$queryRaw<any[]>`
      WITH UserPayments AS (
          SELECT 
              "userId",
              "amountPaise",
              "createdAt",
              SUM("amountPaise") OVER (PARTITION BY "userId" ORDER BY "createdAt") as cumulative_paid
          FROM "Transaction"
          WHERE "status" = 'SUCCESS'
      ),
      TrialThresholds AS (
          -- Include users who either have a recorded trial subscription OR at some point had < ₹99 total payments
          SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
          UNION
          SELECT DISTINCT "userId" FROM UserPayments WHERE cumulative_paid < 9900
      ),
      ConversionEvents AS (
          SELECT 
              "userId",
              MIN("createdAt") as converted_at
          FROM UserPayments
          WHERE cumulative_paid >= 9900
            AND "userId" IN (SELECT "userId" FROM TrialThresholds)
          GROUP BY "userId"
      )
      SELECT 
        ce."userId", 
        ce.converted_at, 
        COALESCE(us."status"::text, 'ACTIVE (Orphan)') as "currentStatus", 
        COALESCE(us."endsAt", ce.converted_at + interval '30 days') as "endsAt",
        COALESCE(p."name", 'Premium') as "planName",
        (SELECT SUM("amountPaise") FROM "Transaction" WHERE "userId" = ce."userId" AND "status" = 'SUCCESS') as "totalPaid",
        COUNT(*) OVER() as total_count
      FROM ConversionEvents ce
      LEFT JOIN "UserSubscription" us ON ce."userId" = us."userId"
      LEFT JOIN "SubscriptionPlan" p ON us."planId" = p."id"
      WHERE (us."id" IS NULL OR us."startsAt" = (SELECT MAX("startsAt") FROM "UserSubscription" WHERE "userId" = ce."userId"))
      ${statusFilter ? prisma.$queryRawUnsafe(statusFilter) : prisma.$queryRawUnsafe('')}
      ORDER BY ce.converted_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalCount = convertedUsers.length > 0 ? Number(convertedUsers[0].total_count) : 0;

    return {
      userIds: convertedUsers.map(u => u.userId),
      users: convertedUsers.map((u) => ({
        userId: u.userId,
        convertedAt: u.converted_at,
        currentStatus: u.currentStatus,
        expiryStatus: new Date(u.endsAt) > new Date() ? 'ACTIVE' : 'EXPIRED',
        planName: u.planName,
        amountPaid: Number(u.totalPaid) / 100,
        endsAt: u.endsAt
      })),
      total: totalCount,
      limit,
      offset,
    };
  });

  app.get("/subscriptions/cancellations", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(50),
        offset: z.coerce.number().optional().default(0),
      }),
    },
  }, async (request) => {
    const { limit, offset } = request.query as { limit: number; offset: number };

    // Categorize Canceled Users by Cumulative Payment
    const canceled = await prisma.$queryRaw<any[]>`
      WITH UserPayments AS (
          SELECT 
              "userId",
              SUM("amountPaise") as total_paid_paise
          FROM "Transaction"
          WHERE "status" = 'SUCCESS'
          GROUP BY "userId"
      )
      SELECT 
          us."userId",
          us."updatedAt" as "canceledAt",
          us."endsAt",
          COALESCE(p."name", 'Premium') as "planName",
          COALESCE(p."pricePaise", 0) as "pricePaise",
          CASE WHEN up.total_paid_paise >= 9900 THEN 'SUBSCRIBER' ELSE 'TRIAL' END as "category"
      FROM "UserSubscription" us
      LEFT JOIN "SubscriptionPlan" p ON us."planId" = p."id"
      LEFT JOIN UserPayments up ON us."userId" = up."userId"
      WHERE us."status" = 'CANCELED'
      ORDER BY us."updatedAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      items: canceled.map(c => ({
        userId: c.userId,
        planName: c.planName,
        amount: Number(c.pricePaise) / 100,
        canceledAt: c.canceledAt,
        endsAt: c.endsAt,
        type: c.category
      })),
      total: await prisma.userSubscription.count({ where: { status: "CANCELED" } })
    };
  });

  app.post("/episodes/unlock-status", {
    schema: {
      body: z.object({
        userId: z.string().min(1),
        episodeIds: z.array(z.string()).max(200),
      })
    }
  }, async (request) => {
    const { userId, episodeIds } = request.body as { userId: string; episodeIds: string[] };

    if (!episodeIds.length) {
      return { unlockedIds: [] };
    }

    const unlocks = await prisma.userEpisodeUnlock.findMany({
      where: { userId, episodeId: { in: episodeIds } },
      select: { episodeId: true },
    });

    return { unlockedIds: unlocks.map((u) => u.episodeId) };
  });

  app.post("/coins/users/bulk-balance", {
    schema: {
      body: z.object({
        userIds: z.array(z.string()).max(200),
      }),
    },
  }, async (request, reply) => {
    const { userIds } = request.body as { userIds: string[] };

    if (!userIds.length) return {};

    const [wallets, credits] = await Promise.all([
      prisma.userWallet.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, status: true },
      }),
      prisma.coinTransaction.groupBy({
        by: ["userId"],
        where: {
          userId: { in: userIds },
          type: "CREDIT",
          OR: [
            { expiryAt: { gt: new Date() } },
            { expiryAt: null },
          ],
        },
        _sum: { remainingAmount: true },
      }),
    ]);

    const walletMap = Object.fromEntries(wallets.map(w => [w.userId, w.status]));
    const balanceMap = Object.fromEntries(credits.map(c => [c.userId, c._sum.remainingAmount ?? 0]));

    const result: Record<string, { coinBalance: number; walletStatus: string }> = {};
    for (const userId of userIds) {
      result[userId] = {
        coinBalance: balanceMap[userId] ?? 0,
        walletStatus: walletMap[userId] ?? "ACTIVE",
      };
    }

    return result;
  });

  app.post("/coins/credit", {
    schema: {
      body: z.object({
        userId: z.string(),
        amount: z.number().int().positive(),
        source: z.nativeEnum(TransactionSource),
        referenceId: z.string().optional(),
        expiryDays: z.number().int().optional()
      })
    }
  }, async (request, reply) => {
    const { userId, amount, source, referenceId, expiryDays } = request.body as any;

    try {
      const transaction = await coinService.creditCoins({
        userId,
        amount,
        source: source as any,
        referenceId,
        expiryDays
      });
      return { success: true, transactionId: transaction.id };
    } catch (error) {
      request.log.error(error, "Failed to credit coins internally");
      return reply.code(500).send({ error: "Internal credit failed" });
    }
  });
}


