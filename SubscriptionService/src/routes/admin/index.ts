import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { getPrisma } from "../../lib/prisma";
import { getRazorpay } from "../../lib/razorpay";
import { fetchUserDetails } from "../../services/userService";
import { CoinService } from "../../services/coinService";
import { StreakService } from "../../services/streakService";
import { ContentClient } from "../../clients/content-client";
import { NotificationClient } from "../../clients/notification-client";
import { CoinTransactionType, TransactionSource, WalletStatus, StreakStatus } from "@prisma/client";
import { getRedis } from "../../lib/redis";
import { loadConfig } from "../../config";

const coinService = new CoinService();
const streakService = new StreakService();
const contentClient = new ContentClient();
const BUNDLES_CACHE_KEY = "coins:bundles:all";

const planBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  pricePaise: z.number().int().nonnegative(),
  currency: z.string().default("INR"),
  durationDays: z.number().int().positive(),
  reelsLimit: z.number().int().nonnegative().optional(),
  episodesLimit: z.number().int().nonnegative().optional(),
  seriesLimit: z.number().int().nonnegative().optional(),
  accessLevel: z.string().optional(),
  isUnlimitedReels: z.boolean().default(false),
  isUnlimitedEpisodes: z.boolean().default(false),
  isUnlimitedSeries: z.boolean().default(false),
  isActive: z.boolean().default(true),
  // New UI fields
  features: z.array(z.string()).default([]),
  isPopular: z.boolean().default(false),
  subscriberCount: z.number().int().nonnegative().default(0),
  icon: z.string().optional(),
  savings: z.number().int().nonnegative().default(0),
  cancelledPricePaise: z.number().int().nonnegative().optional(),
  subscriptionViaTrial: z.boolean().default(false),
  promoVideoUrl: z.string().url().nullable().optional(),
});

const planUpdateSchema = planBodySchema.partial();
const freePlanSchema = z.object({
  maxFreeReels: z.number().int().nonnegative(),
  maxFreeEpisodes: z.number().int().nonnegative(),
  maxFreeSeries: z.number().int().nonnegative(),
  adminId: z.string().uuid().optional(),
});

type PlanBody = z.infer<typeof planBodySchema>;
type PlanUpdateBody = z.infer<typeof planUpdateSchema>;
type FreePlanBody = z.infer<typeof freePlanSchema>;

const subscriptionSettingsSchema = z.object({
  promoVideoUrl: z.string().url().nullable().optional(),
  restrictRepeatTrials: z.boolean().optional(),
});

