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
    const now = new Date();
    
    // Fetch all relevant subscriptions to categorize by segment and expiry
    const allSubs = await prisma.userSubscription.findMany({
      where: {
        status: { in: ["ACTIVE", "CANCELED", "TRIAL", "EXPIRED"] },
      },
      select: {
        id: true,
        status: true,
        trialPlanId: true,
        endsAt: true,
        transaction: {
          select: {
            amountPaise: true
          }
        },
        planId: true,
        plan: {
          select: {
            name: true,
            pricePaise: true
          }
        }
      }
    });

    let active_subscribers = 0;
    let canceled_subscribers = 0;
    let expired_subscribers = 0;
    let active_trials = 0;
    let canceled_trials = 0;
    let expired_trials = 0;
    
    const plan_breakdown_map = new Map<string, { name: string; pricePaise: number; count: number }>();

    for (const sub of allSubs) {
        const amountPaid = sub.transaction?.amountPaise || 0;
        const planPrice = sub.plan?.pricePaise || 0;
        const isTrial = sub.trialPlanId !== null || (sub.planId && amountPaid < planPrice);
        const isExpired = new Date(sub.endsAt) < now || sub.status === "EXPIRED";

        if (isTrial) {
            if (isExpired) expired_trials++;
            else if (sub.status === "CANCELED") canceled_trials++;
            else active_trials++;
        } else {
            if (isExpired) expired_subscribers++;
            else {
                if (sub.status === "CANCELED") canceled_subscribers++;
                else active_subscribers++;

                // Plan Breakdown (Only for active/canceled real subscribers, i.e., non-expired)
                if (sub.planId && sub.plan) {
                    const existing = plan_breakdown_map.get(sub.planId) || { name: sub.plan.name, pricePaise: sub.plan.pricePaise, count: 0 };
                    existing.count++;
                    plan_breakdown_map.set(sub.planId, existing);
                }
            }
        }
    }

    const plan_breakdown = Array.from(plan_breakdown_map.values()).map(p => ({
      name: p.name,
      price: p.pricePaise / 100,
      count: p.count
    }));

    return {
      active_subscribers,
      canceled_subscribers,
      expired_subscribers,
      active_trials,
      canceled_trials,
      expired_trials,
      plan_breakdown,
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

    // To be truly "Smart", we must fetch transaction amounts too
    const subscriptions = await prisma.userSubscription.findMany({
      where: {
        status: { in: ["ACTIVE", "CANCELED"] },
        endsAt: { gt: new Date() },
      },
      include: {
        transaction: { select: { amountPaise: true } },
        plan: { select: { name: true, pricePaise: true } }
      },
      orderBy: { endsAt: 'desc' },
    });

    const filtered = subscriptions.filter(s => {
        // Must NOT be a trial (trialPlanId is null AND amount paid is full price)
        const amountPaid = s.transaction?.amountPaise || 0;
        const planPrice = s.plan?.pricePaise || 0;
        return s.trialPlanId === null && amountPaid >= planPrice;
    }).slice(0, limit);

    return { 
        users: filtered.map(s => ({ 
            userId: s.userId, 
            endsAt: s.endsAt,
            planName: s.plan?.name || "Premium"
        })) 
    };
  });

  app.get("/subscriptions/trial-users", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(10000),
      }),
    },
  }, async (request) => {
    const { limit } = request.query as { limit: number };

    const subscriptions = await prisma.userSubscription.findMany({
      where: {
        status: { in: ["ACTIVE", "TRIAL", "CANCELED"] },
        endsAt: { gt: new Date() },
      },
      include: {
        transaction: { select: { amountPaise: true } },
        plan: { select: { pricePaise: true } },
        trialPlan: { select: { durationDays: true } }
      },
      orderBy: { endsAt: 'desc' },
    });

    const filtered = subscriptions.filter(s => {
        // IS a trial if trialPlanId exists OR amount paid is low
        const amountPaid = s.transaction?.amountPaise || 0;
        const planPrice = s.plan?.pricePaise || 0;
        return s.trialPlanId !== null || (s.planId && amountPaid < planPrice);
    }).slice(0, limit);

    return { 
        users: filtered.map(s => ({ 
            userId: s.userId, 
            endsAt: s.endsAt,
            planName: s.trialPlan ? `Trial (${s.trialPlan.durationDays}d)` : "Trial"
        })) 
    };
  });

  // Users who previously had a trial and have since converted to a paid subscription
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

    // This query finds users who:
    // 1. Had a Trial (transaction amount 100/500 OR trialPlanId set)
    // 2. Later had a Full Subscription (transaction amount >= 9900)
    
    let statusFilter = '';
    if (status === 'active') {
        statusFilter = 'AND us."status" IN (\'ACTIVE\', \'CANCELED\') AND us."endsAt" > NOW()';
    } else if (status === 'expired') {
        statusFilter = 'AND (us."status" = \'EXPIRED\' OR us."endsAt" <= NOW())';
    }

    const convertedUsers = await prisma.$queryRaw<Array<{ 
        userId: string; 
        paidAt: Date; 
        currentStatus: string;
        endsAt: Date;
        planName: string;
        amountPaid: number;
    }>>`
      WITH TrialUsers AS (
        SELECT DISTINCT "userId" FROM "Transaction" WHERE "status" = 'SUCCESS' AND "amountPaise" IN (100, 500)
        UNION
        SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
      ),
      FullSubscribers AS (
        SELECT us."userId", MIN(us."startsAt") as "paidAt"
        FROM "UserSubscription" us
        JOIN "Transaction" t ON us."id" = t."subscriptionId" -- Link to transaction to verify price
        WHERE us."userId" IN (SELECT "userId" FROM TrialUsers)
        AND t."status" = 'SUCCESS'
        AND t."amountPaise" >= 9900
        GROUP BY us."userId"
      )
      SELECT 
        fs."userId", 
        fs."paidAt", 
        us."status" as "currentStatus", 
        us."endsAt",
        p."name" as "planName",
        t."amountPaise" as "amountPaid"
      FROM FullSubscribers fs
      JOIN "UserSubscription" us ON fs."userId" = us."userId"
      JOIN "Plan" p ON us."planId" = p."id"
      JOIN "Transaction" t ON us."id" = t."subscriptionId"
      WHERE us."startsAt" = (SELECT MAX("startsAt") FROM "UserSubscription" WHERE "userId" = fs."userId")
      ${statusFilter ? prisma.$queryRawUnsafe(statusFilter) : ''}
      ORDER BY fs."paidAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const totalResult = await prisma.$queryRaw<[{ count: bigint }]>`
      WITH TrialUsers AS (
        SELECT DISTINCT "userId" FROM "Transaction" WHERE "status" = 'SUCCESS' AND "amountPaise" IN (100, 500)
        UNION
        SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
      )
      SELECT COUNT(DISTINCT us."userId") AS count
      FROM "UserSubscription" us
      JOIN "Transaction" t ON us."id" = t."subscriptionId"
      WHERE us."userId" IN (SELECT "userId" FROM TrialUsers)
      AND t."status" = 'SUCCESS'
      AND t."amountPaise" >= 9900
    `;
    const total = Number(totalResult[0]?.count ?? 0);

    return {
      userIds: convertedUsers.map((u) => u.userId),
      users: convertedUsers.map((u) => ({
        userId: u.userId,
        convertedAt: u.paidAt,
        currentStatus: u.currentStatus,
        expiryStatus: new Date(u.endsAt) > new Date() ? 'ACTIVE' : 'EXPIRED',
        planName: u.planName,
        amountPaid: u.amountPaid / 100,
        endsAt: u.endsAt
      })),
      total,
      limit,
      offset,
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


