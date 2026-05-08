import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { getPrisma } from "../../lib/prisma";
import { getRazorpay } from "../../lib/razorpay";
import { fetchUserDetails } from "../../services/userService";
import { CoinService } from "../../services/coinService";
import { ContentClient } from "../../clients/content-client";
import { CoinTransactionType, TransactionSource, WalletStatus } from "@prisma/client";
import { getRedis } from "../../lib/redis";

const coinService = new CoinService();
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
      const [revenueAgg, trialUsers, totalSubscribers] = await Promise.all([
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
            endsAt: { gt: new Date() }
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
    search: emptyToUndefined.optional(),
    startDate: emptyToUndefined.optional(),
    endDate: emptyToUndefined.optional(),
  });

  app.get(
    "/all-transactions",
    { schema: { querystring: allTxQuerySchema } },
    async (request) => {
      const { page, limit, type, status, search, startDate, endDate } = request.query as z.infer<typeof allTxQuerySchema>;
      const skip = (page - 1) * limit;

      // Date range — start of startDate day to end of endDate day
      const dateFilter = (startDate || endDate) ? {
        gte: startDate ? new Date(`${startDate}T00:00:00.000Z`) : undefined,
        lte: endDate  ? new Date(`${endDate}T23:59:59.999Z`)   : undefined,
      } : undefined;

      // 1. Build DB-level filters for each table
      const subWhere: any = {};
      if (status && ["SUCCESS", "PENDING", "FAILED"].includes(status)) subWhere.status = status;
      if (search) subWhere.userId = { contains: search };
      if (dateFilter) subWhere.updatedAt = dateFilter;

      const coinWhere: any = {};
      if (status && ["SUCCESS", "CREATED", "FAILED"].includes(status)) coinWhere.status = status;
      if (search) coinWhere.userId = { contains: search };
      if (dateFilter) coinWhere.updatedAt = dateFilter;

      // Stats only change by date range — search is a per-user lookup, not a global stat
      const statsBase = {
        ...(dateFilter ? { updatedAt: dateFilter } : {}),
      };

      // 2. Fetch page data, counts, and stats all in parallel
      const [subCount, coinCount, subTxs, coinTxs, subStats, coinStats] = await Promise.all([
        type === "coin_purchase" ? Promise.resolve(0) : prisma.transaction.count({ where: subWhere }),
        type === "subscription"  ? Promise.resolve(0) : prisma.userCoinPurchase.count({ where: coinWhere }),
        type === "coin_purchase" ? Promise.resolve([]) : prisma.transaction.findMany({
          where: subWhere,
          include: {
            plan:      { select: { name: true, durationDays: true, currency: true } },
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

      const subSuccessRevenue  = subByStatus["SUCCESS"]?.revenuePaise  ?? 0;
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
          SUCCESS:  (subByStatus["SUCCESS"]?.count  ?? 0) + (coinByStatus["SUCCESS"]?.count  ?? 0),
          PENDING:  (subByStatus["PENDING"]?.count  ?? 0) + (coinByStatus["PENDING"]?.count  ?? 0),
          FAILED:   (subByStatus["FAILED"]?.count   ?? 0) + (coinByStatus["FAILED"]?.count   ?? 0),
          CREATED:  coinByStatus["CREATED"]?.count  ?? 0,
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
      const { promoVideoUrl } = request.body;
      const config = await (prisma as any).subscriptionGlobalConfig.upsert({
        where: { id: 1 },
        update: { promoVideoUrl },
        create: { id: 1, promoVideoUrl }
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
          isEnabled:   z.boolean().optional(),
          coinsPerAd:  z.number().int().positive().optional(),
          dailyLimit:  z.number().int().positive().optional(),
          expiryHours: z.number().int().positive().nullable().optional(),
        }),
      },
    },
    async (request) => {
      const adminId = request.headers["x-admin-id"] as string | undefined;
      const body = request.body as {
        isEnabled?:   boolean;
        coinsPerAd?:  number;
        dailyLimit?:  number;
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
          page:   z.coerce.number().int().positive().default(1),
          limit:  z.coerce.number().int().positive().max(100).default(20),
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
        type:   CoinTransactionType.CREDIT,
        source: TransactionSource.AD,
        ...(userId ? { userId } : {}),
      };

      // Group by userId to get per-user stats
      const groups = await prisma.coinTransaction.groupBy({
        by: ["userId"],
        where,
        _count: { id: true },
        _sum:   { amount: true },
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
          userId:       g.userId,
          user: user
            ? { name: user.name, email: user.email, phoneNumber: user.phoneNumber }
            : null,
          adsWatched:   g._count.id,
          coinsEarned:  g._sum.amount ?? 0,
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
}