export default async function adminRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.post<{ Body: PlanBody }>(
    "/plans",
    {
      schema: {
        body: planBodySchema,
      },
    },
    async (request, reply) => {
      const body = planBodySchema.parse(request.body);

      const razorpay = getRazorpay();

      // Calculate period and interval
      // Simple logic: treat as monthly if multiple of 30, else daily
      let period: "daily" | "weekly" | "monthly" | "yearly" = "daily";
      let interval = body.durationDays;

      if (body.durationDays % 365 === 0) {
        period = "yearly";
        interval = body.durationDays / 365;
      } else if (body.durationDays % 30 === 0) {
        period = "monthly";
        interval = body.durationDays / 30;
      }

      let razorpayPlanId: string | undefined;

      try {
        const rzpPlan = await razorpay.plans.create({
          period,
          interval,
          item: {
            name: body.name,
            amount: body.pricePaise, // amount in smallest currency unit
            currency: body.currency,
            description: body.description || "Subscription Plan",
          },
        });
        razorpayPlanId = rzpPlan.id;
      } catch (error) {
        request.log.error(error, "Failed to create Razorpay plan");
        // Fail if Razorpay creation fails to maintain consistency
        return reply.status(502).send({ message: "Failed to create plan on Razorpay", error });
      }

      const plan = await prisma.subscriptionPlan.create({
        data: {
          ...body,
          razorpayPlanId
        },
      });
      return reply.code(201).send({
        success: true,
        statusCode: 201,
        userMessage: "Plan created successfully",
        developerMessage: "Subscription plan created",
        data: plan,
      });
    }
  );

  app.get("/plans", async () => {
    const data = await prisma.subscriptionPlan.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return {
      success: true,
      statusCode: 200,
      userMessage: "Plans retrieved successfully",
      developerMessage: "Admin plans retrieved",
      data,
    };
  });

  app.put<{ Params: { id: string }; Body: PlanUpdateBody }>(
    "/plans/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: planUpdateSchema,
      },
    },
    async (request, reply) => {
      const body = planUpdateSchema.parse(request.body);
      const { id } = request.params;

      const existingPlan = await prisma.subscriptionPlan.findUnique({
        where: { id },
      });

      if (!existingPlan) {
        return reply.status(404).send({ message: "Plan not found" });
      }

      let razorpayPlanId = existingPlan.razorpayPlanId;

      // Check if critical fields for Razorpay are changing
      const isPriceChanging =
        body.pricePaise !== undefined && body.pricePaise !== existingPlan.pricePaise;

      if (isPriceChanging) {
        const newPrice = body.pricePaise!;

        if (newPrice === 0) {
          // If price becomes 0, remove Razorpay association
          razorpayPlanId = null;
        } else {
          // If price is > 0, create a new Razorpay plan
          // Need to use new duration if provided, else existing
          const durationDays = body.durationDays ?? existingPlan.durationDays;
          const name = body.name ?? existingPlan.name;
          const description = body.description ?? existingPlan.description;
          const currency = body.currency ?? existingPlan.currency;

          // Recalculate period/interval
          let period: "daily" | "weekly" | "monthly" | "yearly" = "daily";
          let interval = durationDays;

          if (durationDays % 365 === 0) {
            period = "yearly";
            interval = durationDays / 365;
          } else if (durationDays % 30 === 0) {
            period = "monthly";
            interval = durationDays / 30;
          }

          const razorpay = getRazorpay();
          try {
            const rzpPlan = await razorpay.plans.create({
              period,
              interval,
              item: {
                name,
                amount: newPrice,
                currency,
                description: description || "Subscription Plan",
              },
            });
            razorpayPlanId = rzpPlan.id;
          } catch (error) {
            request.log.error(error, "Failed to create new Razorpay plan during update");
            return reply
              .status(502)
              .send({ message: "Failed to create plan on Razorpay", error });
          }
        }
      }

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: {
          ...body,
          razorpayPlanId,
        },
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: "Plan updated successfully",
        developerMessage: "Subscription plan updated",
        data: updatedPlan,
      };
    }
  );

  app.delete(
    "/plans/:id",
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const data = await prisma.subscriptionPlan.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });

      return {
        success: true,
        statusCode: 0,
        userMessage: "Plan deleted successfully",
        developerMessage: "Plan soft-deleted successfully",
        data,
      };
    }
  );

  const planStatusSchema = z.object({
    isActive: z.boolean(),
  });

  app.patch<{ Params: { id: string }; Body: z.infer<typeof planStatusSchema> }>(
    "/plans/:id/status",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: planStatusSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { isActive } = planStatusSchema.parse(request.body);

      const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
      if (!plan) {
        return reply.status(404).send({ message: "Plan not found" });
      }

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: { isActive },
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: "Plan status updated successfully",
        developerMessage: "Plan activity status changed",
        data: updatedPlan,
      };
    }
  );



  const trialPlanBodySchema = z.object({
    trialPricePaise: z.number().int().nonnegative(),
    cancelledTrialPricePaise: z.number().int().nonnegative().optional(),
    durationDays: z.number().int().positive(),
    reminderDays: z.number().int().nonnegative(),
    isAutoDebit: z.boolean().default(true),
    isActive: z.boolean().default(true),
  });
  const trialPlanUpdateSchema = trialPlanBodySchema.partial();

  app.post<{ Body: z.infer<typeof trialPlanBodySchema> }>(
    "/custom-trials",
    {
      schema: { body: trialPlanBodySchema },
    },
    async (request, reply) => {
      const body = trialPlanBodySchema.parse(request.body);

      if (body.isActive) {
        const existingActive = await prisma.trialPlan.findFirst({
          where: { isActive: true }
        });
        if (existingActive) {
          return reply.badRequest("An active trial plan already exists. Please modify the existing one or deactivate it first.");
        }
      }



      const trialPlan = await prisma.trialPlan.create({ data: body });
      return reply.code(201).send({
        success: true,
        statusCode: 0,
        userMessage: "Trial plan created successfully",
        developerMessage: "Trial plan created successfully",
        data: trialPlan,
      });
    }
  );


  app.get(
    "/stats",
    async (_request, reply) => {
      const now = new Date();

      const [
        revenueAgg,
        trialUsers,
        totalSubscribers,
        activeTrials,
        activeSubscribers,
        canceledTrials,
        canceledSubscriptions,
      ] = await Promise.all([
        // 1. Total Revenue
        prisma.transaction.aggregate({
          _sum: { amountPaise: true },
          where: { status: "SUCCESS" },
        }),
        // 2. Conversion Rate Base (Total uniquely ever on trial)
        prisma.userSubscription.findMany({
          where: { trialPlanId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
        }),
        // 3. Total Subscribers (Active Paid Users - Including Canceled but not Expired)
        prisma.userSubscription.count({
          where: {
            status: { in: ["ACTIVE", "CANCELED"] },
            trialPlanId: null,
            endsAt: { gt: now }
          },
        }),
        // 4. Active Trials — currently on trial and not expired
        prisma.userSubscription.count({
          where: {
            status: "TRIAL",
            trialPlanId: { not: null },
            endsAt: { gt: now },
          },
        }),
        // 5. Active Paid Subscribers (ACTIVE only, no canceled)
        prisma.userSubscription.count({
          where: {
            status: "ACTIVE",
            trialPlanId: null,
            endsAt: { gt: now },
          },
        }),
        // 6. Canceled Trials (user canceled their trial)
        prisma.userSubscription.count({
          where: {
            status: "CANCELED",
            trialPlanId: { not: null },
          },
        }),
        // 7. Canceled Subscriptions (user canceled their paid plan)
        prisma.userSubscription.count({
          where: {
            status: "CANCELED",
            trialPlanId: null,
          },
        }),
      ]);

      const totalRevenue = revenueAgg._sum.amountPaise || 0;
      const trialUserIds = trialUsers.map((u) => u.userId);

      let conversionRate = 0;
      let convertedCount = 0;

      if (trialUserIds.length > 0) {
        // Find how many of these users have bought a regular plan
        // A regular plan transaction must NOT have a trialPlanId
        const convertedUsers = await prisma.transaction.findMany({
          where: {
            userId: { in: trialUserIds },
            planId: { not: null },
            trialPlanId: null, // Crucial: Ensure this is not a trial purchase
            status: "SUCCESS",
          },
          select: { userId: true },
          distinct: ["userId"],
        });
        convertedCount = convertedUsers.length;
        conversionRate = (convertedCount / trialUserIds.length) * 100;
      }

      return {
        success: true,
        statusCode: 200,
        userMessage: "Stats retrieved successfully",
        developerMessage: "Transaction stats including revenue, conversion rate, subscribers, and trials",
        data: {
          totalRevenue,
          conversionRate,
          trialUsersCount: trialUserIds.length,
          convertedUsersCount: convertedCount,
          totalSubscribers,
          activeTrials,
          activeSubscribers,
          canceledTrials,
          canceledSubscriptions,
        },
      };
    }
  );

  app.get<{ Querystring: { page?: number; limit?: number } }>(
    "/trial-users",
    {
      schema: {
        querystring: z.object({
          page: z.coerce.number().min(1).default(1),
          limit: z.coerce.number().min(1).max(100).default(10),
        }),
      },
    },
    async (request) => {
      const { page = 1, limit = 10 } = request.query;
      const skip = (page - 1) * limit;

      const [total, data] = await Promise.all([
        prisma.userSubscription.count({
          where: { trialPlanId: { not: null } },
        }),
        prisma.userSubscription.findMany({
          where: { trialPlanId: { not: null } },
          include: {
            trialPlan: true,
            plan: true,
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      const userIds = data.map((sub) => sub.userId);
      const userMap = await fetchUserDetails(userIds);

      return {
        success: true,
        statusCode: 200,
        userMessage: "Trial users retrieved successfully",
        developerMessage: "Paginated list of trial users",
        data: {
          items: data.map((sub) => {
            const user = userMap.get(sub.userId);
            return {
              id: sub.id,
              user: user || { id: sub.userId, name: "Unknown", email: "", phoneNumber: "" },
              trialPlan: sub.trialPlan
                ? {
                  id: sub.trialPlan.id,
                  trialPricePaise: sub.trialPlan.trialPricePaise,
                  durationDays: sub.trialPlan.durationDays,
                  isAutoDebit: sub.trialPlan.isAutoDebit,
                }
                : null,
              status: sub.status,
              startsAt: sub.startsAt,
              endsAt: sub.endsAt,
            };
          }),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
      };
    }
  );

  // GET /admin/canceled-users — list users who canceled their trial or subscription
  const canceledUsersQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10),
    type: z.enum(["trial", "subscription", "all"]).default("all"),
  });

  app.get(
    "/canceled-users",
    {
      schema: { querystring: canceledUsersQuerySchema },
    },
    async (request) => {
      const { page, limit, type } = request.query as z.infer<typeof canceledUsersQuerySchema>;
      const skip = (page - 1) * limit;

      // 1. Get all users with CANCELED status
      const allCanceled = await prisma.userSubscription.findMany({
        where: { status: "CANCELED" },
        include: {
          plan: true,
          trialPlan: true,
          transaction: true
        },
        orderBy: { updatedAt: "desc" },
      });

      // 2. Fetch cumulative paid per user to detect conversions (trial → paid)
      const allUserIds = [...new Set(allCanceled.map(s => s.userId))];
      const cumulativePayments = await prisma.transaction.groupBy({
        by: ['userId'],
        where: { userId: { in: allUserIds }, status: 'SUCCESS', trialPlanId: null },
        _sum: { amountPaise: true }
      });
      const cumulativeMap = new Map(cumulativePayments.map(p => [p.userId, p._sum.amountPaise ?? 0]));

      const hadTrialUsers = await prisma.userSubscription.findMany({
        where: { userId: { in: allUserIds }, trialPlanId: { not: null } },
        select: { userId: true },
        distinct: ['userId']
      });
      const hadTrialSet = new Set(hadTrialUsers.map(u => u.userId));

      // 3. Categorize using the specific transaction linked to this subscription (matches SQL audit logic)
      const categorized = allCanceled.map(sub => {
        const isTrial = sub.trialPlanId !== null || (sub.transaction?.amountPaise ?? 0) < 9900;
        const isConverted = hadTrialSet.has(sub.userId) && (cumulativeMap.get(sub.userId) ?? 0) >= 9900;
        return { sub, isTrial, isConverted };
      });

      let filteredData = categorized;
      if (type === "trial") filteredData = categorized.filter(c => c.isTrial);
      else if (type === "subscription") filteredData = categorized.filter(c => !c.isTrial);

      const total = filteredData.length;
      const pageData = filteredData.slice(skip, skip + limit);

      // 4. Fetch user details
      const userIds = [...new Set(pageData.map(c => c.sub.userId))];
      const userMap = await fetchUserDetails(userIds);

      const now = new Date();

      const items = pageData.map(({ sub, isTrial, isConverted }) => {
        const user = userMap.get(sub.userId);
        const paidPaise = sub.transaction?.amountPaise ?? 0;
        const hasAccess = sub.endsAt ? sub.endsAt > now : false;
        const daysRemaining = sub.endsAt
          ? Math.max(0, Math.ceil((sub.endsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
          : 0;

        return {
          id: sub.id,
          userId: sub.userId,
          user: user
            ? { id: sub.userId, name: user.name, email: user.email, phone: user.phoneNumber }
            : { id: sub.userId, name: "Unknown", email: "", phone: "" },
          cancelType: isTrial ? "trial" : "subscription",
          isConverted,
          hasAccess,
          daysRemaining,
          plan: sub.plan,
          trialPlan: sub.trialPlan,
          razorpaySubscriptionId: sub.razorpayOrderId,
          status: sub.status,
          startsAt: sub.startsAt,
          endsAt: sub.endsAt,
          createdAt: sub.createdAt,
          canceledAt: sub.updatedAt,
          paidPaise,
        };
      });

      return {
        success: true,
        statusCode: 200,
        userMessage: "Canceled users retrieved successfully",
        developerMessage: "List of users who canceled their trial or subscription",
        data: {
          items,
          stats: {
            total: categorized.length,
            trial: categorized.filter(c => c.isTrial && !c.isConverted).length,
            trialExpired: categorized.filter(c => c.isTrial && !c.isConverted && c.sub.endsAt && c.sub.endsAt <= now).length,
            subscription: categorized.filter(c => !c.isTrial && !c.isConverted).length,
            subscriptionExpired: categorized.filter(c => !c.isTrial && !c.isConverted && c.sub.endsAt && c.sub.endsAt <= now).length,
            converted: categorized.filter(c => c.isConverted).length,
            convertedExpired: categorized.filter(c => c.isConverted && c.sub.endsAt && c.sub.endsAt <= now).length,
          },
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
      };
    }
  );

  // PATCH /admin/custom-trials/:id/status — activate or deactivate without touching other fields
  app.patch(
    "/custom-trials/:id/status",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ isActive: z.boolean() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { isActive } = request.body as { isActive: boolean };

      const existing = await prisma.trialPlan.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Trial plan not found" });

      if (isActive) {
        const otherActive = await prisma.trialPlan.findFirst({
          where: { isActive: true, id: { not: id } },
        });
        if (otherActive) {
          return reply.badRequest("Another trial plan is already active. Deactivate it first.");
        }
      }

      const updated = await prisma.trialPlan.update({
        where: { id },
        data: { isActive },
      });

      return { success: true, data: updated };
    }
  );

  app.get("/custom-trials", async () => {
    const data = await prisma.trialPlan.findMany({
      orderBy: { createdAt: "desc" },
    });
    return {
      success: true,
      statusCode: 0,
      userMessage: "Trial plans retrieved successfully",
      developerMessage: "Trial plans retrieved successfully",
      data,
    };
  });

  app.put<{ Params: { id: string }; Body: z.infer<typeof trialPlanUpdateSchema> }>(
    "/custom-trials/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: trialPlanUpdateSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = trialPlanUpdateSchema.parse(request.body);

      const existing = await prisma.trialPlan.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ message: "Trial plan not found" });
      }

      if (body.isActive === true) {
        // If attempting to activate, check if another one is already active (excluding self)
        const existingActive = await prisma.trialPlan.findFirst({
          where: {
            isActive: true,
            id: { not: id }
          }
        });
        if (existingActive) {
          return reply.badRequest("Another trial plan is already active. Only one active trial plan is allowed.");
        }
      }




      const updated = await prisma.trialPlan.update({
        where: { id },
        data: body,
      });
      return {
        success: true,
        statusCode: 0,
        userMessage: "Trial plan updated successfully",
        developerMessage: "Trial plan updated successfully",
        data: updated,
      };
    }
  );

  const paginationSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10),
  });

  app.get(
    "/transactions",
    {
      schema: { querystring: paginationSchema },
    },
    async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationSchema>;
      const skip = (page - 1) * limit;

      const [total, data] = await Promise.all([
        prisma.transaction.count(),
        prisma.transaction.findMany({
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      return {
        success: true,
        statusCode: 200,
        userMessage: "Transactions retrieved successfully",
        developerMessage: "Transactions retrieved with pagination",
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    }
  );

  // GET /admin/all-transactions — unified ledger of all real-money transactions
  const emptyToUndefined = z.string().transform(v => v === "" ? undefined : v);

  const allTxQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    type: emptyToUndefined.pipe(z.enum(["subscription", "coin_purchase"]).optional()).optional(),
    status: emptyToUndefined.pipe(z.enum(["SUCCESS", "PENDING", "FAILED", "CREATED"]).optional()).optional(),
    provider: emptyToUndefined.pipe(z.enum(["razorpay", "phonepe"]).optional()).optional(),
    search: emptyToUndefined.optional(),
    startDate: emptyToUndefined.optional(),
    endDate: emptyToUndefined.optional(),
  });

  app.get(
    "/all-transactions",
    { schema: { querystring: allTxQuerySchema } },
    async (request) => {
      const { page, limit, type, status, provider, search, startDate, endDate } = request.query as z.infer<typeof allTxQuerySchema>;
      const skip = (page - 1) * limit;

      // Date range — start of startDate day to end of endDate day
      // Use IST (UTC+5:30) for date boundaries to match Razorpay dashboard
      const dateFilter = (startDate || endDate) ? {
        gte: startDate ? new Date(`${startDate}T00:00:00.000+05:30`) : undefined,
        lte: endDate ? new Date(`${endDate}T23:59:59.999+05:30`) : undefined,
      } : undefined;

      // 1. Build DB-level filters for each table
      const subWhere: any = {};
      if (status && ["SUCCESS", "PENDING", "FAILED"].includes(status)) subWhere.status = status;
      if (provider) subWhere.provider = provider;
      if (search) subWhere.userId = { contains: search };
      if (dateFilter) subWhere.createdAt = dateFilter;

      const coinWhere: any = {};
      if (status && ["SUCCESS", "CREATED", "FAILED"].includes(status)) coinWhere.status = status;
      if (search) coinWhere.userId = { contains: search };
      if (dateFilter) coinWhere.createdAt = dateFilter;

      // Stats only change by date range — search is a per-user lookup, not a global stat
      const statsBase = {
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      };

      // 2. Fetch page data, counts, and stats all in parallel
      const [subCount, coinCount, subTxs, coinTxs, subStats, coinStats] = await Promise.all([
        type === "coin_purchase" ? Promise.resolve(0) : prisma.transaction.count({ where: subWhere }),
        type === "subscription" ? Promise.resolve(0) : prisma.userCoinPurchase.count({ where: coinWhere }),
        type === "coin_purchase" ? Promise.resolve([]) : prisma.transaction.findMany({
          where: subWhere,
          include: {
            plan: { select: { name: true, durationDays: true, currency: true } },
            trialPlan: { select: { durationDays: true, trialPricePaise: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: skip + limit,
        }),
        type === "subscription" ? Promise.resolve([]) : prisma.userCoinPurchase.findMany({
          where: coinWhere,
          orderBy: { updatedAt: "desc" },
          take: skip + limit,
        }),
        // Stats — group by status for subscription payments
        prisma.transaction.groupBy({
          by: ["status"],
          where: statsBase,
          _sum: { amountPaise: true },
          _count: { id: true },
        }),
        // Stats — group by status for coin purchases
        prisma.userCoinPurchase.groupBy({
          by: ["status"],
          where: statsBase,
          _sum: { amountPaid: true },
          _count: { id: true },
        }),
      ]);

      // 3. Enrich coin purchases with bundle details
      const bundleIds = [...new Set((coinTxs as any[]).map((tx) => tx.bundleId))];
      const bundles = bundleIds.length
        ? await prisma.coinBundle.findMany({ where: { id: { in: bundleIds } } })
        : [];
      const bundleMap = new Map(bundles.map((b) => [b.id, b]));

      // 4. Merge, sort by createdAt desc, take the requested page slice
      const merged = [
        ...(subTxs as any[]).map((tx) => {
          const isTrial = !!tx.trialPlanId;
          return {
            _sortDate: tx.updatedAt,
            userId: tx.userId,
            id: tx.id,
            type: "subscription",
            provider: tx.provider,
            subscriptionKind: isTrial ? "trial" : "premium",
            status: tx.status,
            amountPaise: tx.amountPaise,
            currency: tx.currency ?? "INR",
            plan: tx.plan
              ? { name: tx.plan.name, durationDays: tx.plan.durationDays }
              : null,
            trialPlan: tx.trialPlan
              ? { durationDays: tx.trialPlan.durationDays, pricePaise: tx.trialPlan.trialPricePaise }
              : null,
            paymentId: tx.razorpayPaymentId ?? null,
            subscriptionId: tx.subscriptionId ?? null,
            failureReason: tx.failureReason ?? null,
            createdAt: tx.createdAt,
            updatedAt: tx.updatedAt,
          };
        }),
        ...(coinTxs as any[]).map((tx) => {
          const bundle = bundleMap.get(tx.bundleId);
          return {
            _sortDate: tx.updatedAt,
            userId: tx.userId,
            id: tx.id,
            type: "coin_purchase",
            status: tx.status,
            amountPaise: tx.amountPaid,
            currency: bundle?.currency ?? "INR",
            coins: tx.coins,
            bundle: bundle ? { title: bundle.title, coins: bundle.coins } : null,
            paymentId: tx.paymentId ?? null,
            orderId: tx.orderId ?? null,
            createdAt: tx.createdAt,
            updatedAt: tx.updatedAt,
          };
        }),
      ]
        .sort((a, b) => b._sortDate.getTime() - a._sortDate.getTime())
        .slice(skip, skip + limit);

      // 5. Enrich only the current page with user details
      const userIds = [...new Set(merged.map((tx) => tx.userId))];
      const userMap = await fetchUserDetails(userIds);

      const data = merged.map(({ _sortDate, ...tx }) => ({
        ...tx,
        user: userMap.get(tx.userId)
          ? {
            id: tx.userId,
            name: userMap.get(tx.userId)!.name,
            email: userMap.get(tx.userId)!.email,
            phone: userMap.get(tx.userId)!.phoneNumber,
          }
          : { id: tx.userId },
      }));

      // Compute stats from groupBy results
      const subByStatus = Object.fromEntries(subStats.map((s) => [s.status, { count: s._count.id, revenuePaise: s._sum.amountPaise ?? 0 }]));
      const coinByStatus = Object.fromEntries(coinStats.map((s) => [s.status, { count: s._count.id, revenuePaise: s._sum.amountPaid ?? 0 }]));

      const subSuccessRevenue = subByStatus["SUCCESS"]?.revenuePaise ?? 0;
      const coinSuccessRevenue = coinByStatus["SUCCESS"]?.revenuePaise ?? 0;

      const stats = {
        totalRevenuePaise: subSuccessRevenue + coinSuccessRevenue,
        subscriptionRevenuePaise: subSuccessRevenue,
        coinPurchaseRevenuePaise: coinSuccessRevenue,
        byType: {
          subscription: subStats.reduce((sum, s) => sum + s._count.id, 0),
          coin_purchase: coinStats.reduce((sum, s) => sum + s._count.id, 0),
        },
        byStatus: {
          SUCCESS: (subByStatus["SUCCESS"]?.count ?? 0) + (coinByStatus["SUCCESS"]?.count ?? 0),
          PENDING: (subByStatus["PENDING"]?.count ?? 0) + (coinByStatus["PENDING"]?.count ?? 0),
          FAILED: (subByStatus["FAILED"]?.count ?? 0) + (coinByStatus["FAILED"]?.count ?? 0),
          CREATED: coinByStatus["CREATED"]?.count ?? 0,
        },
      };

      return {
        success: true,
        stats,
        data,
        pagination: {
          total: subCount + coinCount,
          page,
          limit,
          totalPages: Math.ceil((subCount + coinCount) / limit),
        },
      };
    }
  );

  app.get(
    "/users/:userId/subscription",
    {
      schema: { params: z.object({ userId: z.string() }) },
    },
    async (request) => {
      const { userId } = request.params as { userId: string };
      const data = await prisma.userSubscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { plan: true, transaction: true },
      });
      return {
        success: true,
        statusCode: 200,
        userMessage: "User subscription retrieved successfully",
        developerMessage: "Admin user subscription details",
        data,
      };
    }
  );

  app.get("/settings", async () => {
    const config = await (prisma as any).subscriptionGlobalConfig.findFirst({
      where: { id: 1 }
    });
    return {
      success: true,
      statusCode: 200,
      userMessage: "Settings retrieved successfully",
      developerMessage: "Global subscription settings retrieved",
      data: config || { id: 1, promoVideoUrl: null }
    };
  });

  app.put<{ Body: z.infer<typeof subscriptionSettingsSchema> }>(
    "/settings",
    {
      schema: { body: subscriptionSettingsSchema }
    },
    async (request) => {
      const { promoVideoUrl, restrictRepeatTrials } = request.body;
      const config = await (prisma as any).subscriptionGlobalConfig.upsert({
        where: { id: 1 },
        update: { promoVideoUrl, ...(restrictRepeatTrials !== undefined && { restrictRepeatTrials }) },
        create: { id: 1, promoVideoUrl, restrictRepeatTrials: restrictRepeatTrials ?? false }
      });
      return {
        success: true,
        statusCode: 200,
        userMessage: "Settings updated successfully",
        developerMessage: "Global subscription settings updated",
        data: config
      };
    }
  );

  // --- Coin Bundle Admin Routes ---

  const coinBundleSchema = z.object({
    title: z.string().min(1),
    coins: z.number().int().positive(),
    price: z.number().int().nonnegative(),
    currency: z.string().default("INR"),
    active: z.boolean().default(true),
  });

  app.post<{ Body: z.infer<typeof coinBundleSchema> }>(
    "/coins/bundles",
    { schema: { body: coinBundleSchema } },
    async (request, reply) => {
      const body = coinBundleSchema.parse(request.body);
      const bundle = await prisma.coinBundle.create({ data: body });
      await getRedis().del(BUNDLES_CACHE_KEY).catch(() => { });
      return reply.code(201).send({
        success: true,
        userMessage: "Coin bundle created successfully",
        data: bundle,
      });
    }
  );

  app.get("/coins/bundles", async () => {
    const bundles = await prisma.coinBundle.findMany({ orderBy: { price: "asc" } });
    return { success: true, data: bundles };
  });

  // PUT /admin/coins/bundles/:id — edit all fields
  app.put<{ Params: { id: string }; Body: z.infer<typeof coinBundleSchema> }>(
    "/coins/bundles/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: coinBundleSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await prisma.coinBundle.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Coin bundle not found" });
      }
      const bundle = await prisma.coinBundle.update({
        where: { id },
        data: request.body,
      });
      await getRedis().del(BUNDLES_CACHE_KEY).catch(() => { });
      return { success: true, userMessage: "Coin bundle updated successfully", data: bundle };
    }
  );

  // PATCH /admin/coins/bundles/:id — toggle active only
  app.patch<{ Params: { id: string }; Body: { active: boolean } }>(
    "/coins/bundles/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ active: z.boolean() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { active } = request.body;
      const existing = await prisma.coinBundle.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Coin bundle not found" });
      }
      const bundle = await prisma.coinBundle.update({ where: { id }, data: { active } });
      await getRedis().del(BUNDLES_CACHE_KEY).catch(() => { });
      return {
        success: true,
        userMessage: `Coin bundle ${active ? "activated" : "deactivated"} successfully`,
        data: bundle,
      };
    }
  );

  // DELETE /admin/coins/bundles/:id
  app.delete<{ Params: { id: string } }>(
    "/coins/bundles/:id",
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await prisma.coinBundle.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: "Coin bundle not found" });
      }
      await prisma.coinBundle.delete({ where: { id } });
      await getRedis().del(BUNDLES_CACHE_KEY).catch(() => { });
      return { success: true, userMessage: "Coin bundle deleted successfully" };
    }
  );

  app.get("/coins/purchases", {
    schema: { querystring: paginationSchema },
  }, async (request) => {
    const { page, limit } = request.query as z.infer<typeof paginationSchema>;
    const skip = (page - 1) * limit;

    const [total, purchases] = await Promise.all([
      prisma.userCoinPurchase.count(),
      prisma.userCoinPurchase.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const userIds = [...new Set(purchases.map(p => p.userId))];
    const userMap = await fetchUserDetails(userIds);

    const data = purchases.map(p => ({
      ...p,
      user: userMap.get(p.userId) ?? null,
    }));

    return {
      success: true,
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  // --- Admin Coin User Management ---

  // GET /admin/coins/users/:userId/wallet  — balance + wallet status
  app.get<{ Params: { userId: string } }>(
    "/coins/users/:userId/wallet",
    { schema: { params: z.object({ userId: z.string() }) } },
    async (request, reply) => {
      const { userId } = request.params;
      const [balance, wallet] = await Promise.all([
        coinService.getBalance(userId),
        prisma.userWallet.findUnique({ where: { userId } }),
      ]);
      return {
        success: true,
        data: {
          userId,
          balance,
          status: wallet?.status ?? "ACTIVE",
          walletExists: !!wallet,
        },
      };
    }
  );

  // PATCH /admin/coins/users/:userId/wallet  — block or unblock wallet
  app.patch<{ Params: { userId: string }; Body: { status: WalletStatus } }>(
    "/coins/users/:userId/wallet",
    {
      schema: {
        params: z.object({ userId: z.string() }),
        body: z.object({ status: z.nativeEnum(WalletStatus) }),
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const { status } = request.body;
      const wallet = await prisma.userWallet.upsert({
        where: { userId },
        update: { status },
        create: { userId, status },
      });
      return { success: true, data: wallet };
    }
  );

  // POST /admin/coins/users/:userId/credit  — manually credit coins
  app.post<{ Params: { userId: string }; Body: { amount: number; note?: string } }>(
    "/coins/users/:userId/credit",
    {
      schema: {
        params: z.object({ userId: z.string() }),
        body: z.object({
          amount: z.number().int().positive(),
          note: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const { amount, note } = request.body;
      const referenceId = `admin-credit:${userId}:${crypto.randomUUID()}`;
      const tx = await coinService.creditCoins({
        userId,
        amount,
        source: TransactionSource.ADMIN,
        referenceId,
      });
      const newBalance = await coinService.getBalance(userId);
      return { success: true, data: { transaction: tx, newBalance, note } };
    }
  );

  // POST /admin/coins/users/:userId/debit  — manually debit coins
  app.post<{ Params: { userId: string }; Body: { amount: number; note?: string } }>(
    "/coins/users/:userId/debit",
    {
      schema: {
        params: z.object({ userId: z.string() }),
        body: z.object({
          amount: z.number().int().positive(),
          note: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const { amount, note } = request.body;
      const referenceId = `admin-debit:${userId}:${crypto.randomUUID()}`;
      try {
        const tx = await coinService.debitCoins(userId, amount, referenceId);
        const newBalance = await coinService.getBalance(userId);
        return { success: true, data: { transaction: tx, newBalance, note } };
      } catch (err: any) {
        if (err.message === "Insufficient coin balance") {
          return reply.code(402).send({ error: "Insufficient coin balance" });
        }
        throw err;
      }
    }
  );

  // GET /admin/coins/users/:userId/transactions  — full enriched history for one user
  app.get<{ Params: { userId: string } }>(
    "/coins/users/:userId/transactions",
    {
      schema: {
        params: z.object({ userId: z.string() }),
        querystring: z.object({
          type: z.string().optional().transform(v => v === '' ? undefined : v).pipe(z.enum(["credit", "earned", "debit", "admin_credit", "admin_debit"]).optional()),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        }),
      },
    },
    async (request) => {
      const { userId } = request.params;
      const { type, page, limit } = request.query as {
        type?: "credit" | "earned" | "debit" | "admin_credit" | "admin_debit";
        page: number;
        limit: number;
      };
      const skip = (page - 1) * limit;

      const typeWhere =
        type === "credit"
          ? { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE }
          : type === "earned"
            ? { type: CoinTransactionType.CREDIT, source: TransactionSource.AD }
            : type === "debit"
              ? { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK }
              : type === "admin_credit"
                ? { type: CoinTransactionType.CREDIT, source: TransactionSource.ADMIN }
                : type === "admin_debit"
                  ? { type: CoinTransactionType.DEBIT, source: TransactionSource.ADMIN }
                  : {}; // no filter → all transactions

      const where = { userId, ...typeWhere };

      const [total, txs] = await Promise.all([
        prisma.coinTransaction.count({ where }),
        prisma.coinTransaction.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      // Enrich PURCHASE credits with bundle/payment info
      const buyTxs = txs.filter(
        (tx) => tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE
      );
      const orderIds = buyTxs.map((tx) => tx.referenceId).filter(Boolean) as string[];

      // Enrich UNLOCK debits with episode info
      const unlockTxs = txs.filter(
        (tx) => tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK
      );
      const episodeIds = unlockTxs
        .map((tx) => tx.referenceId?.split(":")?.[2])
        .filter(Boolean) as string[];

      const [purchases, episodeDetails] = await Promise.all([
        orderIds.length
          ? prisma.userCoinPurchase.findMany({ where: { orderId: { in: orderIds } } })
          : Promise.resolve([]),
        episodeIds.length ? contentClient.getEpisodesBatch(episodeIds) : Promise.resolve([]),
      ]);

      const bundleIds = [...new Set(purchases.map((p) => p.bundleId))];
      const bundles = bundleIds.length
        ? await prisma.coinBundle.findMany({ where: { id: { in: bundleIds } } })
        : [];

      const purchaseMap = new Map(purchases.map((p) => [p.orderId, p]));
      const bundleMap = new Map(bundles.map((b) => [b.id, b]));
      const episodeMap = new Map(episodeDetails.map((ep: any) => [ep.id, ep]));

      const now = new Date();

      const data = txs.map((tx) => {
        const base = { id: tx.id, createdAt: tx.createdAt };

        // Purchased coins
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE) {
          const purchase = purchaseMap.get(tx.referenceId ?? "");
          const bundle = purchase ? bundleMap.get(purchase.bundleId) : null;
          return {
            ...base,
            transactionType: "credit" as const,
            coins: tx.amount,
            payment: purchase
              ? {
                orderId: purchase.orderId,
                paymentId: purchase.paymentId,
                amountPaid: purchase.amountPaid,
                currency: bundle?.currency ?? "INR",
                status: purchase.status,
              }
              : null,
            bundle: bundle
              ? { title: bundle.title, coins: bundle.coins, price: bundle.price, currency: bundle.currency }
              : null,
          };
        }

        // Earned coins (from watching ads)
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.AD) {
          const isExpired = tx.expiryAt ? tx.expiryAt <= now : false;
          return {
            ...base,
            transactionType: "earned" as const,
            coins: tx.amount,
            remainingCoins: tx.remainingAmount ?? 0,
            expiresAt: tx.expiryAt ?? null,
            expired: isExpired,
          };
        }

        // Admin-credited coins
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.ADMIN) {
          return {
            ...base,
            transactionType: "admin_credit" as const,
            coins: tx.amount,
          };
        }

        // Episode unlock spend
        if (tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK) {
          const episodeId = tx.referenceId?.split(":")?.[2] ?? null;
          const ep = episodeId ? episodeMap.get(episodeId) : null;
          return {
            ...base,
            transactionType: "debit" as const,
            coinsSpent: Math.abs(tx.amount),
            episode: ep
              ? { id: episodeId, title: ep.title, thumbnail: ep.thumbnail, seriesName: ep.seriesTitle }
              : { id: episodeId },
          };
        }

        // Streak daily coins
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.STREAK) {
          return {
            ...base,
            transactionType: "streak" as const,
            coins: tx.amount,
            remainingCoins: tx.remainingAmount ?? 0,
            expiresAt: tx.expiryAt ?? null,
          };
        }

        // Streak milestone bonus
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.STREAK_BONUS) {
          return {
            ...base,
            transactionType: "streak_bonus" as const,
            coins: tx.amount,
            remainingCoins: tx.remainingAmount ?? 0,
            expiresAt: tx.expiryAt ?? null,
          };
        }

        // Admin-deducted coins
        return {
          ...base,
          transactionType: "admin_debit" as const,
          coinsSpent: Math.abs(tx.amount),
        };
      });

      return {
        success: true,
        data,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // GET /admin/coins/episode-unlocks  — which users unlocked which episodes
  app.get(
    "/coins/episode-unlocks",
    {
      schema: {
        querystring: z.object({
          episodeId: z.string().uuid().optional(),
          userId: z.string().optional(),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        }),
      },
    },
    async (request) => {
      const { episodeId, userId, page, limit } = request.query as {
        episodeId?: string;
        userId?: string;
        page: number;
        limit: number;
      };
      const skip = (page - 1) * limit;

      const where = {
        ...(episodeId ? { episodeId } : {}),
        ...(userId ? { userId } : {}),
      };

      const [total, unlocks] = await Promise.all([
        prisma.userEpisodeUnlock.count({ where }),
        prisma.userEpisodeUnlock.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
      ]);

      // Fetch coins spent per unlock from debit transactions
      const referenceIds = unlocks.map((u) => `unlock:${u.userId}:${u.episodeId}`);
      const debitTxs = referenceIds.length
        ? await prisma.coinTransaction.findMany({
          where: { referenceId: { in: referenceIds } },
          select: { referenceId: true, amount: true },
        })
        : [];
      const spentMap = new Map(debitTxs.map((tx) => [tx.referenceId, Math.abs(tx.amount)]));

      // Fetch episode details
      const episodeIds = [...new Set(unlocks.map((u) => u.episodeId))];
      const episodeDetails = episodeIds.length ? await contentClient.getEpisodesBatch(episodeIds) : [];
      const episodeMap = new Map(episodeDetails.map((ep: any) => [ep.id, ep]));

      // Fetch user details + balances
      const userIds = [...new Set(unlocks.map((u) => u.userId))];
      const [userMap, balances] = await Promise.all([
        fetchUserDetails(userIds),
        Promise.all(userIds.map(async id => ({ id, balance: await coinService.getBalance(id) }))),
      ]);
      const balanceMap = new Map(balances.map(b => [b.id, b.balance]));

      const data = unlocks.map((u) => {
        const ep = episodeMap.get(u.episodeId);
        const user = userMap.get(u.userId);
        const refId = `unlock:${u.userId}:${u.episodeId}`;
        return {
          id: u.id,
          unlockedAt: u.createdAt,
          coinsSpent: spentMap.get(refId) ?? null,
          remainingBalance: balanceMap.get(u.userId) ?? 0,
          user: user
            ? { id: u.userId, name: user.name, email: user.email, phoneNumber: user.phoneNumber }
            : { id: u.userId },
          episode: ep
            ? { id: u.episodeId, title: ep.title, thumbnail: ep.thumbnail, seriesName: ep.seriesTitle }
            : { id: u.episodeId },
        };
      });

      return {
        success: true,
        data,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // ── Ad Coin Config ─────────────────────────────────────────────────────────

  // GET /admin/coins/ad-config
  app.get("/coins/ad-config", async () => {
    const config = await coinService.getAdCoinConfig();
    return { success: true, data: config };
  });

  // PATCH /admin/coins/ad-config
  app.patch(
    "/coins/ad-config",
    {
      schema: {
        body: z.object({
          isEnabled: z.boolean().optional(),
          coinsPerAd: z.number().int().positive().optional(),
          dailyLimit: z.number().int().positive().optional(),
          expiryHours: z.number().int().positive().nullable().optional(),
        }),
      },
    },
    async (request) => {
      const adminId = request.headers["x-admin-id"] as string | undefined;
      const body = request.body as {
        isEnabled?: boolean;
        coinsPerAd?: number;
        dailyLimit?: number;
        expiryHours?: number | null;
      };

      const config = await prisma.adCoinConfig.upsert({
        where: { id: 1 },
        create: {
          ...body,
          updatedByAdminId: adminId,
        },
        update: {
          ...body,
          updatedByAdminId: adminId,
        },
      });

      return { success: true, data: config };
    }
  );

  // GET /admin/coins/ad-earnings — which users watched ads and how much they earned
  app.get(
    "/coins/ad-earnings",
    {
      schema: {
        querystring: z.object({
          userId: z.string().optional(),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        }),
      },
    },
    async (request) => {
      const { userId, page, limit } = request.query as {
        userId?: string;
        page: number;
        limit: number;
      };
      const skip = (page - 1) * limit;

      const where = {
        type: CoinTransactionType.CREDIT,
        source: TransactionSource.AD,
        ...(userId ? { userId } : {}),
      };

      // Group by userId to get per-user stats
      const groups = await prisma.coinTransaction.groupBy({
        by: ["userId"],
        where,
        _count: { id: true },
        _sum: { amount: true },
        orderBy: { _sum: { amount: "desc" } },
        skip,
        take: limit,
      });

      const total = await prisma.coinTransaction.groupBy({
        by: ["userId"],
        where,
      }).then((r) => r.length);

      const userIds = groups.map((g) => g.userId);
      const userMap = userIds.length ? await fetchUserDetails(userIds) : new Map();

      const data = groups.map((g) => {
        const user = userMap.get(g.userId);
        return {
          userId: g.userId,
          user: user
            ? { name: user.name, email: user.email, phoneNumber: user.phoneNumber }
            : null,
          adsWatched: g._count.id,
          coinsEarned: g._sum.amount ?? 0,
        };
      });

      return {
        success: true,
        data,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
  );

  // GET /admin/subscriptions/trial-leaked
  // Identify users with a free ACTIVE subscription: was originally a trial but got
  // auto-activated to ACTIVE by the renewal webhook without a real payment going through.
  //
  // How we know they didn't pay:
  //   - Renewal webhook creates a Transaction with amountPaise = payload.payment.entity.amount || 0
  //   - If no real payment was captured, amountPaise = 0
  //   - Legitimate trial→paid transitions have a renewal Transaction with amountPaise > 0
  //   - Group B (no real payment) have NO renewal transaction with amountPaise > 0
  app.get("/subscriptions/trial-leaked", async (request, reply) => {
    // Step 1: all ACTIVE subs that were originally trials
    const candidates = await prisma.userSubscription.findMany({
      where: {
        status: "ACTIVE",
        transaction: { trialPlanId: { not: null } },
      },
      include: {
        transaction: { select: { id: true, amountPaise: true } },
        plan: { select: { name: true, pricePaise: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Step 2: keep only those with no successful paid renewal transaction
    const leaked = [];
    for (const sub of candidates) {
      if (!sub.razorpayOrderId) continue;
      const paidRenewal = await prisma.transaction.findFirst({
        where: {
          subscriptionId: sub.razorpayOrderId,
          trialPlanId: null,
          amountPaise: { gt: 0 },
          status: "SUCCESS",
        },
        select: { id: true },
      });
      if (!paidRenewal) {
        leaked.push(sub);
      }
    }

    return {
      success: true,
      count: leaked.length,
      data: leaked.map((s) => ({
        subscriptionId: s.id,
        userId: s.userId,
        planName: s.plan?.name,
        planPricePaise: s.plan?.pricePaise,
        endsAt: s.endsAt,
        createdAt: s.createdAt,
        originalTrialTransactionId: s.transaction?.id,
      })),
    };
  });

  // POST /admin/subscriptions/trial-leaked/revoke
  // Revoke confirmed trial-leaked subscriptions (set EXPIRED, endsAt = now).
  // Always run with { dryRun: true } first to review, then { dryRun: false } to execute.
  app.post(
    "/subscriptions/trial-leaked/revoke",
    { schema: { body: z.object({ dryRun: z.boolean().default(true) }) } },
    async (request, reply) => {
      const { dryRun } = request.body as { dryRun: boolean };
      const { invalidateEntitlementCache } = await import("../../lib/redis");

      const candidates = await prisma.userSubscription.findMany({
        where: {
          status: "ACTIVE",
          transaction: { trialPlanId: { not: null } },
        },
        select: { id: true, userId: true, razorpayOrderId: true },
      });

      // Only revoke those with no real paid renewal
      const leaked: { id: string; userId: string }[] = [];
      for (const sub of candidates) {
        if (!sub.razorpayOrderId) continue;
        const paidRenewal = await prisma.transaction.findFirst({
          where: {
            subscriptionId: sub.razorpayOrderId,
            trialPlanId: null,
            amountPaise: { gt: 0 },
            status: "SUCCESS",
          },
          select: { id: true },
        });
        if (!paidRenewal) leaked.push(sub);
      }

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          wouldRevoke: leaked.length,
          userIds: leaked.map((s) => s.userId),
        };
      }

      const now = new Date();
      await prisma.userSubscription.updateMany({
        where: { id: { in: leaked.map((s) => s.id) } },
        data: { status: "EXPIRED", endsAt: now },
      });

      await Promise.allSettled(leaked.map((s) => invalidateEntitlementCache(s.userId)));

      return {
        success: true,
        dryRun: false,
        revoked: leaked.length,
        userIds: leaked.map((s) => s.userId),
      };
    }
  );

  // ── Streak Admin Routes ───────────────────────────────────────────────────────

  // GET /admin/streak/config
  app.get("/streak/config", async () => {
    const config = await streakService.getOrCreateConfig();
    const milestones = await streakService.getMilestonesForVersion(config.version);
    return { success: true, data: { config, milestones } };
  });

  // GET /admin/streak/milestones
  app.get("/streak/milestones", async () => {
    const config = await streakService.getOrCreateConfig();
    const milestones = await streakService.getMilestonesForVersion(config.version);
    return { success: true, data: milestones };
  });

  // PATCH /admin/streak/config
  app.patch(
    "/streak/config",
    {
      schema: {
        body: z.object({
          isEnabled: z.boolean().optional(),
          coinsPerDay: z.number().int().positive().optional(),
          coinExpiryHours: z.number().int().positive().nullable().optional(),
        }),
      },
    },
    async (request) => {
      const adminId = request.headers["x-admin-id"] as string | undefined ?? "unknown";
      const body = request.body as { isEnabled?: boolean; coinsPerDay?: number; coinExpiryHours?: number | null };
      const config = await streakService.updateConfig(body, adminId);
      return { success: true, data: config };
    }
  );

  // POST /admin/streak/milestones
  app.post(
    "/streak/milestones",
    {
      schema: {
        body: z.object({
          dayNumber: z.number().int().min(1).max(30),
          bonusCoins: z.number().int().positive(),
          bonusExpiryHours: z.number().int().positive().nullable().optional(),
        }),
      },
    },
    async (request) => {
      const body = request.body as { dayNumber: number; bonusCoins: number; bonusExpiryHours?: number | null };
      const milestone = await streakService.createMilestone(body);
      return { success: true, data: milestone };
    }
  );

  // PUT /admin/streak/milestones/:id
  app.put(
    "/streak/milestones/:id",
    {
      schema: {
        body: z.object({
          dayNumber: z.number().int().min(1).max(30).optional(),
          bonusCoins: z.number().int().positive().optional(),
          bonusExpiryHours: z.number().int().positive().nullable().optional(),
          isEnabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { dayNumber?: number; bonusCoins?: number; bonusExpiryHours?: number | null; isEnabled?: boolean };
      try {
        const milestone = await streakService.updateMilestone(id, body);
        return { success: true, data: milestone };
      } catch (err: any) {
        if (err.code === "NOT_FOUND") return reply.code(404).send({ error: err.message });
        throw err;
      }
    }
  );

  // DELETE /admin/streak/milestones/:id
  app.delete("/streak/milestones/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await streakService.deleteMilestone(id);
      return { success: true };
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // POST /admin/streak/reset-all
  app.post(
    "/streak/reset-all",
    { schema: { body: z.object({ confirm: z.literal(true) }) } },
    async () => {
      const count = await streakService.resetAllStreaks();
      return { success: true, data: { resetCount: count } };
    }
  );

  // GET /admin/streak/analytics
  app.get("/streak/analytics", async () => {
    const analytics = await streakService.getAnalytics();
    return { success: true, data: analytics };
  });

  // GET /admin/streak/users
  app.get(
    "/streak/users",
    {
      schema: {
        querystring: z.object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
          status: z.enum(["ACTIVE", "BROKEN"]).optional(),
          currentDay: z.coerce.number().int().min(1).max(30).optional(),
          cyclesCompleted: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request) => {
      const { page, limit, status, currentDay, cyclesCompleted } = request.query as {
        page: number; limit: number; status?: StreakStatus; currentDay?: number; cyclesCompleted?: number;
      };
      const result = await streakService.getUserStreaks(page, limit, { status, currentDay, cyclesCompleted });

      // Enrich with user details from UserService
      const userIds = result.streaks.map((s) => s.userId);
      const userMap = await fetchUserDetails(userIds);

      const enrichedStreaks = result.streaks.map((s) => ({
        ...s,
        user: userMap.get(s.userId) || null,
      }));

      return {
        success: true,
        data: {
          ...result,
          streaks: enrichedStreaks,
        },
      };
    }
  );

  // GET /admin/streak/users/:userId
  app.get("/streak/users/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const detail = await streakService.getUserStreakDetail(userId);
    if (!detail.streak) return reply.code(404).send({ error: "No streak found for this user" });

    const userMap = await fetchUserDetails([userId]);
    const user = userMap.get(userId) || null;

    return { success: true, data: { ...detail, user } };
  });

  // ── At-Risk Subscribers ───────────────────────────────────────────────────

  const notificationClient = new NotificationClient();

  const atRiskQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    riskLevel: z.enum(["all", "critical", "high", "medium", "low"]).default("all"),
  });

  // GET /admin/at-risk — two lists: expiring (CANCELED, risk by daysRemaining) + inactive (ACTIVE, risk by daysSinceActive)
  app.get("/at-risk", { schema: { querystring: atRiskQuerySchema } }, async (request) => {
    const { page, limit, riskLevel } = request.query as z.infer<typeof atRiskQuerySchema>;
    const config = loadConfig();
    const now = new Date();

    // 1. Fetch CANCELED (expiring) and ACTIVE subscriptions in parallel
    const [allExpiring, allActive] = await Promise.all([
      prisma.userSubscription.findMany({
        where: { status: "CANCELED", endsAt: { gt: now } },
        include: { plan: true, trialPlan: true },
        orderBy: { endsAt: "asc" },
      }),
      prisma.userSubscription.findMany({
        where: { status: "ACTIVE", endsAt: { gt: now } },
        include: { plan: true, trialPlan: true },
        orderBy: { endsAt: "asc" },
      }),
    ]);

    // 2. Deduplicate by userId — keep earliest endsAt per user
    const dedup = <T extends { userId: string }>(items: T[]): T[] => {
      const seen = new Set<string>();
      return items.filter(i => { if (seen.has(i.userId)) return false; seen.add(i.userId); return true; });
    };
    const uniqueExpiring = dedup(allExpiring);
    const uniqueActive = dedup(allActive);

    // 3. Fetch activity + notif history for all user IDs combined
    const allUserIds = [...new Set([...uniqueExpiring.map(s => s.userId), ...uniqueActive.map(s => s.userId)])];

    const [activityRes, notifHistory] = await Promise.all([
      allUserIds.length > 0
        ? fetch(`${config.ENGAGEMENT_SERVICE_URL}/internal/users/at-risk-activity`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(config.SERVICE_AUTH_TOKEN ? { "x-service-token": config.SERVICE_AUTH_TOKEN } : {}) },
            body: JSON.stringify({ userIds: allUserIds }),
          }).then(r => r.ok ? r.json() as Promise<{ activity: Record<string, any> }> : { activity: {} }).catch(() => ({ activity: {} }))
        : Promise.resolve({ activity: {} }),
      allUserIds.length > 0 ? notificationClient.getBulkHistory(allUserIds, "AT_RISK_CAMPAIGN") : Promise.resolve({} as Record<string, { lastSentAt: string | null; count: number }>),
    ]);

    const activityMap: Record<string, any> = (activityRes as any).activity ?? {};

    // 4. Risk functions — separate logic per list
    function getExpiryRisk(daysRemaining: number): "critical" | "high" | "medium" | "low" {
      if (daysRemaining <= 7) return "critical";
      if (daysRemaining <= 14) return "high";
      if (daysRemaining <= 21) return "medium";
      return "low";
    }

    function getInactivityRisk(daysSince: number | null): "critical" | "high" | "medium" | "low" {
      if (daysSince === null || daysSince > 14) return "critical";
      if (daysSince >= 8) return "high";
      if (daysSince >= 3) return "medium";
      return "low";
    }

    const buildItem = (sub: typeof uniqueExpiring[number], riskFn: (sub: typeof uniqueExpiring[number], activity: any) => "critical" | "high" | "medium" | "low") => {
      const activity = activityMap[sub.userId] ?? { lastActiveAt: null, daysSinceActive: null, recentWatchSeconds: 0, previousWatchSeconds: 0, watchTimeDeclinePct: 0 };
      const notif = notifHistory[sub.userId] ?? { lastSentAt: null, count: 0 };
      const daysRemaining = Math.max(0, Math.ceil((sub.endsAt!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      const isTrial = sub.trialPlanId !== null;
      return {
        subscriptionId: sub.id,
        userId: sub.userId,
        planName: sub.plan?.name ?? (isTrial ? "Trial" : "Unknown"),
        isTrial,
        endsAt: sub.endsAt,
        daysRemaining,
        riskLevel: riskFn(sub, activity),
        activity: {
          lastActiveAt: activity.lastActiveAt,
          daysSinceActive: activity.daysSinceActive,
          recentWatchSeconds: activity.recentWatchSeconds,
          previousWatchSeconds: activity.previousWatchSeconds,
          watchTimeDeclinePct: activity.watchTimeDeclinePct,
        },
        notifications: { lastSentAt: notif.lastSentAt, totalSent: notif.count },
      };
    };

    // 5. Build expiring list (risk by daysRemaining)
    const enrichedExpiring = uniqueExpiring.map(sub =>
      buildItem(sub, (s, _a) => {
        const dr = Math.max(0, Math.ceil((s.endsAt!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
        return getExpiryRisk(dr);
      })
    );

    // 6. Build inactive list (risk by daysSinceActive) — only users inactive >= 3 days
    const enrichedInactive = uniqueActive
      .map(sub => buildItem(sub, (_s, a) => getInactivityRisk(a.daysSinceActive)))
      .filter(e => e.activity.daysSinceActive === null || e.activity.daysSinceActive >= 3);

    // 7. Apply riskLevel filter to both
    const filteredExpiring = riskLevel === "all" ? enrichedExpiring : enrichedExpiring.filter(e => e.riskLevel === riskLevel);
    const filteredInactive = riskLevel === "all" ? enrichedInactive : enrichedInactive.filter(e => e.riskLevel === riskLevel);

    // 8. Paginate both lists with same page/limit
    const skip = (page - 1) * limit;
    const pageExpiring = filteredExpiring.slice(skip, skip + limit);
    const pageInactive = filteredInactive.slice(skip, skip + limit);

    // 9. Fetch user details for page items only
    const pageUserIds = [...new Set([...pageExpiring.map(e => e.userId), ...pageInactive.map(e => e.userId)])];
    const userMap = await fetchUserDetails(pageUserIds);

    const attachUser = (e: ReturnType<typeof buildItem>) => ({
      ...e,
      user: userMap.has(e.userId)
        ? { id: e.userId, name: userMap.get(e.userId)!.name, email: userMap.get(e.userId)!.email, phone: userMap.get(e.userId)!.phoneNumber }
        : { id: e.userId, name: "Unknown", email: "", phone: "" },
    });

    const makeSummary = (items: ReturnType<typeof buildItem>[]) => ({
      total: items.length,
      critical: items.filter(e => e.riskLevel === "critical").length,
      high: items.filter(e => e.riskLevel === "high").length,
      medium: items.filter(e => e.riskLevel === "medium").length,
      low: items.filter(e => e.riskLevel === "low").length,
    });

    return {
      success: true,
      data: {
        expiring: {
          summary: makeSummary(enrichedExpiring),
          items: pageExpiring.map(attachUser),
          pagination: { total: filteredExpiring.length, page, limit, totalPages: Math.ceil(filteredExpiring.length / limit) },
        },
        inactive: {
          summary: makeSummary(enrichedInactive),
          items: pageInactive.map(attachUser),
          pagination: { total: filteredInactive.length, page, limit, totalPages: Math.ceil(filteredInactive.length / limit) },
        },
      },
    };
  });

  // POST /admin/at-risk/notify — send push campaign to selected at-risk users
  app.post(
    "/at-risk/notify",
    {
      schema: {
        body: z.object({
          userIds: z.array(z.string().min(1)).min(1).max(200),
          title: z.string().min(1).max(100),
          body: z.string().min(1).max(500),
        }),
      },
    },
    async (request) => {
      const { userIds, title, body } = request.body as { userIds: string[]; title: string; body: string };

      const results = await Promise.allSettled(
        userIds.map(uid =>
          notificationClient.sendPushStrict(uid, title, body, { type: "AT_RISK_CAMPAIGN" })
        )
      );

      const sent = results.filter(r => r.status === "fulfilled").length;
      const failed = results.filter(r => r.status === "rejected").length;

      return {
        success: true,
        data: { sent, failed, total: userIds.length },
      };
    }
  );

  // ── Cohort Analysis ───────────────────────────────────────────────────────

  const cohortQuerySchema = z.object({
    weeks: z.coerce.number().int().min(1).max(52).default(12),
  });

  // GET /admin/cohorts/trials — weekly trial cohort: started, converted, cancelled, conv_rate
  app.get("/cohorts/trials", { schema: { querystring: cohortQuerySchema } }, async (request) => {
    const { weeks } = request.query as z.infer<typeof cohortQuerySchema>;

    const rows = await prisma.$queryRaw<{
      cohort_week: Date;
      started: bigint;
      converted: bigint;
      cancelled: bigint;
      conv_rate_pct: number;
    }[]>`
      WITH TrialCohorts AS (
        SELECT
          DATE_TRUNC('week', MIN("createdAt")) AS week_start,
          "userId"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NOT NULL
        GROUP BY "userId"
        HAVING DATE_TRUNC('week', MIN("createdAt")) >= NOW() - ${weeks} * INTERVAL '1 week'
      ),
      Converted AS (
        SELECT DISTINCT "userId"
        FROM "Transaction"
        WHERE "status" = 'SUCCESS'
          AND "trialPlanId" IS NULL
          AND "amountPaise" >= 9900
      ),
      StillActive AS (
        SELECT DISTINCT "userId"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NOT NULL
          AND "status" IN ('ACTIVE', 'TRIAL')
          AND "endsAt" >= NOW()
      )
      SELECT
        tc.week_start                                                                             AS cohort_week,
        COUNT(*)::bigint                                                                          AS started,
        COUNT(cv."userId")::bigint                                                                AS converted,
        COUNT(CASE WHEN cv."userId" IS NULL AND sa."userId" IS NULL THEN 1 END)::bigint          AS cancelled,
        ROUND(COUNT(cv."userId")::numeric / NULLIF(COUNT(*), 0) * 100, 1)                       AS conv_rate_pct
      FROM TrialCohorts tc
      LEFT JOIN Converted cv ON tc."userId" = cv."userId"
      LEFT JOIN StillActive sa ON tc."userId" = sa."userId"
      GROUP BY tc.week_start
      ORDER BY tc.week_start DESC
    `;

    const data = rows.map(r => ({
      cohortWeek: r.cohort_week.toISOString().split("T")[0],
      started: Number(r.started),
      converted: Number(r.converted),
      cancelled: Number(r.cancelled),
      convRatePct: Number(r.conv_rate_pct),
    }));

    return { success: true, data };
  });

  // GET /admin/cohorts/subscriptions — weekly subscription cohort: started, renewed, churned, renewal_rate
  app.get("/cohorts/subscriptions", { schema: { querystring: cohortQuerySchema } }, async (request) => {
    const { weeks } = request.query as z.infer<typeof cohortQuerySchema>;

    const rows = await prisma.$queryRaw<{
      cohort_week: Date;
      started: bigint;
      renewed: bigint;
      churned: bigint;
      renewal_rate_pct: number;
    }[]>`
      WITH SubCohorts AS (
        SELECT
          DATE_TRUNC('week', MIN(t."createdAt")) AS week_start,
          t."userId"
        FROM "Transaction" t
        WHERE t."status" = 'SUCCESS'
          AND t."trialPlanId" IS NULL
          AND t."amountPaise" >= 9900
        GROUP BY t."userId"
        HAVING DATE_TRUNC('week', MIN(t."createdAt")) >= NOW() - ${weeks} * INTERVAL '1 week'
      ),
      Renewed AS (
        SELECT sc."userId", sc.week_start
        FROM SubCohorts sc
        JOIN "Transaction" t ON sc."userId" = t."userId"
        WHERE t."status" = 'SUCCESS'
          AND t."trialPlanId" IS NULL
          AND t."amountPaise" >= 9900
          AND t."createdAt" >= sc.week_start
        GROUP BY sc."userId", sc.week_start
        HAVING COUNT(t."id") >= 2
      ),
      Churned AS (
        SELECT DISTINCT us."userId"
        FROM "UserSubscription" us
        WHERE us."trialPlanId" IS NULL
          AND us."status" IN ('EXPIRED', 'CANCELED')
          AND us."endsAt" < NOW()
      )
      SELECT
        sc.week_start                                                                           AS cohort_week,
        COUNT(DISTINCT sc."userId")::bigint                                                     AS started,
        COUNT(DISTINCT r."userId")::bigint                                                      AS renewed,
        COUNT(DISTINCT ch."userId")::bigint                                                     AS churned,
        ROUND(COUNT(DISTINCT r."userId")::numeric / NULLIF(COUNT(DISTINCT sc."userId"), 0) * 100, 1) AS renewal_rate_pct
      FROM SubCohorts sc
      LEFT JOIN Renewed r  ON sc."userId" = r."userId" AND r.week_start = sc.week_start
      LEFT JOIN Churned ch ON sc."userId" = ch."userId"
      GROUP BY sc.week_start
      ORDER BY sc.week_start DESC
    `;

    const data = rows.map(r => ({
      cohortWeek: r.cohort_week.toISOString().split("T")[0],
      started: Number(r.started),
      renewed: Number(r.renewed),
      churned: Number(r.churned),
      renewalRatePct: Number(r.renewal_rate_pct),
    }));

    return { success: true, data };
  });

  // ── PhonePe: manual notify for a specific user ──────────────────────────────
  // POST /admin/phonepe/users/:userId/notify
  // Manually fires notifyRedemption for the user's current PENDING_NOTIFY cycle
  app.post("/phonepe/users/:userId/notify", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { getPhonePe } = await import("../../lib/phonepe");

    const redemption = await prisma.phonePeRedemption.findFirst({
      where: {
        userId,
        status: "PENDING_NOTIFY",
        userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
      },
      orderBy: { cycleNumber: "asc" },
      include: { userSubscription: { select: { status: true, endsAt: true } } },
    });

    if (!redemption) {
      return reply.code(404).send({
        success: false,
        code: "NO_PENDING_NOTIFY",
        message: "No PENDING_NOTIFY redemption found for this user with an active subscription.",
      });
    }

    const expireAt = Date.now() + 72 * 60 * 60 * 1000;
    let phonePeError: string | null = null;
    let dbError: string | null = null;

    // Step 1: Call PhonePe notify
    try {
      await getPhonePe().notifyRedemption({
        userId: redemption.userId,
        merchantSubscriptionId: redemption.merchantSubscriptionId,
        merchantOrderId: redemption.merchantOrderId,
        amount: redemption.amount,
        expireAt,
      });
    } catch (err: any) {
      phonePeError = err?.message ?? String(err);
    }

    // Step 2: If PhonePe accepted, update DB — separate catch so PhonePe result is preserved
    if (!phonePeError) {
      try {
        const notifiedAt = new Date();
        await prisma.phonePeRedemption.update({
          where: { id: redemption.id },
          data: {
            status: "NOTIFIED",
            notifiedAt,
            notifyWindowEnd: new Date(notifiedAt.getTime() + 72 * 60 * 60 * 1000),
          },
        });
      } catch (err: any) {
        dbError = err?.message ?? String(err);
        // PhonePe was notified but DB update failed — cron will reconcile on next run
      }
    }

    return reply.send({
      success: !phonePeError,
      redemption: {
        id: redemption.id,
        cycleNumber: redemption.cycleNumber,
        amountRupees: redemption.amount / 100,
        merchantOrderId: redemption.merchantOrderId,
        merchantSubscriptionId: redemption.merchantSubscriptionId,
        subscriptionStatus: redemption.userSubscription?.status,
      },
      requestSentToPhonePe: {
        merchantOrderId: redemption.merchantOrderId,
        amount: redemption.amount,
        expireAt,
        redemptionRetryStrategy: "STANDARD",
        paymentFlow: {
          type: "SUBSCRIPTION_CHECKOUT_REDEMPTION",
          merchantSubscriptionId: redemption.merchantSubscriptionId,
          redemptionRetryStrategy: "STANDARD",
          autoDebit: true,
        },
      },
      result: phonePeError ? "phonepe_failed" : dbError ? "notified_db_update_failed" : "notified",
      phonePeError,
      dbError,
    });
  });

  // ── PhonePe Cron Health Dashboard ───────────────────────────────────────────
  // GET /admin/phonepe/cron-health
  // Single read-only view: pipeline state, upcoming fires, overdue, at-risk, stuck
  app.get("/phonepe/cron-health", async (_request, reply) => {
    const now = new Date();
    const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const staleThreshold = new Date(now.getTime() - 10 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      // Pipeline counts by status
      pipeline,

      // Overdue — should have been notified but haven't (cron missed or down)
      overdue,

      // Upcoming in next 7 days — scheduled but not yet due
      upcoming,

      // At-risk — NOTIFIED rows whose 72h window closes in < 4h
      atRisk,

      // Stuck executing — execute sent >10 min ago, no webhook yet
      stuckExecuting,

      // Recent failures (last 7 days)
      recentFailed,

      // Last 7 days billing summary
      last7dSuccess,
      last7dFailed,

      // Next scheduled notify across all users
      nextFire,
    ] = await Promise.all([
      // Pipeline
      prisma.phonePeRedemption.groupBy({
        by: ["status"],
        _count: { id: true },
      }),

      // Overdue PENDING_NOTIFY
      prisma.phonePeRedemption.findMany({
        where: {
          status: "PENDING_NOTIFY",
          scheduledNotifyAt: { lt: now },
          userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
        },
        orderBy: { scheduledNotifyAt: "asc" },
        take: 20,
        select: {
          id: true,
          userId: true,
          merchantSubscriptionId: true,
          amount: true,
          cycleNumber: true,
          scheduledNotifyAt: true,
          userSubscription: { select: { status: true, endsAt: true } },
        },
      }),

      // Upcoming next 7 days
      prisma.phonePeRedemption.findMany({
        where: {
          status: "PENDING_NOTIFY",
          scheduledNotifyAt: { gte: now, lte: in7d },
          userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
        },
        orderBy: { scheduledNotifyAt: "asc" },
        take: 50,
        select: {
          id: true,
          userId: true,
          merchantSubscriptionId: true,
          amount: true,
          cycleNumber: true,
          isTrialCycle: true,
          scheduledNotifyAt: true,
          userSubscription: { select: { status: true, endsAt: true } },
        },
      }),

      // At-risk (window closing < 4h)
      prisma.phonePeRedemption.findMany({
        where: {
          status: "NOTIFIED",
          notifyWindowEnd: { gt: now, lte: in4h },
        },
        orderBy: { notifyWindowEnd: "asc" },
        take: 20,
        select: {
          id: true,
          userId: true,
          merchantSubscriptionId: true,
          amount: true,
          cycleNumber: true,
          notifiedAt: true,
          notifyWindowEnd: true,
          executeAttempts: true,
          lastError: true,
        },
      }),

      // Stuck executing
      prisma.phonePeRedemption.findMany({
        where: {
          status: "EXECUTING",
          updatedAt: { lt: staleThreshold },
        },
        orderBy: { updatedAt: "asc" },
        take: 20,
        select: {
          id: true,
          userId: true,
          merchantOrderId: true,
          amount: true,
          cycleNumber: true,
          updatedAt: true,
          notifyWindowEnd: true,
          lastStatusCheckedAt: true,
        },
      }),

      // Recent failures
      prisma.phonePeRedemption.findMany({
        where: {
          status: "FAILED",
          updatedAt: { gte: last7d },
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: {
          id: true,
          userId: true,
          merchantSubscriptionId: true,
          amount: true,
          cycleNumber: true,
          lastError: true,
          executeAttempts: true,
          updatedAt: true,
        },
      }),

      // Last 7d success count
      prisma.phonePeRedemption.count({
        where: { status: "SUCCESS", updatedAt: { gte: last7d } },
      }),

      // Last 7d failed count
      prisma.phonePeRedemption.count({
        where: { status: "FAILED", updatedAt: { gte: last7d } },
      }),

      // Next fire — earliest upcoming PENDING_NOTIFY
      prisma.phonePeRedemption.findFirst({
        where: {
          status: "PENDING_NOTIFY",
          scheduledNotifyAt: { gte: now },
          userSubscription: { status: { in: ["ACTIVE", "TRIAL"] } },
        },
        orderBy: { scheduledNotifyAt: "asc" },
        select: { scheduledNotifyAt: true, userId: true, amount: true },
      }),
    ]);

    const pipelineMap = Object.fromEntries(
      pipeline.map(p => [p.status, p._count.id])
    );

    const totalLast7d = last7dSuccess + last7dFailed;
    const successRateLast7d = totalLast7d > 0
      ? Math.round((last7dSuccess / totalLast7d) * 100 * 10) / 10
      : null;

    const hoursUntilNextFire = nextFire
      ? Math.round((nextFire.scheduledNotifyAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10
      : null;

    return reply.send({
      success: true,
      asOf: now.toISOString(),
      data: {
        cronInfo: {
          billingCronInterval: "every 15 minutes",
          reconciliationCronInterval: "every 15 minutes",
          expiryCronInterval: "every 1 hour",
          nextScheduledNotifyAt: nextFire?.scheduledNotifyAt ?? null,
          hoursUntilNextFire,
          nextFireAmountRupees: nextFire ? nextFire.amount / 100 : null,
        },

        pipeline: {
          pendingNotify: pipelineMap["PENDING_NOTIFY"] ?? 0,
          notified: pipelineMap["NOTIFIED"] ?? 0,
          executing: pipelineMap["EXECUTING"] ?? 0,
          success: pipelineMap["SUCCESS"] ?? 0,
          failed: pipelineMap["FAILED"] ?? 0,
        },

        alerts: {
          overdueCount: overdue.length,
          atRiskCount: atRisk.length,
          stuckExecutingCount: stuckExecuting.length,
          overdue: overdue.map(r => ({
            id: r.id,
            userId: r.userId,
            amountRupees: r.amount / 100,
            cycleNumber: r.cycleNumber,
            scheduledNotifyAt: r.scheduledNotifyAt,
            hoursOverdue: Math.round((now.getTime() - r.scheduledNotifyAt.getTime()) / (1000 * 60 * 60) * 10) / 10,
            subscriptionStatus: r.userSubscription?.status,
            endsAt: r.userSubscription?.endsAt,
          })),
          atRisk: atRisk.map(r => ({
            id: r.id,
            userId: r.userId,
            amountRupees: r.amount / 100,
            cycleNumber: r.cycleNumber,
            notifiedAt: r.notifiedAt,
            windowClosesAt: r.notifyWindowEnd,
            hoursLeft: r.notifyWindowEnd
              ? Math.round((r.notifyWindowEnd.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10
              : null,
            executeAttempts: r.executeAttempts,
            lastError: r.lastError,
          })),
          stuckExecuting: stuckExecuting.map(r => ({
            id: r.id,
            userId: r.userId,
            merchantOrderId: r.merchantOrderId,
            amountRupees: r.amount / 100,
            stuckSinceMinutes: Math.round((now.getTime() - r.updatedAt.getTime()) / (1000 * 60)),
            windowClosesAt: r.notifyWindowEnd,
            lastCheckedAt: r.lastStatusCheckedAt,
          })),
        },

        upcoming7Days: upcoming.map(r => ({
          id: r.id,
          userId: r.userId,
          amountRupees: r.amount / 100,
          cycleNumber: r.cycleNumber,
          isTrialCycle: r.isTrialCycle,
          firesAt: r.scheduledNotifyAt,
          hoursFromNow: Math.round((r.scheduledNotifyAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10,
          subscriptionEndsAt: r.userSubscription?.endsAt,
        })),

        last7Days: {
          successCount: last7dSuccess,
          failedCount: last7dFailed,
          successRatePct: successRateLast7d,
          recentFailures: recentFailed.map(r => ({
            id: r.id,
            userId: r.userId,
            amountRupees: r.amount / 100,
            cycleNumber: r.cycleNumber,
            lastError: r.lastError,
            executeAttempts: r.executeAttempts,
            failedAt: r.updatedAt,
          })),
        },
      },
    });
  });

  // ── Per-user unified cron status ────────────────────────────────────────────
  // GET /admin/users/:userId/cron-status
  // Shows every scheduled/fired cron that affects this user:
  //   1. Subscription expiry cron (1h)
  //   2. PhonePe billing cron (15min) — cycles as execution log
  //   3. At-risk reminder cron (EXPIRY_7D/3D/1D, INACTIVE)
  //   4. Coin expiry reminder cron (30min)
  //   5. Streak reminder cron (30min)
  app.get("/users/:userId/cron-status", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const now = new Date();
    const notificationClient = new NotificationClient();

    const [subscription, phonePeCycles, expiringCoins, streak] = await Promise.all([
      prisma.userSubscription.findFirst({
        where: { userId, status: { in: ["ACTIVE", "TRIAL", "CANCELED", "PAUSED"] }, endsAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        include: {
          plan: { select: { name: true, durationDays: true } },
          trialPlan: { select: { durationDays: true } },
        },
      }),
      prisma.phonePeRedemption.findMany({
        where: { userId },
        orderBy: { cycleNumber: "asc" },
      }),
      prisma.coinTransaction.findMany({
        where: { userId, remainingAmount: { gt: 0 }, expiryAt: { not: null, gt: now } },
        orderBy: { expiryAt: "asc" },
        take: 10,
        select: { id: true, remainingAmount: true, expiryAt: true, source: true, reminderSentAt: true },
      }).catch(() => [] as any[]),
      prisma.userStreak.findUnique({
        where: { userId },
        select: { status: true, currentDay: true, lastClaimedAt: true, streakReminderSentAt: true, cyclesCompleted: true },
      }).catch(() => null),
    ]);

    // ── 1. Subscription expiry cron ───────────────────────────────────────────
    const hoursUntilExpiry = subscription
      ? Math.round((subscription.endsAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10
      : null;

    const expiryCron = {
      name: "Subscription Expiry",
      interval: "every 1 hour",
      applicable: !!subscription,
      willMarkExpiredAt: subscription?.endsAt ?? null,
      hoursUntilExpiry,
      status: !subscription ? "not_applicable"
        : hoursUntilExpiry! <= 0 ? "overdue"
        : "pending",
    };

    // ── 2. PhonePe billing cron ───────────────────────────────────────────────
    const billingCron = {
      name: "PhonePe Billing",
      interval: "every 15 minutes",
      applicable: phonePeCycles.length > 0,
      cycles: phonePeCycles.map(c => {
        const isOverdue = c.status === "PENDING_NOTIFY" && c.scheduledNotifyAt < now;
        const hoursUntilFire = c.status === "PENDING_NOTIFY" && c.scheduledNotifyAt >= now
          ? Math.round((c.scheduledNotifyAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10
          : null;

        const timeline: { at: string; event: string }[] = [
          { at: c.createdAt.toISOString(), event: `Scheduled — notify due at ${c.scheduledNotifyAt.toISOString()}` },
        ];
        if (c.notifiedAt) timeline.push({ at: c.notifiedAt.toISOString(), event: "Cron: notify sent to PhonePe" });
        if (c.executeAttempts > 0) timeline.push({ at: c.updatedAt.toISOString(), event: `Cron: execute attempted ${c.executeAttempts} time(s)${c.lastError ? ` — error: ${c.lastError}` : ""}` });
        if (c.lastStatusCheckedAt) timeline.push({ at: c.lastStatusCheckedAt.toISOString(), event: "Reconciliation cron: status checked" });
        if (c.status === "SUCCESS") timeline.push({ at: c.updatedAt.toISOString(), event: "Payment confirmed — subscription extended" });
        if (c.status === "FAILED") timeline.push({ at: c.updatedAt.toISOString(), event: `Permanently failed — ${c.lastError ?? "unknown"}` });

        return {
          cycleNumber: c.cycleNumber,
          isTrialCycle: c.isTrialCycle,
          amountRupees: c.amount / 100,
          status: c.status,
          isOverdue,
          scheduledNotifyAt: c.scheduledNotifyAt,
          hoursUntilFire,
          notifiedAt: c.notifiedAt ?? null,
          notifyWindowEnd: c.notifyWindowEnd ?? null,
          executeAttempts: c.executeAttempts,
          lastError: c.lastError ?? null,
          timeline,
        };
      }),
    };

    // ── 3. At-risk reminder cron ──────────────────────────────────────────────
    const reminderDefs = [
      { key: "EXPIRY_7D", days: 7, desc: "Push 7 days before subscription ends (CANCELED users only)" },
      { key: "EXPIRY_3D", days: 3, desc: "Push 3 days before subscription ends" },
      { key: "EXPIRY_1D", days: 1, desc: "Push 1 day before subscription ends" },
      { key: "INACTIVE_7D", days: null, desc: "Push if no watch activity for 7 days" },
      { key: "INACTIVE_14D", days: null, desc: "Push if no watch activity for 14 days" },
    ];

    let notifHistory: Record<string, { lastSentAt: string | null; count: number }> = {};
    try {
      const results = await Promise.all(
        reminderDefs.map(r => notificationClient.getBulkHistory([userId], r.key).then(h => ({ key: r.key, data: h[userId] ?? null })))
      );
      for (const { key, data } of results) notifHistory[key] = data ?? { lastSentAt: null, count: 0 };
    } catch { /* NotificationService unavailable — history shown as unknown */ }

    const atRiskCron = {
      name: "At-Risk Reminder",
      interval: "runs on trigger windows (continuous)",
      applicable: !!subscription,
      reminders: reminderDefs.map(r => {
        const scheduledAt = (subscription && r.days !== null)
          ? new Date(subscription.endsAt.getTime() - r.days * 24 * 60 * 60 * 1000)
          : null;
        const history = notifHistory[r.key];
        const sentAt = history?.lastSentAt ?? null;
        const shouldHaveFired = scheduledAt ? scheduledAt <= now : false;
        return {
          key: r.key,
          description: r.desc,
          scheduledAt,
          sentAt,
          sentCount: history?.count ?? 0,
          status: sentAt ? "sent"
            : shouldHaveFired ? "overdue"
            : scheduledAt ? "pending"
            : "not_applicable",
        };
      }),
    };

    // ── 4. Coin expiry reminder cron ──────────────────────────────────────────
    const COIN_REMINDER_HOURS = 6;
    const coinReminderCron = {
      name: "Coin Expiry Reminder",
      interval: "every 30 minutes — reminds 6h before coin expiry",
      applicable: expiringCoins.length > 0,
      coins: (expiringCoins as any[]).map(c => {
        const expiresAt = new Date(c.expiryAt);
        const reminderDueAt = new Date(expiresAt.getTime() - COIN_REMINDER_HOURS * 60 * 60 * 1000);
        const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10;
        return {
          coinTransactionId: c.id,
          coins: c.remainingAmount,
          source: c.source,
          expiresAt: c.expiryAt,
          hoursLeft,
          reminderDueAt,
          reminderSentAt: c.reminderSentAt ?? null,
          status: c.reminderSentAt ? "sent"
            : reminderDueAt <= now ? "due_now"
            : "pending",
        };
      }),
    };

    // ── 5. Streak reminder cron ───────────────────────────────────────────────
    const STREAK_BREAK_HOURS = 48;
    const STREAK_REMINDER_HOURS = 42;
    let streakCron: Record<string, any> = { name: "Streak Reminder", interval: "every 30 minutes", applicable: false };

    if (streak) {
      const breakAt = streak.lastClaimedAt
        ? new Date(streak.lastClaimedAt.getTime() + STREAK_BREAK_HOURS * 60 * 60 * 1000)
        : null;
      const reminderDueAt = streak.lastClaimedAt
        ? new Date(streak.lastClaimedAt.getTime() + STREAK_REMINDER_HOURS * 60 * 60 * 1000)
        : null;
      const hoursUntilBreak = breakAt
        ? Math.round((breakAt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10
        : null;

      streakCron = {
        name: "Streak Reminder",
        interval: "every 30 minutes — reminds 6h before 48h break",
        applicable: true,
        streakStatus: streak.status,
        currentDay: streak.currentDay,
        cyclesCompleted: streak.cyclesCompleted,
        lastClaimedAt: streak.lastClaimedAt ?? null,
        streakBreaksAt: breakAt,
        hoursUntilBreak,
        reminderDueAt,
        reminderSentAt: streak.streakReminderSentAt ?? null,
        status: streak.status === "BROKEN" ? "streak_broken"
          : !streak.lastClaimedAt ? "never_claimed"
          : streak.streakReminderSentAt ? "reminder_sent"
          : reminderDueAt && reminderDueAt <= now ? "reminder_due_now"
          : "pending",
      };
    }

    return reply.send({
      success: true,
      asOf: now.toISOString(),
      userId,
      data: {
        subscription: subscription ? {
          id: subscription.id,
          status: subscription.status,
          provider: subscription.provider,
          isTrial: !!subscription.trialPlanId,
          plan: subscription.plan?.name ?? null,
          startsAt: subscription.startsAt,
          endsAt: subscription.endsAt,
        } : null,

        crons: {
          subscriptionExpiry: expiryCron,
          phonePeBilling: billingCron,
          atRiskReminders: atRiskCron,
          coinExpiryReminder: coinReminderCron,
          streakReminder: streakCron,
        },
      },
    });
  });
}
