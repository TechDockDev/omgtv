import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";

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
        status: "ACTIVE",
        endsAt: { gt: new Date() } // Ensure subscription hasn't expired
      },
      orderBy: { startsAt: "desc" },
      include: { plan: true },
    });

    if (subscription && subscription.plan) {
      return {
        allowed: true,
        planId: subscription.planId,
        status: subscription.status,
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
    const activeUserCount = await prisma.userSubscription.groupBy({
      by: ["userId"],
      where: { status: "ACTIVE", endsAt: { gt: new Date() } },
    }).then(res => res.length);

    const trialUserCount = await prisma.userSubscription.groupBy({
      by: ["userId"],
      where: { status: "TRIAL", endsAt: { gt: new Date() } },
    }).then(res => res.length);

    return {
      active_subscribers: activeUserCount,
      active_trials: trialUserCount,
    };
  });

  app.get("/subscriptions/active-users", {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().optional().default(100),
        offset: z.coerce.number().optional().default(0),
      }),
    },
  }, async (request) => {
    const { limit, offset } = request.query as { limit: number; offset: number };

    // Find users with ACTIVE status and end date in the future
    const subscriptions = await prisma.userSubscription.findMany({
      where: {
        status: "ACTIVE",
        endsAt: { gt: new Date() }
      },
      select: { userId: true },
      distinct: ['userId'],
      take: limit,
      skip: offset,
    });

    return { userIds: subscriptions.map(s => s.userId) };
  });
}
