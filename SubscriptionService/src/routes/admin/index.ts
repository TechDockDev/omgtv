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

    const [total, data] = await Promise.all([
      prisma.userCoinPurchase.count(),
      prisma.userCoinPurchase.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

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
          type: z.enum(["coin_buy", "coin_spend"]).optional(),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        }),
      },
    },
    async (request) => {
      const { userId } = request.params;
      const { type, page, limit } = request.query as {
        type?: "coin_buy" | "coin_spend";
        page: number;
        limit: number;
      };
      const skip = (page - 1) * limit;

      const typeWhere =
        type === "coin_buy"
          ? { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE }
          : type === "coin_spend"
            ? { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK }
            : {
              OR: [
                { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE },
                { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK },
              ],
            };

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

      const buyTxs = txs.filter(
        (tx) => tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE
      );
      const orderIds = buyTxs.map((tx) => tx.referenceId).filter(Boolean) as string[];

      const [purchases, episodeDetails] = await Promise.all([
        orderIds.length
          ? prisma.userCoinPurchase.findMany({ where: { orderId: { in: orderIds } } })
          : Promise.resolve([]),
        (async () => {
          const spendTxs = txs.filter(
            (tx) => tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK
          );
          const episodeIds = spendTxs
            .map((tx) => tx.referenceId?.split(":")?.[2])
            .filter(Boolean) as string[];
          return episodeIds.length ? contentClient.getEpisodesBatch(episodeIds) : [];
        })(),
      ]);

      const bundleIds = [...new Set(purchases.map((p) => p.bundleId))];
      const bundles = bundleIds.length
        ? await prisma.coinBundle.findMany({ where: { id: { in: bundleIds } } })
        : [];

      const purchaseMap = new Map(purchases.map((p) => [p.orderId, p]));
      const bundleMap = new Map(bundles.map((b) => [b.id, b]));
      const episodeMap = new Map(episodeDetails.map((ep: any) => [ep.id, ep]));

      const data = txs.map((tx) => {
        const base = { id: tx.id, createdAt: tx.createdAt };
        if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE) {
          const purchase = purchaseMap.get(tx.referenceId ?? "");
          const bundle = purchase ? bundleMap.get(purchase.bundleId) : null;
          return {
            ...base,
            transactionType: "coin_buy" as const,
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
        const episodeId = tx.referenceId?.split(":")?.[2] ?? null;
        const ep = episodeId ? episodeMap.get(episodeId) : null;
        return {
          ...base,
          transactionType: "coin_spend" as const,
          coinsSpent: Math.abs(tx.amount),
          episode: ep
            ? { id: episodeId, title: ep.title, thumbnail: ep.thumbnail, seriesName: ep.seriesTitle }
            : { id: episodeId },
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

      // Fetch user details
      const userIds = [...new Set(unlocks.map((u) => u.userId))];
      const userMap = await fetchUserDetails(userIds);

      const data = unlocks.map((u) => {
        const ep = episodeMap.get(u.episodeId);
        const user = userMap.get(u.userId);
        const refId = `unlock:${u.userId}:${u.episodeId}`;
        return {
          id: u.id,
          unlockedAt: u.createdAt,
          coinsSpent: spentMap.get(refId) ?? null,
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
}
