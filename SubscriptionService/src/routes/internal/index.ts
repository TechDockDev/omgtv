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
    const statsRows = await prisma.$queryRaw<any[]>`
      WITH UserPayments AS (
          SELECT 
              "userId",
              "amountPaise",
              "createdAt",
              SUM("amountPaise") OVER (PARTITION BY "userId" ORDER BY "createdAt") as cumulative_paid
          FROM "Transaction"
          WHERE "status" = 'SUCCESS'
      ),
      UserTotals AS (
          SELECT "userId", SUM("amountPaise") as total_paid
          FROM "Transaction"
          WHERE "status" = 'SUCCESS'
          GROUP BY "userId"
      ),
      TrialThresholds AS (
          SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
          UNION
          SELECT DISTINCT "userId" FROM UserPayments WHERE cumulative_paid < 9900
      ),
      ConversionCheck AS (
          SELECT DISTINCT "userId"
          FROM UserPayments
          WHERE cumulative_paid >= 9900
            AND "userId" IN (SELECT "userId" FROM TrialThresholds)
      ),
      UserStatus AS (
          SELECT DISTINCT ON ("userId") 
              "userId", "status", "endsAt"
          FROM "UserSubscription" 
          ORDER BY "userId", "createdAt" DESC
      ),
      DetailedData AS (
          SELECT 
              t."userId",
              CASE WHEN t.total_paid >= 9900 THEN 'SUBSCRIBER' ELSE 'TRIAL' END as category,
              CASE 
                  WHEN s."status" = 'ACTIVE' AND s."endsAt" >= NOW() THEN 'ACTIVE_WATCHING'
                  WHEN s."status" = 'TRIAL' AND s."endsAt" >= NOW() THEN 'ACTIVE_WATCHING'
                  WHEN s."status" = 'CANCELED' AND s."endsAt" >= NOW() THEN 'AUTOPAY_OFF_ACCESS'
                  WHEN s."status" = 'CANCELED' AND s."endsAt" < NOW() THEN 'EXPIRED_CANCELED'
                  WHEN s."status" = 'EXPIRED' THEN 'EXPIRED_BLOCKED'
                  ELSE 'EXPIRED_LEGACY'
              END as detailed_status,
              CASE WHEN c."userId" IS NOT NULL THEN 1 ELSE 0 END as is_conversion
          FROM UserTotals t
          LEFT JOIN UserStatus s ON t."userId" = s."userId"
          LEFT JOIN ConversionCheck c ON t."userId" = c."userId"
      )
      SELECT 
          category,
          detailed_status,
          is_conversion,
          COUNT(*)::int as user_count
      FROM DetailedData
      GROUP BY 1, 2, 3
    `;

    const result = {
      subscribers: { total: 0, active_watching: 0, autopay_off_access: 0, expired_blocked: 0, expired_canceled: 0 },
      trials: { total: 0, active_watching: 0, expired_blocked: 0, expired_canceled: 0 },
      conversions: { total: 0, active_watching: 0, autopay_off_access: 0, expired_blocked: 0, expired_canceled: 0 }
    };

    statsRows.forEach(row => {
      const count = row.user_count;
      
      // 1. Populate Subscriber/Trial buckets
      if (row.category === 'SUBSCRIBER') {
        result.subscribers.total += count;
        if (row.detailed_status === 'ACTIVE_WATCHING') result.subscribers.active_watching += count;
        else if (row.detailed_status === 'AUTOPAY_OFF_ACCESS') result.subscribers.autopay_off_access += count;
        else if (row.detailed_status === 'EXPIRED_BLOCKED') result.subscribers.expired_blocked += count;
        else if (row.detailed_status === 'EXPIRED_CANCELED') result.subscribers.expired_canceled += count;
      } else {
        result.trials.total += count;
        if (row.detailed_status === 'ACTIVE_WATCHING') result.trials.active_watching += count;
        else if (row.detailed_status === 'EXPIRED_BLOCKED') result.trials.expired_blocked += count;
        else if (row.detailed_status === 'EXPIRED_CANCELED') result.trials.expired_canceled += count;
      }

      // 2. Populate Conversion buckets
      if (row.is_conversion === 1) {
        result.conversions.total += count;
        if (row.detailed_status === 'ACTIVE_WATCHING') result.conversions.active_watching += count;
        else if (row.detailed_status === 'AUTOPAY_OFF_ACCESS') result.conversions.autopay_off_access += count;
        else if (row.detailed_status === 'EXPIRED_BLOCKED') result.conversions.expired_blocked += count;
        else if (row.detailed_status === 'EXPIRED_CANCELED') result.conversions.expired_canceled += count;
      }
    });

    return result;
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

    // Use the verified Master Truth logic for conversions
      const query = `
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
            -- Users who either have a recorded trial subscription OR at some point had < ₹99 total payments
            SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
            UNION
            SELECT DISTINCT "userId" FROM UserPayments WHERE cumulative_paid < 9900
        ),
        ConversionEvents AS (
            -- Find the exact timestamp when a user's cumulative payments first reached/exceeded ₹99
            SELECT 
                "userId",
                MIN("createdAt") as converted_at
            FROM UserPayments
            WHERE cumulative_paid >= 9900
              AND "userId" IN (SELECT "userId" FROM TrialThresholds)
            GROUP BY "userId"
        ),
        DetailedData AS (
            SELECT 
                ce."userId" AS "userId",
                'SUBSCRIBER (Converted)' AS "category",
                COALESCE(ls."status"::text, 'ACTIVE (Orphan)') AS "currentStatus",
                (SELECT SUM("amountPaise") FROM "Transaction" WHERE "userId" = ce."userId" AND "status" = 'SUCCESS') AS "totalPaidPaise",
                ce.converted_at AS "converted_at",
                COALESCE(ls."endsAt", ce.converted_at + interval '30 days') AS "endsAt",
                COALESCE(p."name", 'Premium') AS "planName"
            FROM ConversionEvents ce
            LEFT JOIN (
                SELECT DISTINCT ON ("userId") "userId", "status", "endsAt", "planId"
                FROM "UserSubscription"
                ORDER BY "userId", "createdAt" DESC
            ) ls ON ce."userId" = ls."userId"
            LEFT JOIN "SubscriptionPlan" p ON ls."planId" = p."id"
        )
        SELECT *, COUNT(*) OVER() as total_count
        FROM DetailedData
        WHERE 1=1
        ${status === 'active' ? 'AND "endsAt" > NOW()' : ''}
        ${status === 'expired' ? 'AND "endsAt" <= NOW()' : ''}
        ORDER BY converted_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const convertedUsers = await prisma.$queryRawUnsafe<any[]>(query);
      
      const summary = {
        total: 0,
        active_watching: 0,
        autopay_off_access: 0,
        expired: 0
      };

      convertedUsers.forEach(u => {
        const isExpired = new Date(u.endsAt) <= new Date();
        const isCanceled = u.currentStatus === 'CANCELED';
        
        if (isExpired) {
          summary.expired++;
        } else if (isCanceled) {
          summary.autopay_off_access++;
        } else {
          summary.active_watching++;
        }
      });

      const totalCount = convertedUsers.length > 0 ? Number(convertedUsers[0].total_count) : 0;
      summary.total = totalCount;

    return {
      userIds: convertedUsers.map(u => u.userId || u.User_ID || u.user_id),
      users: convertedUsers.map((u) => ({
        userId: u.userId || u.User_ID || u.user_id,
        convertedAt: u.converted_at,
        currentStatus: u.currentStatus,
        expiryStatus: new Date(u.endsAt) > new Date() ? 'ACTIVE' : 'EXPIRED',
        planName: u.planName,
        amountPaid: Number(u.totalPaidPaise || u.total_paid) / 100,
        endsAt: u.endsAt
      })),
      summary,
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


