import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { getPrisma } from "../../lib/prisma";
import { invalidateEntitlementCache, getRedis } from "../../lib/redis";
import { CoinService } from "../../services/coinService";
import { ContentClient } from "../../clients/content-client";
import { TransactionSource, CoinTransactionType } from "@prisma/client";
import { loadConfig } from "../../config";
import { getRazorpay } from "../../lib/razorpay";
const coinService = new CoinService();
const contentClient = new ContentClient();
const config = loadConfig();

const purchaseIntentSchema = z.object({
  planId: z.string().uuid(),
  deviceId: z.string().optional(),
  isTrial: z.boolean().optional(),
});

export default async function customerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get("/plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (request) => {
    const { userId } = request.query as { userId?: string };

    // Fetch global trial plan (not tied to any specific plan)
    const globalTrialPlan = await prisma.trialPlan.findFirst({
      where: { isActive: true }
    });

    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { pricePaise: 'asc' }
    });

    const config = await (prisma as any).subscriptionGlobalConfig.findFirst({
      where: { id: 1 }
    });

    const formattedPlans = plans.map(plan => {
      const durationMonths = Math.round(plan.durationDays / 30);
      const price = Math.floor(plan.pricePaise / 100);
      const pricePerMonth = durationMonths > 0 ? Math.floor(price / durationMonths) : price;

      return {
        ...plan,
        duration: `${durationMonths}_months`,
        durationLabel: `${durationMonths} Months`,
        durationMonths,
        price,
        pricePerMonth,
        promoVideoUrl: (plan as any).promoVideoUrl,
      };
    });

    return {
      success: true,
      statusCode: 200,
      userMessage: "Plans retrieved successfully",
      developerMessage: "Public plans retrieved",
      hasUsedTrial: false,
      trialPlan: globalTrialPlan ? {
        id: globalTrialPlan.id,
        trialPricePaise: globalTrialPlan.trialPricePaise,
        durationDays: globalTrialPlan.durationDays,
        isAutoDebit: globalTrialPlan.isAutoDebit,
        isEligible: true
      } : null,
      promoVideoUrl: config?.promoVideoUrl || null,
      data: formattedPlans,
    };
  });

  app.get("/trial-plans", {
    schema: { querystring: z.object({ userId: z.string().optional() }) },
  }, async (_request) => {
    const trialPlans = await prisma.trialPlan.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    const formattedTrialPlans = trialPlans.map(tp => ({
      id: tp.id,
      trialPricePaise: tp.trialPricePaise,
      durationDays: tp.durationDays,
      reminderDays: tp.reminderDays,
      isAutoDebit: tp.isAutoDebit,
      isEligible: true
    }));

    return {
      success: true,
      statusCode: 200,
      userMessage: "Trial plans retrieved successfully",
      developerMessage: "Active trial plans retrieved",
      hasUsedTrial: false,
      data: formattedTrialPlans,
    };
  });


  app.get("/me/subscription", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };

    // 1. First check for an active/trial subscription that hasn't expired
    let subscription = await prisma.userSubscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIAL", "CANCELED"] },
        endsAt: { gt: new Date() }
      },
      orderBy: { startsAt: "desc" },
      include: {
        plan: true,
        trialPlan: true
      },
    });

    // 2. If no active subscription found, check if there's an expired trial
    //    that has a Razorpay subscription which may have auto-renewed.
    //    This bridges the gap between trial end and webhook processing.
    if (!subscription) {
      const expiredTrial = await prisma.userSubscription.findFirst({
        where: {
          userId,
          trialPlanId: { not: null },
          razorpayOrderId: { not: null },
          status: { in: ["ACTIVE", "TRIAL"] },
          endsAt: { lte: new Date() } // Trial has expired
        },
        orderBy: { startsAt: "desc" },
        include: { plan: true, trialPlan: true }
      });

      if (expiredTrial && expiredTrial.razorpayOrderId) {
        // Sync with Razorpay to check if the subscription has renewed
        try {
          const { getRazorpay } = await import("../../lib/razorpay");
          const razorpay = getRazorpay();
          const rpSub = await razorpay.subscriptions.fetch(expiredTrial.razorpayOrderId);

          if (rpSub.status === 'active' && rpSub.current_end) {
            // Razorpay says subscription is active! Update our DB
            const updatedSub = await prisma.userSubscription.update({
              where: { id: expiredTrial.id },
              data: {
                status: "ACTIVE",
                trialPlanId: null, // Trial is over
                startsAt: rpSub.current_start ? new Date(rpSub.current_start * 1000) : expiredTrial.startsAt,
                endsAt: new Date(rpSub.current_end * 1000)
              },
              include: { plan: true, trialPlan: true }
            });

            request.log.info({
              msg: "Synced expired trial with Razorpay - subscription is now active",
              subId: expiredTrial.id,
              razorpayStatus: rpSub.status
            });

            subscription = updatedSub;
          }
        } catch (err) {
          request.log.error(err, "Failed to sync with Razorpay for expired trial");
        }
      }
    }


    // If user has a trial, return trial details instead of main plan
    const isTrial = subscription?.status === "TRIAL" || !!subscription?.trialPlanId;
    const data = subscription ? {
      ...subscription,
      isTrial,
      // During trial period, show trial plan information
      displayPlan: subscription.trialPlan || subscription.plan
    } : null;

    return {
      success: true,
      statusCode: 200,
      userMessage: "Subscription retrieved successfully",
      developerMessage: "User subscription details retrieved",
      hasUsedTrial: false,
      data,
    };
  });

  app.get("/me/transactions", {
    schema: { querystring: z.object({ userId: z.string() }) },
  }, async (request) => {
    const { userId } = request.query as { userId: string };
    const data = await prisma.transaction.findMany({
      where: { userId, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    // Ensure response includes subscriptionId and clear razorpayOrderId if it was misused before (though now we split them)
    // Since we added a new column, old data might still have sub_ in razorpayOrderId.
    // For new data, razorpayOrderId will be null for subscriptions.
    const formattedData = data.map(t => ({
      ...t,
      // If we have a subscriptionId in DB, use it. 
      // Fallback: If razorpayPlanId has legacy data (starts with sub_), use it
      subscriptionId: t.subscriptionId || (t.razorpayPlanId?.startsWith("sub_") ? t.razorpayPlanId : null),
      razorpayPlanId: t.razorpayPlanId,
      // razorpayOrderId is no longer available on Transaction
    }));
    return {
      success: true,
      statusCode: 200,
      userMessage: "Transactions retrieved successfully",
      developerMessage: "User transactions retrieved",
      data: formattedData,
    };
  });

  app.post("/purchase/intent", {
    schema: { body: purchaseIntentSchema },
  }, async (request, reply) => {
    const { planId, deviceId, isTrial } = request.body as z.infer<typeof purchaseIntentSchema>;
    const userId = request.headers['x-user-id'] as string;

    if (!userId) {
      return reply.code(401).send({
        success: false,
        statusCode: 401,
        code: "UNAUTHORIZED",
        userMessage: "User not authenticated",
        developerMessage: "Missing x-user-id header"
      });
    }

    let plan = await prisma.subscriptionPlan.findFirst({
      where: { id: planId, deletedAt: null }
    });
    let trialPlan: any = null;

    if (plan && isTrial) {
      // User explicitly requested a trial for this plan.
      // Fetch the universal active trial plan
      trialPlan = await prisma.trialPlan.findFirst({
        where: { isActive: true }
      });

      if (!trialPlan) {
        return reply.badRequest("No active trial available");
      }
    }

    if (trialPlan) {
      if (!trialPlan.isActive) return reply.notFound("Trial plan is inactive");
    }

    if (!plan || !plan.isActive) {
      return reply.notFound("Plan not found or inactive");
    }

    if (!plan.razorpayPlanId) {
      return reply.badRequest("Plan is not configured for online payments (missing Razorpay Plan ID)");
    }

    const { getRazorpay } = await import("../../lib/razorpay");
    const razorpay = getRazorpay();

    try {
      const subscriptionOptions: any = {
        plan_id: plan.razorpayPlanId,
        customer_notify: 1,
        total_count: 120, // Default to 10 years (120 months) for auto-renew
        quantity: 1,
        notes: {
          userId,
          planId: trialPlan ? trialPlan.id : plan.id,
          internalPlanId: plan.id, // The actual subscription plan ID
          isTrial: !!trialPlan
        }
      };

      if (trialPlan) {
        // Start the paid subscription after the trial duration
        // Current time + trial days * 24h * 60m * 60s
        const startAt = Math.floor(Date.now() / 1000) + (trialPlan.durationDays * 24 * 60 * 60);
        subscriptionOptions.start_at = startAt;

        // Provide immediate access via trial
        // If there is a trial price, we add it as an upfront charge (addon)
        if (trialPlan.trialPricePaise > 0) {
          subscriptionOptions.addons = [{
            item: {
              name: "Trial Period Charge",
              amount: trialPlan.trialPricePaise,
              currency: plan.currency
            }
          }];
        }
      }

      const subscription = await razorpay.subscriptions.create(subscriptionOptions);

      const transaction = await prisma.transaction.create({
        data: {
          userId,
          planId: plan.id, // Link to the target plan (SubscriptionPlan)
          amountPaise: trialPlan ? trialPlan.trialPricePaise : plan.pricePaise,
          currency: plan.currency,
          subscriptionId: subscription.id,
          razorpayPlanId: plan.razorpayPlanId, // Storing the Razorpay Plan ID for reference
          trialPlanId: trialPlan ? trialPlan.id : null,
          metadata: {
            deviceId,
            subscriptionId: subscription.id,
            trialPlanId: trialPlan?.id
          },
        },
      });

      return reply.code(201).send({
        success: true,
        statusCode: 201,
        userMessage: "Purchase intent created successfully",
        developerMessage: "Razorpay subscription created",
        data: {
          transactionId: transaction.id,
          subscriptionId: subscription.id,
          amountPaise: transaction.amountPaise,
          currency: transaction.currency,
          razorpayKeyId: process.env.RAZORPAY_KEY_ID
        }
      });
    } catch (error: any) {
      request.log.error(error);
      return reply.internalServerError("Failed to create subscription with payment provider");
    }
  });

  const verifyPurchaseSchema = z.object({
    paymentId: z.string(),
    subscriptionId: z.string(),
    signature: z.string(),
  });

  app.post("/purchase/verify", {
    schema: { body: verifyPurchaseSchema },
  }, async (request, reply) => {
    const { paymentId, subscriptionId, signature } = request.body as z.infer<typeof verifyPurchaseSchema>;
    const { getRazorpay } = await import("../../lib/razorpay");

    // Validate signature
    const crypto = await import("crypto");
    const config = await import("../../config").then(m => m.loadConfig());

    const expectedSignature = crypto.default
      .createHmac("sha256", config.RAZORPAY_KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest("hex");

    if (expectedSignature !== signature) {
      return reply.badRequest("Invalid signature");
    }

    // Find transaction and update
    // Check by subscriptionId first (new flow), then fallback to razorpayOrderId (old flow)
    const transaction = await prisma.transaction.findFirst({
      where: {
        OR: [
          { subscriptionId }
        ],
        status: "PENDING"
      }
    });

    if (!transaction) {
      // Check if already success?
      const existing = await prisma.transaction.findFirst({
        where: {
          OR: [
            { subscriptionId }
          ],
          status: "SUCCESS"
        }
      });
      if (existing) {
        return reply.send({ success: true, message: "Already verified" });
      }
      return reply.notFound("Transaction not found");
    }

    // Update Transaction
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: "SUCCESS",
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      }
    });

    const razorpay = getRazorpay();
    let startsAt = new Date();
    let endsAt = new Date();

    try {
      const sub = await razorpay.subscriptions.fetch(subscriptionId);
      if (sub.current_start && sub.current_end) {
        startsAt = new Date(sub.current_start * 1000);
        endsAt = new Date(sub.current_end * 1000);
      } else {
        // Fallback for trial or pending sub
        // If it's a trial, we should calculate endsAt based on trial duration
        const metadata = transaction.metadata as Record<string, any> | null;
        if (metadata?.trialPlanId) {
          const trialPlan = await prisma.trialPlan.findUnique({ where: { id: metadata.trialPlanId } });
          if (trialPlan) {
            endsAt = new Date(Date.now() + trialPlan.durationDays * 24 * 60 * 60 * 1000);
          }
        } else {
          const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
          if (plan) {
            endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
          }
        }
      }
    } catch (e) {
      request.log.error(e, "Failed to fetch subscription details");
      const metadata = transaction.metadata as Record<string, any> | null;
      if (metadata?.trialPlanId) {
        const trialPlan = await prisma.trialPlan.findUnique({ where: { id: metadata.trialPlanId } });
        if (trialPlan) {
          endsAt = new Date(Date.now() + trialPlan.durationDays * 24 * 60 * 60 * 1000);
        }
      } else {
        const plan = await prisma.subscriptionPlan.findUnique({ where: { id: transaction.planId! } });
        if (plan) {
          endsAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
        }
      }
    }

    // Extract trialPlanId from metadata or transaction
    const metadata = transaction.metadata as Record<string, any> | null;
    const trialPlanId = transaction.trialPlanId || metadata?.trialPlanId;

    await prisma.userSubscription.create({
      data: {
        userId: transaction.userId,
        planId: transaction.planId,
        trialPlanId: trialPlanId,
        status: trialPlanId ? "TRIAL" : "ACTIVE", // TRIAL status during trial period, ACTIVE for regular plans
        razorpayOrderId: subscriptionId,
        transactionId: transaction.id,
        startsAt,
        endsAt
      }
    });

    await invalidateEntitlementCache(transaction.userId);

    return reply.send({
      success: true,
      statusCode: 200,
      userMessage: "Payment verified successfully",
      developerMessage: "Payment verified and subscription activated",
      data: { status: "active" }
    });
  });

  // --- Coin Routes ---

  // GET User balance
  app.get("/coins/balance", async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }
    const balance = await coinService.getBalance(userId);
    return { balance };
  });

  // GET Unified Transaction History (coin_buy + coin_spend)
  app.get("/coins/transactions", {
    schema: {
      querystring: z.object({
        type: z.enum(["coin_buy", "coin_spend"]).optional(),
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(50).default(20),
      })
    }
  }, async (request, reply) => {
    const userId = request.headers['x-user-id'] as string;
    if (!userId) {
      return reply.code(401).send({ error: "User not authenticated" });
    }

    const { type, page, limit } = request.query as { type?: "coin_buy" | "coin_spend"; page: number; limit: number };
    const skip = (page - 1) * limit;

    const typeWhere = type === "coin_buy"
      ? { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE }
      : type === "coin_spend"
      ? { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK }
      : { OR: [
          { type: CoinTransactionType.CREDIT, source: TransactionSource.PURCHASE },
          { type: CoinTransactionType.DEBIT, source: TransactionSource.UNLOCK },
        ]};

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

    // --- Enrich coin_buy ---
    const buyTxs = txs.filter(tx => tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE);
    const orderIds = buyTxs.map(tx => tx.referenceId).filter(Boolean) as string[];

    const [purchases, episodeDetails] = await Promise.all([
      orderIds.length
        ? prisma.userCoinPurchase.findMany({ where: { orderId: { in: orderIds } } })
        : Promise.resolve([]),
      // --- Enrich coin_spend ---
      (async () => {
        const spendTxs = txs.filter(tx => tx.type === CoinTransactionType.DEBIT && tx.source === TransactionSource.UNLOCK);
        const episodeIds = spendTxs
          .map(tx => tx.referenceId?.split(":")?.[2])
          .filter(Boolean) as string[];
        return episodeIds.length ? contentClient.getEpisodesBatch(episodeIds) : [];
      })(),
    ]);

    const bundleIds = [...new Set(purchases.map(p => p.bundleId))];
    const bundles = bundleIds.length
      ? await prisma.coinBundle.findMany({ where: { id: { in: bundleIds } } })
      : [];

    const purchaseMap = new Map(purchases.map(p => [p.orderId, p]));
    const bundleMap = new Map(bundles.map(b => [b.id, b]));
    const episodeMap = new Map(episodeDetails.map((ep: any) => [ep.id, ep]));

    // --- Build enriched items ---
    const items = txs.map(tx => {
      const base = { id: tx.id, createdAt: tx.createdAt };

      if (tx.type === CoinTransactionType.CREDIT && tx.source === TransactionSource.PURCHASE) {
        const purchase = purchaseMap.get(tx.referenceId ?? "");
        const bundle = purchase ? bundleMap.get(purchase.bundleId) : null;
        return {
          ...base,
          transactionType: "coin_buy" as const,
          coins: tx.amount,
          payment: purchase ? {
            orderId: purchase.orderId,
            paymentId: purchase.paymentId,
            amountPaid: purchase.amountPaid,
            currency: bundle?.currency ?? "INR",
            status: purchase.status,
          } : null,
          bundle: bundle ? {
            title: bundle.title,
            coins: bundle.coins,
            price: bundle.price,
            currency: bundle.currency,
          } : null,
        };
      }

      // coin_spend
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

    // --- Group by today / yesterday / other ---
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    const groupItem = (item: (typeof items)[0]) => {
      const d = new Date(item.createdAt);
      if (d >= todayStart) return "today";
      if (d >= yesterdayStart) return "yesterday";
      return "other";
    };

    const today: typeof items = [];
    const yesterday: typeof items = [];
    const other: typeof items = [];
    for (const item of items) {
      const g = groupItem(item);
      if (g === "today") today.push(item);
      else if (g === "yesterday") yesterday.push(item);
      else other.push(item);
    }

    return {
      success: true,
      today,
      yesterday,
      other,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  // GET Available Bundles
  app.get("/coins/bundles", async () => {
    const redis = getRedis();
    const cacheKey = "coins:bundles:all";
    
    // Try to get from cache
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      return JSON.parse(cached);
    }

    const bundles = await prisma.coinBundle.findMany({ where: { active: true } });
    
    // Cache for 10 minutes
    await redis.setex(cacheKey, 600, JSON.stringify(bundles)).catch(() => {});
    
    return bundles;
  });

  // POST Create Coin Purchase Order
  app.post(
    "/coins/purchase/create",
    {
      schema: {
        body: z.object({ bundleId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { bundleId } = request.body as { bundleId: string };

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      try {
        await coinService.checkWalletStatus(userId);

        const bundle = await prisma.coinBundle.findFirst({
          where: { id: bundleId, active: true },
        });

        if (!bundle) {
          return reply.code(404).send({ error: "Coin bundle not found" });
        }

        const razorpay = getRazorpay();
        const amountPaise = bundle.price * 100;
        const order = await razorpay.orders.create({
          amount: amountPaise,
          currency: "INR",
          notes: { userId, bundleId, type: "COIN_PURCHASE" },
        });

        const purchase = await prisma.userCoinPurchase.create({
          data: {
            userId,
            bundleId,
            amountPaid: amountPaise,
            coins: bundle.coins,
            orderId: order.id,
            status: "CREATED",
          },
        });

        return {
          success: true,
          orderId: order.id,
          amountPaise,
          coins: bundle.coins,
          purchaseId: purchase.id,
          razorpayKeyId: config.RAZORPAY_KEY_ID,
        };
      } catch (error: any) {
        if (error.message === "Wallet is blocked. Please contact support.") {
          return reply.code(403).send({ error: error.message });
        }
        request.log.error(error, "Failed to create Razorpay order for coins");
        return reply.code(500).send({
          error: "Failed to create purchase order",
          message: error.message,
          razorpayError: error.description || error.error?.description || "Unknown provider error",
        });
      }
    }
  );

  // POST Verify Coin Purchase
  app.post(
    "/coins/purchase/verify",
    {
      schema: {
        body: z.object({
          orderId: z.string(),
          paymentId: z.string(),
          signature: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { orderId, paymentId, signature } = request.body as { orderId: string; paymentId: string; signature: string };

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      // Verify Signature
      const expectedSignature = crypto
        .createHmac("sha256", config.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      if (expectedSignature !== signature) {
        return reply.code(400).send({ error: "Invalid payment signature" });
      }

      // Update Purchase Record
      const purchase = await prisma.userCoinPurchase.findUnique({
        where: { orderId }
      });

      if (!purchase || purchase.userId !== userId) {
        return reply.code(404).send({ error: "Purchase record not found" });
      }

      if (purchase.status === "SUCCESS") {
        return { success: true, message: "Already verified", balance: await coinService.getBalance(userId) };
      }

      // Pre-check for existing coin transaction with this orderId (idempotency guard)
      const existingTx = await prisma.coinTransaction.findUnique({
        where: { referenceId: orderId }
      });

      if (existingTx) {
        // If transaction exists but purchase record was not marked SUCCESS, sync it now
        await prisma.userCoinPurchase.update({
          where: { id: purchase.id },
          data: { status: "SUCCESS", paymentId }
        });
        return { success: true, message: "Already credited", balance: await coinService.getBalance(userId) };
      }

      await prisma.$transaction(async (tx) => {
        await tx.userCoinPurchase.update({
          where: { id: purchase.id },
          data: {
            status: "SUCCESS",
            paymentId,
            metadata: { signature }
          }
        });

        // Credit the coins — pass tx so both ops are in the same DB transaction
        await coinService.creditCoins({
            userId,
            amount: purchase.coins,
            source: TransactionSource.PURCHASE,
            referenceId: orderId,
        }, tx);
      });

      return { success: true, balance: await coinService.getBalance(userId) };
    }
  );

  // POST Unlock Episode
  app.post<{ Body: { episodeId: string } }>(
    "/coins/unlock",
    {
      schema: {
        body: z.object({ episodeId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      const { episodeId } = request.body;

      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      let coinCost: number | null;
      try {
        const episode = await contentClient.getEpisodeCoinCost(episodeId);
        coinCost = episode.coinCost;
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          return reply.code(404).send({ error: "Episode not found" });
        }
        request.log.error(err, "Failed to fetch episode coin cost");
        return reply.code(502).send({ error: "Failed to fetch episode details" });
      }

      if (coinCost === null) {
        return reply.code(400).send({ error: "Episode is not available for coin unlock" });
      }

      try {
        const result = await coinService.unlockEpisode(userId, episodeId, coinCost);
        const newBalance = await coinService.getBalance(userId);
        const alreadyUnlocked = result.status === "ALREADY_UNLOCKED";
        return {
          status: result.status,
          episodeId,
          coinsSpent: alreadyUnlocked ? 0 : coinCost,
          newBalance,
          coinUnlockPurchased: true,
        };
      } catch (err: any) {
        if (err.message === "Insufficient coin balance") {
          return reply.code(402).send({ error: "Insufficient coin balance", required: coinCost });
        }
        throw err;
      }
    }
  );

  // GET Unlock History with episode details
  app.get(
    "/coins/unlocks",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(50).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.headers['x-user-id'] as string;
      if (!userId) {
        return reply.code(401).send({ error: "User not authenticated" });
      }

      const { limit, offset } = request.query as { limit: number; offset: number };

      const [unlocks, total] = await Promise.all([
        prisma.userEpisodeUnlock.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.userEpisodeUnlock.count({ where: { userId } }),
      ]);

      if (!unlocks.length) {
        return { success: true, data: [], total: 0 };
      }

      // Fetch coins spent per episode from debit transactions
      const referenceIds = unlocks.map((u) => `unlock:${userId}:${u.episodeId}`);
      const debitTxs = await prisma.coinTransaction.findMany({
        where: { referenceId: { in: referenceIds } },
        select: { referenceId: true, amount: true },
      });
      const spentMap = new Map(
        debitTxs.map((tx) => [tx.referenceId, Math.abs(tx.amount)])
      );

      // Fetch episode details from ContentService
      const episodeIds = unlocks.map((u) => u.episodeId);
      const episodeDetails = await contentClient.getEpisodesBatch(episodeIds);
      const episodeMap = new Map(episodeDetails.map((ep) => [ep.id, ep]));

      const data = unlocks.map((unlock) => {
        const ep = episodeMap.get(unlock.episodeId);
        const refId = `unlock:${userId}:${unlock.episodeId}`;
        return {
          episodeId: unlock.episodeId,
          title: ep?.title ?? null,
          thumbnail: ep?.thumbnail ?? null,
          seriesName: ep?.seriesTitle ?? null,
          coinsSpent: spentMap.get(refId) ?? null,
          unlockedAt: unlock.createdAt,
        };
      });

      return { success: true, data, total };
    }
  );
}
